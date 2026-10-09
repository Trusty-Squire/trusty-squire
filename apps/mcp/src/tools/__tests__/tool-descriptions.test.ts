import { inputJsonSchema } from "../input-json-schema.js";
// Tool descriptions and the server instructions are the ONLY steering the
// model gets before it picks a route. They are product surface, so they are
// pinned: a snapshot catches any unreviewed drift, and targeted assertions pin
// the things that must stay true of the text.
//
// Deliberately NOT a banned-word test. A word ban ("seal", "mask") would fail
// on sentences that accurately describe behaviour that still exists — sealed
// session slots and inject_card's narrow output mask — and the fix for a failing word
// ban is to make the description less accurate, which is backwards.

import { describe, expect, it } from "vitest";
import {
  OPERATE_TOOLS,
  operateClickTool,
  operateDriveTool,
  operateLoginTool,
  provisionScreenshotTool,
  provisionStartTool,
} from "../provision-drive.js";
import { injectCardTool } from "../inject-card.js";
import { useCredentialTool } from "../use-credential.js";
import { fetchCredentialTool } from "../fetch-credential.js";
import { storeCredentialTool } from "../store-credential.js";
import { SERVER_INSTRUCTIONS } from "../../server.js";

const STEERING_SURFACE = [...OPERATE_TOOLS, useCredentialTool, fetchCredentialTool];
const PRESERVED_SURFACE = [injectCardTool];

describe("agent-facing steering text", () => {
  for (const tool of [...STEERING_SURFACE, ...PRESERVED_SURFACE]) {
    it(`${tool.name} description is unchanged`, () => {
      expect(tool.description).toMatchSnapshot();
    });
  }

  it("server instructions are unchanged", () => {
    expect(SERVER_INSTRUCTIONS).toMatchSnapshot();
  });

  it("stays inside the ~2KB system-prompt budget", () => {
    expect(Buffer.byteLength(SERVER_INSTRUCTIONS, "utf8")).toBeLessThanOrEqual(2048);
  });
});

