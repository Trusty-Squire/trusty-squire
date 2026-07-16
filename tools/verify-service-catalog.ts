type CatalogModule = typeof import("../apps/web/app/services/service-content.ts");

const loadedCatalog =
  (await import("../apps/web/app/services/service-content.ts")) as CatalogModule & {
    default?: CatalogModule;
  };
const SERVICES = loadedCatalog.SERVICES ?? loadedCatalog.default?.SERVICES;

if (SERVICES === undefined) {
  throw new Error("Could not load the checked-in service catalog");
}

const REGISTRY_URL = process.env.TRUSTY_SQUIRE_REGISTRY_URL ?? "https://registry.trustysquire.ai";

interface RegistrySkillSummary {
  service: string;
  skill_id: string;
  status: string;
}

interface RegistryResponse {
  skills?: RegistrySkillSummary[];
  data?: RegistrySkillSummary[];
}

function rowsFrom(payload: RegistryResponse | RegistrySkillSummary[]): RegistrySkillSummary[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.skills)) return payload.skills;
  if (Array.isArray(payload.data)) return payload.data;
  throw new Error("Registry response did not contain a skill list");
}

const response = await fetch(`${REGISTRY_URL}/skills?status=active&limit=500`, {
  headers: { accept: "application/json" },
});

if (!response.ok) {
  throw new Error(`Registry request failed with ${response.status} ${response.statusText}`);
}

const liveRows = rowsFrom((await response.json()) as RegistryResponse | RegistrySkillSummary[])
  .filter((row) => row.status === "active")
  .sort((a, b) => a.service.localeCompare(b.service));
const liveBySlug = new Map(liveRows.map((row) => [row.service, row]));
const localBySlug = new Map(SERVICES.map((service) => [service.registry.service, service]));

const missing = liveRows.filter((row) => !localBySlug.has(row.service)).map((row) => row.service);
const stale = SERVICES.filter((service) => !liveBySlug.has(service.registry.service)).map(
  (service) => service.registry.service,
);
const changed = SERVICES.flatMap((service) => {
  const live = liveBySlug.get(service.registry.service);
  if (live === undefined || live.skill_id === service.registry.skill_id) return [];
  return [`${service.registry.service}: local ${service.registry.skill_id}, live ${live.skill_id}`];
});

if (missing.length > 0 || stale.length > 0 || changed.length > 0) {
  if (missing.length > 0) console.error(`Missing active services: ${missing.join(", ")}`);
  if (stale.length > 0) console.error(`No longer active: ${stale.join(", ")}`);
  if (changed.length > 0) console.error(`Changed skills:\n${changed.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(
    `Service catalog matches ${liveRows.length} active registry skills at ${REGISTRY_URL}.`,
  );
}
