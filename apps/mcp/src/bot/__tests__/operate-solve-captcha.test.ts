import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { runOperateCaptchaSolve } from "../captcha-solve.js";
import { operateSolveCaptchaTool } from "../../tools/provision-drive.js";
import type { Session } from "../session/model.js";

function sharedCalls(path: URL): number {
  const source = ts.createSourceFile(
    path.pathname,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imported = source.statements.some(
    (node) =>
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier.getText(source).includes("captcha-solve.js") &&
      node.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some(
        (element) => element.name.text === "runOperateCaptchaSolve",
      ),
  );
  expect(imported).toBe(true);
  let calls = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "runOperateCaptchaSolve"
    )
      calls += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

describe("operate CAPTCHA entry point", () => {
  it("is registered with a session-only input", () => {
    expect(operateSolveCaptchaTool.name).toBe("operate_solve_captcha");
    expect(operateSolveCaptchaTool.inputSchema.parse({ session_id: "s1" })).toEqual({
      session_id: "s1",
    });
    expect(operateSolveCaptchaTool.jsonInputSchema.required).toEqual(["session_id"]);
  });

  it("is called by both the drive and the direct tool", () => {
    expect(sharedCalls(new URL("../operate-drive.ts", import.meta.url))).toBeGreaterThan(0);
    expect(sharedCalls(new URL("../../tools/provision-drive.ts", import.meta.url))).toBeGreaterThan(
      0,
    );
  });

  it("presses a checkbox before trying the token path", async () => {
    const order: string[] = [];
    const pressCheckboxChallenge = vi.fn(async () => {
      order.push("press");
      return { found: true, solved: false, kind: "recaptcha" } as const;
    });
    const attemptAutoSolve = vi.fn(async () => {
      order.push("solve");
      return "fetch_started";
    });
    const result = await runOperateCaptchaSolve({ browser: { page: null } } as Session, {
      pressCheckbox: true,
      pressCheckboxChallenge,
      attemptAutoSolve,
    });
    expect(order).toEqual(["press", "solve"]);
    expect(result).toEqual({
      outcome: "fetch_started",
      checkbox: { found: true, solved: false, kind: "recaptcha" },
    });
  });
});
