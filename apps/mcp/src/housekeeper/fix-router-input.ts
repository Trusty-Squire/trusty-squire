import type { FixBatch } from "./fix-batch.js";
import type { RouterInput } from "./fix-router.js";
import type { FailureStage } from "../bot/failure-stage.js";

export interface RouterCluster {
  failure_stage: FailureStage;
  services: string[];
}

export interface ServiceRoutingFact {
  dnsAlive?: boolean;
  curatedNeedsManual?: boolean;
}

export type ServiceRoutingFacts = Readonly<Record<string, ServiceRoutingFact>>;

function factFor(facts: ServiceRoutingFacts | undefined, service: string): ServiceRoutingFact {
  return facts?.[service] ?? {};
}

export function buildRouterInput(
  cluster: RouterCluster,
  batch: FixBatch,
  facts?: ServiceRoutingFacts,
): RouterInput {
  const passRateByService = new Map(
    batch.stats.perService.map((s) => [s.service, s.passRate] as const),
  );
  const services = cluster.services.length > 0 ? cluster.services : ["unknown"];
  const rates = services.map((service) => passRateByService.get(service) ?? 0);
  const recentGreenRate = rates.length === 0 ? 0 : Math.min(...rates);
  const dnsAlive = services.every((service) => factFor(facts, service).dnsAlive !== false);
  const curatedNeedsManual = services.some(
    (service) => factFor(facts, service).curatedNeedsManual === true,
  );

  return {
    service: services[0] ?? "unknown",
    coarseKind: cluster.failure_stage,
    stage: cluster.failure_stage,
    recentGreenRate,
    dnsAlive,
    curatedNeedsManual,
  };
}
