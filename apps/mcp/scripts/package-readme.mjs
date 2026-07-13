#!/usr/bin/env node

import { copyFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const canonicalReadme = path.resolve(packageRoot, "../..", "README.md");
const packageReadme = path.join(packageRoot, "README.md");

async function stage() {
  // npm only discovers a README inside the package root. Materialize the
  // repository's canonical README immediately before the tarball is built;
  // postpack removes it again so there is still only one authored copy.
  await copyFile(canonicalReadme, packageReadme);
}

async function clean() {
  let staged;
  try {
    staged = await readFile(packageReadme);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }

  const canonical = await readFile(canonicalReadme);
  if (!staged.equals(canonical)) {
    throw new Error(`Refusing to remove ${packageReadme}: it no longer matches ${canonicalReadme}`);
  }

  await unlink(packageReadme);
}

const command = process.argv[2];
if (command === "stage") {
  await stage();
} else if (command === "clean") {
  await clean();
} else {
  console.error("usage: node scripts/package-readme.mjs <stage|clean>");
  process.exitCode = 2;
}
