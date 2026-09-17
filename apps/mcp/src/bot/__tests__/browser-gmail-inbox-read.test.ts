// Real-Chromium regression for operate_read_inbox's extraction binding.
//
// Live Proton gauntlet (1.1.14): two operate_read_inbox calls returned
// `{found: true, code: null, link: "https://accounts.google.com/SignOutOptions?..."}`
// while the six-digit code WAS in the mailbox — a claimed hit with no code and a
// link pointing at Gmail's own account menu instead of anything from the
// verification email.
//
// Root causes reproduced here against a Gmail-shaped fixture served to a real
// Chromium:
//   1. Gmail's PAGE CHROME anchors enter link scoring. The account-menu
//      SignOutOptions URL carries a `continue=` parameter (score +3), so any
//      page-wide anchor read of a Gmail page can "find" it.
//   2. When the conversation row fails to open (the live race), the fallback
//      scores those chrome links and returns found:true with a UI URL.
//   3. The attempt loop exits as soon as ANY link scores, so a chrome-only hit
//      suppresses the retries that would have read the message body.
//
// The fixture models Gmail's real shapes: div[role=link] conversation rows,
// the `.adn` message card with its `.gD` sender header and `.ii` body, and the
// account-menu/settings/support chrome anchors — served over a route-fulfilled
// navigation to mail.google.com (no real network). The session's operation page
// URL must stay on the signup page the whole time: the read runs in a dedicated
// utility tab and must never disturb the dialog waiting for the code.

import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserController } from "../browser.js";
import { awaitVerification } from "../capture/verification.js";
import { finishProvisionSession, startHarnessProvisionSession } from "../provision-session.js";

let available = false;
try {
  available = existsSync(chromium.executablePath());
} catch {
  available = false;
}

