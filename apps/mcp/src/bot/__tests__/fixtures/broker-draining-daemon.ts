import { writeFile } from "node:fs/promises";
import { runBrokerDaemon } from "../../broker/daemon.js";
import { OperatorBroker } from "../../broker/operator.js";

const connected = OperatorBroker.prototype.connected;
let actorCreated = false;
OperatorBroker.prototype.connected = async function (principal) {
  await connected.call(this, principal);
  if (actorCreated || principal.supervisor) return;
  actorCreated = true;
  (this.authority as unknown as { detachedExpiryCloseTimeoutMs: number }).detachedExpiryCloseTimeoutMs =
    25;
  const capability = await this.authority.open(principal, ["fixture:browser"], async () => ({
    targetId: "fixture-browser",
    invoke: async () => undefined,
    close: async () => await new Promise<boolean>(() => undefined),
  }));
  this.authority.detach(principal, Date.now(), 0);
  this.authority.releaseForwarder(principal);
  const actorPath = process.env.TRUSTY_SQUIRE_BROKER_TEST_ACTOR_PATH;
  if (actorPath !== undefined) await writeFile(actorPath, capability.sessionId, "utf8");
};

void runBrokerDaemon();
