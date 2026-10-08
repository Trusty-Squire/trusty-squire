// Pure-helper tests for the capture cluster.
import { describe, it, expect } from "vitest";
import { storableCredentials } from "../capture.js";

describe("storableCredentials (decided by field name, never by value shape)", () => {
  it("keeps any value under a credential field, whatever its shape", () => {
    for (const value of ["Ab3kZ9", "QWERTYUIOPASDFGHJKLZ", "123e4567-e89b-12d3-a456-426614174000"])
      expect(storableCredentials({ api_key: value })).toEqual({ api_key: value });
  });

  it("drops truncated displays and refuses id-only results", () => {
    expect(storableCredentials({ api_key_truncated: "sk-…abcd" })).toBeNull();
    expect(storableCredentials({ id: "1", project_id: "p" })).toBeNull();
    expect(storableCredentials({ project_id: "p", api_key: "k", api_key_truncated: "k…" })).toEqual(
      { project_id: "p", api_key: "k" },
    );
  });
});
