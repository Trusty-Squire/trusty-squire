// Tool descriptions and the server instructions are the ONLY steering the
// model gets before it picks a route. They are product surface, so they are
// pinned: a snapshot catches any unreviewed drift, and a handful of targeted
// assertions pin the two things that must be true of the text.
//
// Deliberately NOT a banned-word test. A word ban ("seal", "mask") would fail
// on sentences that accurately describe behaviour that still exists — sealed
// session slots, operate_pay's card handling — and the fix for a failing word
// ban is to make the description less accurate, which is backwards.

import { describe, expect, it } from "vitest";
import {
  operateLoginTool,
  provisionActTool,
  provisionAwaitVerificationTool,
  provisionExtractTool,
  provisionObserveTool,
  provisionObserveQueryTool,
  provisionScreenshotTool,
  provisionSealVaultCredentialTool,
  provisionStartTool,
} from "../provision-drive.js";
import { operatePayTool } from "../operate-pay.js";
import { useCredentialTool } from "../use-credential.js";
import { SERVER_INSTRUCTIONS } from "../../server.js";

const STEERING_SURFACE = [
  provisionStartTool,
  provisionObserveTool,
  provisionObserveQueryTool,
  provisionScreenshotTool,
  provisionActTool,
  provisionExtractTool,
  useCredentialTool,
];

// Tools the egress rewrite did NOT touch, snapshotted anyway. A snapshot taken
// in the same diff as a rewrite cannot catch text that rewrite deleted — but
// it does catch the NEXT one, and these three carry the contracts most likely
// to be collateral damage: the sealed-credential fill, the sealed OTP, and the
// payment flow.
const PRESERVED_SURFACE = [
  provisionSealVaultCredentialTool,
  operateLoginTool,
  provisionAwaitVerificationTool,
  operatePayTool,
];

describe("agent-facing steering text", () => {
  for (const tool of [...STEERING_SURFACE, ...PRESERVED_SURFACE]) {
    it(`${tool.name} description is unchanged`, () => {
      expect(tool.description).toMatchSnapshot();
    });
  }

  it("server instructions are unchanged", () => {
    expect(SERVER_INSTRUCTIONS).toMatchSnapshot();
  });
});

describe("the vault path is described as the shortest path", () => {
  it("extract leads with obtaining a credential and points at use_credential", () => {
    expect(provisionExtractTool.description).toMatch(
      /^This is how you obtain a credential from a page\./,
    );
    expect(provisionExtractTool.description).toContain("use_credential");
    expect(provisionExtractTool.description).toContain("reference");
  });

  it("operate_act's extract kind names the same route", () => {
    expect(provisionActTool.description).toContain(
      "THIS is how you obtain a credential from a page",
    );
    expect(provisionActTool.description).toContain("use_credential { target }");
  });

  it("operate_start ends the route at the destination, not at the key", () => {
    expect(provisionStartTool.description).toContain("use_credential { target }");
  });

  it("use_credential documents both modes", () => {
    expect(useCredentialTool.description).toContain("github_repo_secret");
    expect(useCredentialTool.description).toContain("dotenv_write");
    expect(useCredentialTool.description).toContain("exactly one");
  });

  it("the server instructions route obtain → deploy", () => {
    expect(SERVER_INSTRUCTIONS).toContain('kind:"extract"');
    expect(SERVER_INSTRUCTIONS).toContain("dotenv_write");
    // The pre-egress instruction told the agent a .env was the user's own
    // manual job. It is a tool call now; that sentence must not come back.
    expect(SERVER_INSTRUCTIONS).not.toMatch(/plaintext \(e\.g\. for a \.env file\)/);
  });

  it("stays inside the ~2KB system-prompt budget", () => {
    expect(Buffer.byteLength(SERVER_INSTRUCTIONS, "utf8")).toBeLessThanOrEqual(2048);
  });
});

// Finding 8: the rewrite deleted sentences describing guards that no longer
// exist. These are the sentences describing behaviour that DOES still exist,
// quoted, so the next rewrite cannot take them with it.
describe("still-true contracts survive the rewrite", () => {
  it("operate_seal_vault_credential still describes the login-host gate and the slots", () => {
    const description = provisionSealVaultCredentialTool.description;
    expect(description).toContain(
      "retrieve a username/password credential only if the current browser host is allowed for login",
    );
    expect(description).toContain("Raw values are never returned");
    expect(description).toContain("operate_act type_secret");
  });

  it("operate_login still describes all three sealed lifecycle actions", () => {
    const description = operateLoginTool.description;
    expect(description).toContain("without exposing raw values");
    for (const action of ["prepare_signup", "store_signup", "load_saved"]) {
      expect(description).toContain(action);
    }
    expect(description).toContain("kind='type_secret'");
  });

  it("await_verification still tells the agent to seal the OTP into a slot", () => {
    // The slot mechanism is real and unchanged; only the false claim that
    // compact-v2 withholds the code was removed.
    for (const description of [
      provisionAwaitVerificationTool.description,
      provisionActTool.description,
    ]) {
      expect(description).toContain("into_slot");
    }
    expect(provisionActTool.description).toContain("seal the code into a slot");
    expect(provisionActTool.description).toContain("type_secret");
  });

  it("operate_pay guidance survives in its own tool and in the operator surface", () => {
    expect(operatePayTool.description).toContain("operate_pay");
    // The money fence on `type` is a WRITE refusal that still exists; #663
    // removed read seals, not this.
    expect(provisionActTool.description).toContain("card-number-shaped text is refused");
    expect(provisionActTool.description).toContain("operate_pay");
    expect(provisionStartTool.description).toContain("operate_pay");
  });
});

describe("descriptions do not promise guards that #663 removed", () => {
  // Each of these described a seal, redaction, or read refusal that no longer
  // exists. A description that promises one is a lie the model plans around.
  const DEAD_CLAIMS: Array<[string, RegExp]> = [
    ["screenshot masking", /nothing is masked or redacted/i],
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
