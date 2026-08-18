#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [packageName, installedEntry, sourceRoot] = process.argv.slice(2);
if (packageName === undefined || installedEntry === undefined || sourceRoot === undefined) {
  console.error("usage: verify-package-runtime-exports <package> <installed-entry> <source-root>");
  process.exit(2);
}

// Resolve the parser from the consumer package, which the filtered CI install
// guarantees is present even when root devDependencies are not linked.
const requireFromConsumer = createRequire(resolve(sourceRoot, "../package.json"));
const ts = requireFromConsumer("typescript");

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sourceFiles(path);
    }
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

const required = new Set();
for (const path of sourceFiles(sourceRoot)) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== packageName)
      continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    if (clause.name !== undefined) required.add("default");
    if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
      console.error(
        `${path} uses a namespace import from ${packageName}; named-export verification is required`,
      );
      process.exit(1);
    }
    if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
      for (const binding of clause.namedBindings.elements) {
        if (!binding.isTypeOnly) required.add((binding.propertyName ?? binding.name).text);
      }
    }
  }
}

const published = await import(pathToFileURL(installedEntry).href);
const missing = [...required].filter((name) => !(name in published));
if (missing.length > 0) {
  console.error(`${packageName} is missing runtime exports imported by MCP: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`${packageName} provides all MCP runtime imports: ${[...required].sort().join(", ")}`);