let server: Server;
let port: number;
let browser: Browser | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if ((req.url ?? "").startsWith("/signup")) {
      res.end(
        "<!doctype html><html><body><main>Proton signup — human verification code dialog open</main></body></html>",
      );
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
  if (available) {
    browser = await chromium.launch({ headless: true });
  }
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Gmail chrome anchors shared by every fixture view. The SignOutOptions URL is
// the exact link the live defect returned: +3 from its `continue=` parameter.
const GMAIL_CHROME_HTML = `
<a href="https://mail.google.com/mail/u/0/#inbox">Inbox (1,204)</a>
<a href="https://accounts.google.com/SignOutOptions?hl=en&amp;continue=https://mail.google.com/mail/u/0/">Google Account menu</a>
<a href="https://support.google.com/mail/answer/91324?hl=en&amp;continue=https://mail.google.com/mail/u/0/">Learn more about Gmail search</a>
<a href="#compose">Compose</a>
`;

// Enough visible text that the search-results read stops waiting (>200 chars).
const LIST_FILLER =
  "Search mail. Primary Social Promotions Updates. Gmail images are loading. " +
  "Try the new interface, learn what is new in Gmail and check settings. " +
  "Gmail: private and secure email at no cost, for work and life. ";

const LIST_ROW =
  '<div role="link" id="row-proton" style="cursor:pointer;padding:8px">' +
  "Proton Mail — Verify your Proton Mail address — Tap to view the code and " +
  "finish creating your new Proton Mail account. 8:04 PM</div>";

const MESSAGE_CARD = `
<div class="adn">
  <div class="gD">Proton Mail &lt;no-reply@proton.me&gt;</div>
  <div class="ii">Here is your verification code: 610228. Enter it in the
  signup window to finish creating your Proton Mail address. This code
  expires in 10 minutes. If you did not request it, ignore this email.</div>
</div>
`;

type Fixture = { rowOpensConversation: boolean; convHtml?: string };

function fixtureHandler(fixture: Fixture): (url: string) => string {
  return (_url) => {
    const swapScript = fixture.rowOpensConversation
      ? `<script>
          document.getElementById("row-proton").addEventListener("click", () => {
            document.getElementById("list").hidden = true;
            document.getElementById("conv").hidden = false;
            location.hash = "inbox/18f3c2a1b9d4e6f80217";
          });
        </script>`
      : "";
    const convBody = fixture.convHtml ?? (fixture.rowOpensConversation ? MESSAGE_CARD : "");
    return (
      `<!doctype html><html><head><title>Gmail</title></head><body>` +
      GMAIL_CHROME_HTML +
      `<div id="list" role="main">${LIST_FILLER}${LIST_ROW}</div>` +
      `<div id="conv" hidden>${convBody}</div>` +
      swapScript +
      `</body></html>`
    );
  };
}

async function harness(fixture: Fixture): Promise<{ context: BrowserContext }> {
  if (browser === undefined) throw new Error("Chromium unavailable");
  const context = await browser.newContext();
  const handler = fixtureHandler(fixture);
  await context.route("https://mail.google.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: handler(route.request().url()) }),
  );
  return { context };
}

async function readInbox(
  context: BrowserContext,
  opts: { sender?: string } = {},
): Promise<Awaited<ReturnType<typeof awaitVerification>>> {
  const harnessPage = await context.newPage();
  await harnessPage.goto(`http://127.0.0.1:${port}/signup`);
  const controller = BrowserController.fromHarnessPage(harnessPage);
  const obs = await startHarnessProvisionSession({
    browser: controller,
    serviceUrl: `http://127.0.0.1:${port}/signup`,
    consentInboxRead: true,
  });
  try {
    const result = await awaitVerification(obs.session_id, opts);
    // The signup page the dialog lives on must be untouched by the read.
    expect(harnessPage.url()).toBe(`http://127.0.0.1:${port}/signup`);
    return result;
  } finally {
    await finishProvisionSession(obs.session_id).catch(() => undefined);
  }
}

const THREAD_CARD_WITHOUT_CODE = `
<div class="adn">
  <div class="gD">Proton Mail &lt;no-reply@proton.me&gt;</div>
  <div class="ii">Still did not receive it? Wait a few minutes and try again.
  Contact Proton support if the problem persists. 8:05 PM</div>
</div>
`;

describe("operate_read_inbox extraction binds to the verification email (real Chromium)", () => {
  it.skipIf(!available)(
    "reads the code from an older message card when the newest card in the thread has none",
    async () => {
      // Gmail renders every message of an opened conversation; the code can
      // sit in an older card while the newest card carries only a reminder.
      const { context } = await harness({
        rowOpensConversation: true,
        convHtml: MESSAGE_CARD + THREAD_CARD_WITHOUT_CODE,
      });
      try {
        const res = await readInbox(context, { sender: "proton.me" });
        expect(res.found).toBe(true);
        expect(res.code).toBe("610228");
        expect(res.link).toBeNull();
        // The sender read prefers the NEWEST card's header.
        expect(res.source_from).toBe("no-reply@proton.me");
      } finally {
        await context.close();
      }
    },
    90_000,
  );

  it.skipIf(!available)(
    "breaks link score ties toward the newest card's token in a thread",
    async () => {
      // A re-sent verification mail: both cards carry the same shaped link
      // with different tokens. pickVerificationLink breaks ties to the LATER
      // link, so the NEWEST card's freshest token must win.
      const linkCard = (token: string) =>
        `<div class="adn">` +
        `<div class="gD">Proton Mail &lt;no-reply@proton.me&gt;</div>` +
        `<div class="ii">Confirm your address to finish signing up.` +
        `<a href="https://mail.proton.me/click-tracking?u=${token}">Verify address</a>` +
        `</div></div>`;
      const { context } = await harness({
        rowOpensConversation: true,
        convHtml: linkCard("old111222333") + linkCard("new444555666"),
      });
      try {
        const res = await readInbox(context, { sender: "proton.me" });
        expect(res.link).toBe("https://mail.proton.me/click-tracking?u=new444555666");
        expect(res.source_from).toBe("no-reply@proton.me");
      } finally {
        await context.close();
      }
    },
    90_000,
  );

  it.skipIf(!available)(
    "reads the code from the opened message body and returns NO link when the mail has none",
    async () => {
      const { context } = await harness({ rowOpensConversation: true });
      try {
        const res = await readInbox(context, { sender: "proton.me" });
        expect(res.found).toBe(true);
        expect(res.code).toBe("610228");
        // A code email carries no action link: the chrome SignOutOptions URL
        // must never be returned as one.
        expect(res.link).toBeNull();
        expect(res.source_from).toBe("no-reply@proton.me");
      } finally {
        await context.close();
      }
    },
    90_000,
  );

  it("returns the mail's own action link, never a Gmail UI URL", async () => {
    const { context } = await harness({ rowOpensConversation: true });
    await context.route("https://mail.google.com/**", (route) => {
      const body =
        `<!doctype html><html><head><title>Gmail</title></head><body>` +
        GMAIL_CHROME_HTML +
        `<div id="list" role="main">${LIST_FILLER}${LIST_ROW}</div>` +
        `<div id="conv" hidden>` +
        `<div class="adn">` +
        `<div class="gD">Proton Mail &lt;no-reply@proton.me&gt;</div>` +
        `<div class="ii">Confirm your address to finish signing up.` +
        `<a href="https://mail.proton.me/click-tracking?u=abc123def456">Continue setup</a>` +
        `</div></div></div>` +
        `<script>
          document.getElementById("row-proton").addEventListener("click", () => {
            document.getElementById("list").hidden = true;
            document.getElementById("conv").hidden = false;
            location.hash = "inbox/18f3c2a1b9d4e6f80217";
          });
        </script>` +
        `</body></html>`;
      void route.fulfill({ contentType: "text/html", body });
    });
    try {
      const res = await readInbox(context, { sender: "proton.me" });
      expect(res.link).toBe("https://mail.proton.me/click-tracking?u=abc123def456");
      expect(res.link).not.toContain("SignOutOptions");
      expect(res.source_from).toBe("no-reply@proton.me");
    } finally {
      await context.close();
    }
  }, 90_000);

  it("never claims found with a UI link when the message body was never reached", async () => {
    // The live race: the conversation row does not open (URL never gains a
    // message id), so only the search list and its chrome anchors are read.
    // On 1.1.14 this returned {found:true, code:null, link:SignOutOptions}.
    const { context } = await harness({ rowOpensConversation: false });
    try {
      const res = await readInbox(context, { sender: "proton.me" });
      expect(res.link).toBeNull();
      expect(res.found).toBe(false);
      expect(res.needs_user?.resume).toBe("code");
    } finally {
      await context.close();
    }
  }, 90_000);
});
