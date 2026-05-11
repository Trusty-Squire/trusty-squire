// HTTP routes for the registry. Three endpoints:
//   GET /adapters/:service/:version  — fetch a specific manifest
//   GET /adapters/:service/versions  — list all versions for a service
//   GET /adapters?category=email     — directory of latest manifests
//
// Cache-Control: max-age=3600 on successful manifest fetches —
// manifests are immutable per version and the kill-switch flips to
// 410 (status-code change), so even aggressive caching is safe.

import { rcompare as semverRCompare } from "semver";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import type { ManifestCache } from "../cache.js";
import type { ManifestStore } from "../store.js";
import type { AdapterDirectoryEntry, ManifestResponseBody, ManifestRecord } from "../types.js";

export interface AdaptersRouteDeps {
  store: ManifestStore;
  cache: ManifestCache;
}

export const registerAdaptersRoute: FastifyPluginAsync<AdaptersRouteDeps> = async (
  fastify: FastifyInstance,
  opts,
) => {
  fastify.get<{ Params: { service: string; version: string } }>(
    "/adapters/:service/:version",
    async (req, reply) => {
      const { service, version } = req.params;

      const cached = opts.cache.get(service, version);
      if (cached !== null) {
        return cached.disabled_at !== null
          ? reply.code(410).send(disabledBody(cached))
          : sendManifest(reply, cached);
      }

      const record = await opts.store.get(service, version);
      if (record === null) {
        return reply.code(404).send({ ok: false, error: "not_found" });
      }
      // Cache disabled records too — they're still immutable per
      // version, just unservable. Saves the DB hit on repeated probes.
      opts.cache.set(record);
      if (record.disabled_at !== null) {
        return reply.code(410).send(disabledBody(record));
      }
      return sendManifest(reply, record);
    },
  );

  fastify.get<{ Params: { service: string } }>(
    "/adapters/:service/versions",
    async (req, reply) => {
      const versions = await opts.store.listVersions(req.params.service);
      if (versions.length === 0) {
        return reply.code(404).send({ ok: false, error: "service_not_found" });
      }
      // Semver descending — most recent first.
      const sorted = versions
        .slice()
        .sort((a, b) => semverRCompare(a.version, b.version));
      return reply.code(200).send({
        service: req.params.service,
        versions: sorted.map((r) => ({
          version: r.version,
          disabled: r.disabled_at !== null,
          ...(r.disabled_reason !== null ? { disabled_reason: r.disabled_reason } : {}),
          signed_at: r.signed_at.toISOString(),
        })),
      });
    },
  );

  fastify.get<{ Querystring: { category?: string } }>(
    "/adapters",
    async (req, reply) => {
      const latest = await opts.store.listLatestByService();
      const filtered = latest.filter(
        (r) => req.query.category === undefined || r.manifest.metadata.category === req.query.category,
      );
      const out: AdapterDirectoryEntry[] = filtered.map((r) => ({
        service: r.service,
        latest_version: r.version,
        display_name: r.manifest.metadata.display_name,
        category: r.manifest.metadata.category,
        homepage: r.manifest.metadata.homepage,
        description: r.manifest.metadata.description ?? null,
      }));
      return reply.code(200).send({ adapters: out });
    },
  );
};

function sendManifest(reply: FastifyReply, record: ManifestRecord) {
  const body: ManifestResponseBody = {
    manifest: record.manifest,
    signature: record.signature,
    signed_at: record.signed_at.toISOString(),
    signed_by: record.signed_by,
  };
  reply.header("Cache-Control", "public, max-age=3600, immutable");
  return reply.code(200).send(body);
}

function disabledBody(record: ManifestRecord) {
  return {
    ok: false,
    error: "disabled",
    disabled_at: record.disabled_at?.toISOString() ?? null,
    disabled_reason: record.disabled_reason ?? null,
  };
}
