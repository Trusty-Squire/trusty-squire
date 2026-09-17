// Real-browser operate_decide test: a live harness session on a fixture page
// exercises the FULL decide path — real compact observation feeding the Jev
// state, the vault-shaped request (service `typesafe`, `Bearer ${SECRET}`,
// criteria object keyed by live @e refs, never an `options` array), and
// confidence/answer mapping back to concrete refs. The Jev upstream is
// stubbed at the api-client boundary with the model's MEASURED behavior
// (scout report ts-jev-navigation-latency): a matching option is returned
// with high confidence, and when the correct option is deliberately absent
// the forced pick comes back with LOW confidence (~0.26) — the tool must
// pass that through unmodified so the caller's gate sees it.
// The retry/backoff and error-mapping edges live in the fast tier
// (src/tools/__tests__/operate-decide.test.ts).

import { chromium } from "playwright";
import { expect, it } from "vitest";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { finishProvisionSession, startHarnessProvisionSession } from "../provision-session.js";
import { operateDecideTool } from "../../tools/operate-decide.js";

type UseCredentialInput = Parameters<ApiClient["useCredential"]>[0];

interface StubQuestion {
  type: string;
  instructions: string;
  criteria?: Record<string, string>;
}

function jevOk(body: unknown): {
  response: { status: number; headers: Record<string, string>; body: string; truncated: boolean };
} {
  return { response: { status: 200, headers: {}, body: JSON.stringify(body), truncated: false } };
}

// Measured Jev semantics: pick the option whose description matches the goal
// keyword with high confidence; when nothing matches (the goal's target is
// not among the options) return a forced pick with collapsed confidence.
function stubbedJevApi(calls: UseCredentialInput[]): ApiClient {
  return {
    useCredential: async (input: UseCredentialInput) => {
      calls.push(input);
      const body = JSON.parse(input.http.body!) as {
        model: string;
        state: string;
        questions: Record<string, StubQuestion>;
      };
      const answers: Record<string, unknown> = {};
      for (const [name, question] of Object.entries(body.questions)) {
        if (question.type === "noul") {
          answers[name] = { noul: 0.03, confidence: 0.88 };
          continue;
        }
        const criteria = question.criteria ?? {};
        const keywords = /reveal|email|key name/i.exec(question.instructions);
        const wanted =
          keywords === null
            ? undefined
            : Object.keys(criteria).find((key) =>
                new RegExp(keywords[0]!, "i").test(criteria[key]!),
              );
        if (wanted !== undefined) {
          answers[name] = {
            choice: wanted,
            confidence: 0.94,
            probabilities: Object.fromEntries(
              Object.keys(criteria).map((key) => [key, key === wanted ? 0.94 : 0.01]),
            ),
          };
        } else {
          // Correct option absent: forced pick with low confidence.
          const forced = Object.keys(criteria)[0]!;
          answers[name] = {
            choice: forced,
            confidence: 0.26,
            probabilities: Object.fromEntries(
              Object.keys(criteria).map((key) => [key, key === forced ? 0.26 : 0.2]),
            ),
          };
        }
      }
      return jevOk({ model: body.model, answers });
    },
  } as unknown as ApiClient;
}

it("operate_decide on a live fixture page: expected ref with confidence, absent option with LOW confidence, never acts", async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  let sessionId: string | undefined;
  const jevCalls: UseCredentialInput[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.route("https://fixture.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset="utf-8"><title>Decide fixture</title>
        <main><h1>API keys — synthetic test account</h1>
        <label>Key name <input id="name"></label>
        <label>Contact email <input id="email"></label>
        <label>City <input id="city"></label>
        <button onclick="document.querySelector('#name').value='revealed'">Reveal</button>
        <button>Create</button></main>`,
      }),
    );
    const start = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: "https://fixture.test/keys",
      format: "compact",
    });
    sessionId = start.session_id;
    const rows = (start as unknown as { safe_table: string[][] }).safe_table;
    const liveRef = (alias: string): string => {
      const row = rows.find((row) => row[2]?.split("|")[0] === alias);
      expect(row, `control ${alias} on the live page`).toBeDefined();
      return row![0]!;
    };

    // ── Leg 1: expected ref comes back with its confidence, mapped to the
    // live page's concrete ref, and the tool never acts on the page.
    const revealed = (await operateDecideTool.handler(
      { session_id: sessionId, goal: "Click the control that reveals the API key" },
      stubbedJevApi(jevCalls),
    )) as { decision: string; ref: string; role: string; confidence: number; stuck: { noul: number } };
    expect(revealed.decision).toBe("pick_ref");
    expect(revealed.ref).toBe(liveRef("@reveal"));
    expect(revealed.role).toBe("button");
    expect(revealed.confidence).toBe(0.94);
    expect(revealed.stuck.noul).toBe(0.03);
    // Non-action proof: the page is untouched.
    expect(await page.locator("#name").inputValue()).toBe("");

    // ── Leg 2: a goal whose target is deliberately absent from the page —
    // the forced pick arrives with LOW confidence, passed through unmodified.
    const absent = (await operateDecideTool.handler(
      { session_id: sessionId, goal: "Click the 'Delete account' button" },
      stubbedJevApi(jevCalls),
    )) as { decision: string; confidence: number; ref: string };
    expect(absent.decision).toBe("pick_ref");
    expect(absent.confidence).toBe(0.26);
    expect(rows.map((row) => row[0])).toContain(absent.ref);

    // ── Leg 3: caller-provided options with the correct value absent —
    // low confidence survives the option mapping too.
    const assigned = (await operateDecideTool.handler(
      {
        session_id: sessionId,
        goal: "Which value belongs in the contact email field?",
        decision: {
          type: "choice",
          options: { city_value: "Mountain View", zip_value: "94043" },
        },
      },
      stubbedJevApi(jevCalls),
    )) as { decision: string; value: string; confidence: number };
    expect(assigned.decision).toBe("pick_option");
    expect(["city_value", "zip_value"]).toContain(assigned.value);
    expect(assigned.confidence).toBe(0.26);

    // ── Leg 4: noul validation shape.
    const checked = (await operateDecideTool.handler(
      { session_id: sessionId, goal: "The form is complete.", decision: { type: "noul" } },
      stubbedJevApi(jevCalls),
    )) as { decision: string; noul: number; confidence: number };
    expect(checked.decision).toBe("noul");
    expect(checked.noul).toBe(0.03);
    expect(checked.confidence).toBe(0.88);

    // ── The wire shape to the vault: measured Jev request, ${SECRET} never
    // resolved locally, criteria keyed by live refs, no options array.
    const first = jevCalls[0]!;
    expect(first.service).toBe("typesafe");
    expect(first.http.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(first.http.headers?.authorization).toBe("Bearer ${SECRET}");
    const body = JSON.parse(first.http.body!) as {
      questions: Record<string, StubQuestion>;
    };
    const pick = body.questions.pick!;
    expect(pick.type).toBe("choice");
    const criteriaKeys = Object.keys(pick.criteria!);
    expect(criteriaKeys.length).toBeGreaterThan(1);
    for (const key of criteriaKeys) {
      expect(rows.map((row) => row[0])).toContain(key);
    }
    expect(JSON.stringify(body)).not.toContain('"options":[');
    expect(jevCalls.length).toBe(4);
  } finally {
    if (sessionId) await finishProvisionSession(sessionId);
    await browser.close();
  }
}, 60_000);
