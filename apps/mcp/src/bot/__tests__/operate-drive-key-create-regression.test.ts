import { describe, expect, it } from "vitest";
import {
  isSubmitLikeRow,
  keyGoalSecretAdvance,
  type WireRow,
} from "../operate-drive.js";

describe("API key page navigation", () => {
  it("does not treat a key-page link as a submitted form response", () => {
    const link: WireRow = [
      "@e:keys",
      "l",
      "Create API Key|u=https://app.example.test/projects/default/settings/keys",
    ];
    expect(isSubmitLikeRow(link)).toBe(false);
  });

  it("can advance a key goal using a create control below the fold", () => {
    const create: WireRow = ["@e:create", "b", "Create API Key|v=offscreen"];
    expect(
      keyGoalSecretAdvance([create], [], {
        pageUrl: "https://app.example.test/projects/default/settings/keys",
      }),
    ).toEqual(create);
  });
});
