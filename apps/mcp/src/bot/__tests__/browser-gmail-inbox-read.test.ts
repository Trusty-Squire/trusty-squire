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
import { sessionForCall } from "../session/lifecycle.js";

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
  '<table><tbody><tr class="zA" role="row" id="row-proton" tabindex="-1">' +
  '<td class="yX xY"><span class="zF" email="no-reply@proton.me" name="Proton Mail">Proton Mail</span></td>' +
  '<td><div class="xS" role="link"><div class="y6">Verify your Proton Mail address</div>' +
  '<span class="y2">Tap to view the code and finish creating your account.</span></div></td>' +
  `<td class="xW"><span title="${new Date(Date.now() + 60_000).toString()}">8:04 PM</span></td>` +
  "</tr></tbody></table>";

const MESSAGE_CARD = `
<div class="adn">
  <div class="gD">Proton Mail &lt;no-reply@proton.me&gt;</div>
  <div class="ii">Here is your verification code: 610228. Enter it in the
  signup window to finish creating your Proton Mail address. This code
  expires in 10 minutes. If you did not request it, ignore this email.</div>
</div>
`;

// Multi-row search results in Gmail's real list shape: tr[role=link] rows
// whose sender cell carries span.zF[email][name] (address + display name),
// the subject is .y6, the snippet .y2, and the date cell keeps its FULL
// timestamp in a span[title] while the visible text collapses it to
// "5:10 AM"/"11:39 PM". Row order models the live rc.35 read (MEASURED
// 2026-09-17): Gmail orders by RELEVANCE, so the stale 11:39 PM Proton code
// ranked FIRST while the fresh 5:10 AM craigslist sign-up mail sat below it.
const STALE_PROTON_CARD = `
<div class="adn">
  <div class="gD">Proton &lt;no-reply@proton.me&gt;</div>
  <div class="ii">To: lunchboxfortwo@gmail.com. Enter this code to finish the process: 934870. Stay secure,
  the Proton Team.</div>
</div>
`;

const CRAIGSLIST_CARD = `
<div class="adn">
  <div class="gD">craigslist &lt;automail@craigslist.org&gt;</div>
  <div class="ii">To: lunchboxfortwo@gmail.com. To complete your craigslist account, complete account
  sign-up: <a href="https://accounts.craigslist.org/signup?tok=NEWACTIVATION7788">Complete
  sign-up</a>. Didn't request this link? Thanks for using craigslist.</div>
</div>
`;

const gRow = (
  id: string,
  email: string,
  name: string,
  subject: string,
  snippet: string,
  dateTitle: string,
  visibleDate: string,
): string =>
  // Real Gmail row shape (MEASURED 2026-09-17): tr.zA[role=row]; the link
  // role lives on the inner div.xS and BOTH the sender cell (td.yX) and the
  // date cell (td.xW) sit OUTSIDE it — metadata must be read from the tr.
  `<tr class="zA" role="row" id="${id}" tabindex="-1">` +
  `<td class="yX xY" role="gridcell"><div class="yW"><span class="bA4">` +
  `<span translate="no" class="zF" email="${email}" name="${name}">${name}</span></span></div></td>` +
  `<td class="xY a4W" role="gridcell"><div class="xS" role="link"><div class="xT">` +
  `<div class="y6"><span class="bog">${subject}</span></div>` +
  `<span class="y2">${snippet}</span></div></div></td>` +
  `<td class="xW xY" role="gridcell"><span title="${dateTitle}">` +
  `<span class="bq3">${visibleDate}</span></span></td>` +
  `</tr>`;