// fetch_credential is the one tool whose correct use is mostly "don't". The
// steering has to say so in every place the model might reach for it.
describe("the raw-value path is steered as the last resort", () => {
  it("store and fetch steer grants to the existing credential", () => {
    for (const description of [storeCredentialTool.description, fetchCredentialTool.description]) {
      expect(description).toContain("Do not re-store a fetched value");
      expect(description).toContain("grant_app_access");
      expect(description).toContain("use_credential");
    }
  });

  it("fetch_credential names the cost, the approval, and the cheaper route", () => {
    const description = fetchCredentialTool.description;
    expect(description).toContain("transcript");
    expect(description).toContain("passkey approval");
    expect(description).toMatch(/Prefer \`use_credential\`/);
  });

  it("use_credential is described as the default for calling an API", () => {
    expect(useCredentialTool.description).toContain("NEVER crosses to this agent");
    expect(useCredentialTool.description).toContain("Prefer this");
  });

  it("the server instructions gate the raw value behind the approval", () => {
    expect(SERVER_INSTRUCTIONS).toContain("fetch_credential");
    expect(SERVER_INSTRUCTIONS).toContain("passkey approval");
    expect(SERVER_INSTRUCTIONS).toContain("use_credential");
    // The pre-fetch_credential instruction told the agent no raw path existed
    // at all. One does now; that flat denial must not come back.
    expect(SERVER_INSTRUCTIONS).not.toMatch(/There is NO way to extract a raw secret value/);
  });
});

// Screenshots cost more context than DOM reads, but remain a normal way to
// observe a bank challenge or target a visible control.
describe("the screenshot path is steered for visual state", () => {
  const description = provisionScreenshotTool.description;

  it("states its context cost", () => {
    expect(description).toMatch(/costs more context than operate_observe/i);
  });

  it("offers visual and bank-challenge checks", () => {
    expect(description).toContain("operate_observe");
    expect(description).toContain("bank approval");
    expect(description).toContain("coordinate click");
  });

  it("offers isolated challenge frames", () => {
    expect(description).toContain("frame_url_contains");
    expect(description).toMatch(/3-D Secure ACS frame/);
    expect(description).not.toMatch(/refus/i);
  });
});

describe("capture schemas match their handlers", () => {
  const captureFor = (name: string) => {
    const tool = OPERATE_TOOLS.find((entry) => entry.name === name)!;
    return (inputJsonSchema(tool.inputSchema).properties as Record<string, unknown>).capture as {
      properties: {
        store?: unknown;
        write_id?: unknown;
        source: { anyOf: { properties: Record<string, unknown> }[] };
      };
    };
  };

  it("offers capture details only on operate_click and operate_extract", () => {
    for (const name of ["operate_click", "operate_extract"]) {
      const capture = captureFor(name);
      expect("write_id" in capture.properties).toBe(name === "operate_extract");
      expect(
        capture.properties.source.anyOf.some((branch) => "clipboard" in branch.properties),
      ).toBe(name === "operate_click");
      expect(capture.properties.source.anyOf).toHaveLength(name === "operate_click" ? 3 : 2);
      expect(capture.properties.store).toBeDefined();
    }
    for (const name of ["operate_type", "operate_select", "operate_press"]) {
      const tool = OPERATE_TOOLS.find((entry) => entry.name === name)!;
      const capture = (inputJsonSchema(tool.inputSchema).properties as Record<string, unknown>)
        .capture;
      expect(capture).toMatchObject({ deprecated: true });
      expect(capture).not.toHaveProperty("properties");
    }
  });

  it("rejects unusable capture inputs before dispatch", () => {
    const store = { service: "example" };
    const element = { selector: "input" };
    const inputs: Record<string, Record<string, unknown>> = {
      operate_click: { session_id: "session", ref: "e1" },
      operate_type: { session_id: "session", ref: "e1", text: "value" },
      operate_select: { session_id: "session", ref: "e1", values: ["one"] },
      operate_press: { session_id: "session", key: "Enter" },
      operate_extract: { session_id: "session" },
    };
    for (const name of ["operate_click", "operate_type", "operate_select", "operate_press"]) {
      const tool = OPERATE_TOOLS.find((entry) => entry.name === name)!;
      expect(
        tool.inputSchema.safeParse({ ...inputs[name], capture: { store, source: element } })
          .success,
      ).toBe(true);
      if (name === "operate_click")
        expect(
          tool.inputSchema.safeParse({
            ...inputs[name],
            capture: { store, source: element, write_id: "old" },
          }).success,
        ).toBe(false);
    }
    for (const name of ["operate_extract"]) {
      const tool = OPERATE_TOOLS.find((entry) => entry.name === name)!;
      expect(
        tool.inputSchema.safeParse({
          ...inputs[name],
          capture: { store, source: { clipboard: true } },
        }).success,
      ).toBe(false);
    }
    expect(
      operateClickTool.inputSchema.safeParse({
        ...inputs.operate_click,
        capture: { store, source: { clipboard: true } },
      }).success,
    ).toBe(true);
    expect(
      OPERATE_TOOLS.find((entry) => entry.name === "operate_extract")!.inputSchema.safeParse({
        ...inputs.operate_extract,
        capture: { store, source: element, write_id: "old" },
      }).success,
    ).toBe(true);
  });

  it("rejects deprecated mutation capture before dispatch with the replacement call", async () => {
    const inputs: Record<string, Record<string, unknown>> = {
      operate_type: { session_id: "session", ref: "e1", text: "value" },
      operate_select: { session_id: "session", ref: "e1", values: ["one"] },
      operate_press: { session_id: "session", key: "Enter" },
    };
    for (const name of Object.keys(inputs)) {
      const tool = OPERATE_TOOLS.find((entry) => entry.name === name)!;
      const args = tool.inputSchema.parse({
        ...inputs[name],
        capture: { store: { service: "x" } },
      });
      await expect(tool.handler(args, null)).rejects.toThrow(/operate_extract\(\{capture\}\)/);
    }
  });

  it("navigation does not promise a control-plane restriction", () => {
    expect(
      OPERATE_TOOLS.find((entry) => entry.name === "operate_navigate")!.description,
    ).not.toMatch(/control-plane|refused/);
  });
});

// The sentences describing behaviour that DOES still exist, quoted, so the next
// description rewrite cannot take them with it.
describe("still-true contracts survive the cleanup", () => {
  it("operate_login still describes all three sealed lifecycle actions", () => {
    const description = operateLoginTool.description;
    expect(description).toContain("without exposing raw values");
    for (const action of ["prepare_signup", "store_signup", "load_saved"]) {
      expect(description).toContain(action);
    }
    expect(description).toContain("operate_type with slot");
  });

  it("inject_card guidance is present in its tool and the operator surface", () => {
    expect(injectCardTool.description).toContain("single human purchase approval");
    expect(injectCardTool.description).toContain("show the link now, then call inject_card again");
    expect(injectCardTool.description).toContain("fill only the supplied observation refs");
    expect(injectCardTool.description).toContain("competing saved-card control");
    expect(inputJsonSchema(injectCardTool.inputSchema).required).toContain("session_id");
    expect(provisionStartTool.description).toContain("inject_card");
    expect(injectCardTool.description).toContain("operator notifies the cardholder once");
    for (const description of [injectCardTool.description, operateClickTool.description]) {
      expect(description).toContain(
        "do not click, type, navigate, reload, resubmit, or trigger another verification",
      );
      expect(description).toContain(
        "operate_screenshot or operate_observe (short, non-blocking checks)",
      );
    }
  });

  it("states the minor-unit rule on every payment amount prompt", () => {
    const amountDescription = (
      inputJsonSchema(injectCardTool.inputSchema).properties as {
        amount_cents: { description: string };
      }
    ).amount_cents.description;
    for (const description of [
      injectCardTool.description,
      amountDescription,
      operateDriveTool.description,
      SERVER_INSTRUCTIONS,
    ]) {
      expect(description).toContain("smallest unit");
      expect(description).toContain("USD $12.34 -> 1234");
      expect(description).toContain("JPY ¥65,800 -> 65800 (do not multiply by 100)");
      expect(description).toContain("KRW works like JPY");
    }
  });

  it("inject_card accepts only pan/cvv targets and steers expiry/name to ordinary tools", () => {
    // Expiry and cardholder name are not secret: the schema must not accept
    // them as release-and-inject targets, and the description must point the
    // agent at operate_type/operate_select plus the masked tokens.
    const fields = (
      injectCardTool.inputSchema as unknown as {
        shape: { fields: { shape: Record<string, unknown> } };
      }
    ).shape.fields.shape;
    expect(Object.keys(fields).sort()).toEqual(["cvv", "pan"]);
    const base = {
      session_id: "00000000-0000-4000-8000-000000000000",
      merchant: "Synthetic Merchant",
      amount_cents: 123,
      currency: "JPY",
      item: "Synthetic item",
      reason: "Synthetic test purchase",
      card_ref: "card_synthetic",
    };
    for (const field of ["exp_month", "exp_year", "exp", "name"]) {
      const parsed = injectCardTool.inputSchema.safeParse({
        ...base,
        fields: { [field]: { ref: "e1" } },
      });
      expect(parsed.success, `${field} must not be an inject_card target`).toBe(false);
    }
    expect(
      injectCardTool.inputSchema.safeParse({
        ...base,
        fields: { pan: { ref: "e1" }, cvv: { ref: "e2" } },
      }).success,
    ).toBe(true);
    expect(injectCardTool.description).toContain("operate_type/operate_select");
    expect(injectCardTool.description).toContain("exp_month");
    expect(injectCardTool.description).toContain("alongside last4");
    expect(injectCardTool.description).toContain("{{pan}}");
    expect(injectCardTool.description).toContain("{{cvv:N}}");
    expect(injectCardTool.description).toContain("masked from all normal operator output");
  });
});

describe("descriptions do not promise guards that #663 removed", () => {
  // Each of these described a seal, redaction, or read refusal that no longer
  // exists. A description that promises one is a lie the model plans around.
  const DEAD_CLAIMS: Array<[string, RegExp]> = [
    ["screenshot refusal", /never refused because the page is showing/i],
    ["screened labels", /never screened for content/i],
    ["withheld verification code", /never emits the raw code/i],
    ["screened URL", /screened origin/i],
    ["sealed context", /sealed context/i],
    ["money fence", /money[- ]fence/i],
  ];
  for (const tool of STEERING_SURFACE) {
    for (const [label, pattern] of DEAD_CLAIMS) {
      it(`${tool.name} does not claim ${label}`, () => {
        expect(tool.description).not.toMatch(pattern);
      });
    }
  }
});

// Registered descriptions are the protocol documentation delivered to callers.
describe("current observation protocol documentation", () => {
  it("operate_start documents compact default and verbatim full opt-in", () => {
    const description = OPERATE_TOOLS.find((tool) => tool.name === "operate_start")!.description;
    for (const token of [
      "browser-use-dom",
      "dom",
      "tab-indented",
      "|SHADOW(open)|",
      "not-targetable=true",
      "more_above",
      "more_below",
      "*",
      "removed",
      "delta:true",
      "browser-use-control-query",
      "safe_table",
      "[ref,role,facts?]",
      'format:"compact"',
      'format:"full"',
      "prefixes of at least eight digits) and security code are masked",
    ]) {
      expect(description).toContain(token);
    }
    expect(description).not.toMatch(/observe_query/);
    expect(description).not.toMatch(/state bitset|detail:full|card\/secret-shaped|never emitted/);
  });

  it("operate_observe documents both reachable response grammars", () => {
    const description = OPERATE_TOOLS.find((tool) => tool.name === "operate_observe")!.description;
    for (const token of [
      "browser-use-dom",
      "browser-use-control-query",
      "dom",
      "tab-indented",
      "|SHADOW(open)|",
      "not-targetable=true",
      "more_above",
      "more_below",
      "*",
      "removed",
      "delta:true",
      'format:"compact"',
      'format:"full"',
      "prefixes of at least eight digits) and security code are masked",
    ]) {
      expect(description).toContain(token);
    }
    expect(description).toContain("safe_table");
    expect(description).toContain("[ref,role,facts?]");
    expect(description).not.toMatch(/observe_query/);
    expect(description).not.toMatch(/state bitset|detail:full|card\/secret-shaped|never emitted/);
  });
});
