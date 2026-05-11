// Publish CLI: load an adapter's manifest, validate, sign, insert.
//
// Usage: pnpm registry:publish <adapter-name> [--registry-url=URL]
//
// Looks up the adapter at `packages/adapters/<name>/src/index.ts`
// expecting a default export of AdapterManifest. The CLI defaults to
// posting against a Prisma-backed store at REGISTRY_DATABASE_URL —
// for dev workflows the registry-api server doesn't need to be
// running for `publish:adapter` itself; it writes directly to the
// DB. The running server's per-worker cache will pick up new entries
// at next read (or after the 1h TTL expires).

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import type { AdapterManifest } from "@trusty-squire/adapter-sdk";
import { ManifestSigner } from "./signer.js";
import { ManifestConflictError, type ManifestStore } from "./store.js";
import { ManifestValidationError, validateManifest } from "./validator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

export interface PublishInputs {
  adapterName: string;
  store: ManifestStore;
  signer: ManifestSigner;
  // Allow tests to inject a manifest directly without dynamic import.
  manifest?: AdapterManifest;
  // Where to look for the adapter manifest module on disk. Tests may
  // override; defaults to packages/adapters/<name>/src/index.ts.
  resolveAdapterPath?: (name: string) => string;
}

export type PublishOutcome =
  | { kind: "published"; service: string; version: string }
  | { kind: "validation_failed"; issues: string[] }
  | { kind: "already_published"; service: string; version: string };

export async function publishAdapter(inputs: PublishInputs): Promise<PublishOutcome> {
  let manifest: AdapterManifest;
  if (inputs.manifest !== undefined) {
    manifest = inputs.manifest;
  } else {
    const resolver = inputs.resolveAdapterPath ?? defaultAdapterPath;
    const modulePath = resolver(inputs.adapterName);
    const mod = (await import(pathToFileURL(modulePath).href)) as {
      default?: AdapterManifest;
    };
    if (mod.default === undefined) {
      throw new Error(`adapter '${inputs.adapterName}' has no default export at ${modulePath}`);
    }
    manifest = mod.default;
  }

  try {
    validateManifest(manifest);
  } catch (err) {
    if (err instanceof ManifestValidationError) {
      return { kind: "validation_failed", issues: err.issues };
    }
    throw err;
  }

  // Replace the placeholder signature with the real one. Sign over
  // the canonical bytes WITHOUT the signature field (or with a fixed
  // empty value); we sign the manifest as published, then store the
  // signature alongside it. The published manifest's `signature`
  // field is preserved as-is — the canonical bytes for verification
  // are computed over the same shape the signer used.
  const envelope = inputs.signer.sign(manifest);

  try {
    await inputs.store.insert({
      service: manifest.service,
      version: manifest.version,
      manifest,
      signature: envelope.signature,
      signed_at: new Date(envelope.signed_at),
      signed_by: envelope.signed_by,
    });
  } catch (err) {
    if (err instanceof ManifestConflictError) {
      return { kind: "already_published", service: manifest.service, version: manifest.version };
    }
    throw err;
  }

  return { kind: "published", service: manifest.service, version: manifest.version };
}

function defaultAdapterPath(name: string): string {
  return join(REPO_ROOT, "packages", "adapters", name, "src", "index.ts");
}

// ── CLI entry point ──────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: pnpm registry:publish <adapter-name>");
    process.exit(1);
  }
  const adapterName = args[0]!;

  // We only need the Prisma client when invoked as a CLI. Importing
  // it lazily keeps the test path (which uses InMemoryStore) free of
  // a database dependency.
  const { PrismaManifestStore } = await import("./prisma-store.js");
  const store = await PrismaManifestStore.fromEnv();

  let signer: ManifestSigner;
  try {
    signer = ManifestSigner.fromEnv();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const outcome = await publishAdapter({ adapterName, store, signer });
  switch (outcome.kind) {
    case "published":
      console.warn(`✓ Published ${outcome.service}@${outcome.version}`);
      break;
    case "already_published":
      console.error(`× ${outcome.service}@${outcome.version} already published`);
      process.exit(2);
      break;
    case "validation_failed":
      console.error("× Validation failed:");
      for (const issue of outcome.issues) console.error(`  - ${issue}`);
      process.exit(3);
      break;
  }

  await store.disconnect();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(99);
  });
}