// Gmail's full date-cell timestamp shape ("Sep 17, 2026, 5:10 AM") from a
// Date relative to now. Dates are generated, not hard-coded: the All Mail
// supplement's candidate pool is recency-bound to the last 24h, so fixed
// fixture dates would silently age out of the pool as the wall clock moves.
const gmailDateTitle = (d: Date): string => {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  let h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${h}:${min} ${ampm}`;
};

const MULTI_ROW_LIST =
  `<table><tbody>` +
  gRow(
    "row-proton",
    "no-reply@proton.me",
    "Proton",
    "Proton Verification Code",
    "Enter this code to finish the process: 934870. Stay secure, the Proton Team.",
    gmailDateTitle(new Date(Date.now() - 21 * 60_000)),
    "11:39 PM",
  ) +
  gRow(
    "row-calcom",
    "no-reply@cal.com",
    "Cal.com",
    "Cal.com: Verify your account",
    "Please verify your email address by clicking the button below.",
    gmailDateTitle(new Date(Date.now() - 14 * 60_000)),
    "5:03 AM",
  ) +
  gRow(
    "row-craigslist",
    "automail@craigslist.org",
    "craigslist",
    "craigslist account sign-up",
    "to complete your craigslist account. complete account sign-up",
    gmailDateTitle(new Date(Date.now() - 7 * 60_000)),
    "5:10 AM",
  ) +
  `</tbody></table>`;

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

// Reading the user's Gmail is a Google-dependent operation: `awaitVerification`
// hands back a `google_session` wall unless the profile holds a live Google
// session. Every fixture context below models that signed-in profile — the
// cookie the operator reads for admission, plus the account surface its
// identity probe opens (routed so the probe never touches the network).
async function signedInGoogleContext(): Promise<BrowserContext> {
  if (browser === undefined) throw new Error("Chromium unavailable");
  const context = await browser.newContext();
  await context.addCookies([
    { name: "SID", value: "live-google-session-cookie", domain: ".google.com", path: "/" },
  ]);
  await context.route("https://myaccount.google.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<button aria-label="Google Account: Operator (operator@example.test)"></button>',
    }),
  );
  return context;
}

async function harness(fixture: Fixture): Promise<{ context: BrowserContext }> {
  const context = await signedInGoogleContext();
  const handler = fixtureHandler(fixture);
  await context.route("https://mail.google.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: handler(route.request().url()) }),
  );
  return { context };
}

// Multi-row fixture: every row opens ITS OWN conversation card.
function multiRowHandler(): (url: string) => string {
  return (_url) => {
    const cards = JSON.stringify({
      "row-proton": STALE_PROTON_CARD,
      "row-calcom":
        '<div class="adn"><div class="gD">Cal.com &lt;no-reply@cal.com&gt;</div><div class="ii">Please verify your email address by clicking the button below.</div></div>',
      "row-craigslist": CRAIGSLIST_CARD,
    });
    const openScript = `<script>
      const cards = ${cards};
      const list = document.getElementById("list");
      const conversation = document.getElementById("conversation");
      for (const [id, hash] of [
        ["row-proton", "inbox/11aa22bb33cc44dd55e6"],
        ["row-calcom", "inbox/22bb33cc44dd55e6ff17"],
        ["row-craigslist", "inbox/33cc44dd55e6ff170a28"],
      ]) {
        document.getElementById(id).addEventListener("click", () => {
          list.hidden = true;
          // Only the opened conversation's card exists in the DOM.
          conversation.innerHTML = cards[id];
          location.hash = hash;
        });
      }
      // Gmail restores the results list when navigating back to All Mail.
      // A hash-only navigation does not re-request this routed fixture.
      window.addEventListener("hashchange", () => {
        if (location.hash !== "#all") return;
        conversation.innerHTML = "";
        list.hidden = false;
      });
    </script>`;
    return (
      `<!doctype html><html><head><title>Gmail</title></head><body>` +
      GMAIL_CHROME_HTML +
      `<div id="list" role="main">${LIST_FILLER}${MULTI_ROW_LIST}</div>` +
      `<div id="conversation"></div>` +
      openScript +
      `</body></html>`
    );
  };
}

async function multiRowHarness(): Promise<{ context: BrowserContext }> {
  const context = await signedInGoogleContext();
  const handler = multiRowHandler();
  await context.route("https://mail.google.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: handler(route.request().url()) }),
  );
  return { context };
}

async function readInbox(
  context: BrowserContext,
  opts: {
    sender?: string;
    recipient?: string;
    breakRowExtraction?: boolean;
    // Backdate the session's start so the fixture mails (minutes old) POSTdate
    // the session floor. Models a task that began N minutes ago — the normal
    // shape: the session starts, THEN the signup triggers the fresh mail.
    sessionStartsMinutesAgo?: number;
  } = {},
): Promise<Awaited<ReturnType<typeof awaitVerification>>> {
  const harnessPage = await context.newPage();
  await harnessPage.goto(`http://127.0.0.1:${port}/signup`);
  const controller = BrowserController.fromHarnessPage(harnessPage);
  if (opts.breakRowExtraction) {
    // Model a transient page.evaluate failure (Gmail rerender destroying the
    // execution context): every row extraction throws and the production
    // `.catch(() => [])` swallows it, so the read sees ZERO rows while the
    // page-wide list text still carries a foreign sender's code.
    (
      controller as unknown as { extractMailResultRows: () => Promise<never> }
    ).extractMailResultRows = async () => {
      throw new Error("Execution context was destroyed, most likely because of a navigation");
    };
  }
  const obs = await startHarnessProvisionSession({
    browser: controller,
    serviceUrl: `http://127.0.0.1:${port}/signup`,
    consentInboxRead: true,
  });
  if (opts.sessionStartsMinutesAgo !== undefined) {
    const session = sessionForCall(obs.session_id);
    if (session !== undefined)
      session.startedAt = Date.now() - opts.sessionStartsMinutesAgo * 60_000;
  }
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

describe("operate_read_inbox listing (real Chromium)", () => {
  it.skipIf(!available)(
    "returns messages from different senders for the agent to choose",
    async () => {
      const { context } = await multiRowHarness();
      try {
        const res = await readInbox(context);
        expect(res.messages?.length).toBeGreaterThanOrEqual(2);
        expect(res.messages?.some((message) => message.from?.includes("proton.me"))).toBe(true);
        expect(res.messages?.some((message) => message.from?.includes("craigslist.org"))).toBe(
          true,
        );
        expect(res.code).toBeNull();
      } finally {
        await context.close();
      }
    },
    60_000,
  );

  it.skipIf(!available)(
    "keeps the waiting signup page untouched",
    async () => {
      const { context } = await harness({ rowOpensConversation: true });
      try {
        const res = await readInbox(context);
        expect(res.messages?.[0]?.codes).toContain("610228");
      } finally {
        await context.close();
      }
    },
    60_000,
  );
});
