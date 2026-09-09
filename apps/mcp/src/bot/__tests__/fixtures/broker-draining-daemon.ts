import { writeFile } from "node:fs/promises";
import { BrowserController } from "../../browser.js";
import { runBrokerDaemon } from "../../broker/daemon.js";
import { OperatorBroker } from "../../broker/operator.js";

const closeOwnPagesOnly = BrowserController.prototype.closeOwnPagesOnly;
BrowserController.prototype.closeOwnPagesOnly = async function () {
  const marker = process.env.TRUSTY_SQUIRE_BROKER_TEST_CLOSE_ENTERED_PATH;
  if (marker === undefined) return await closeOwnPagesOnly.call(this);
  await writeFile(marker, "entered", "utf8");
  return await new Promise<never>(() => undefined);
};

const connected = OperatorBroker.prototype.connected;
OperatorBroker.prototype.connected = async function (principal) {
  await connected.call(this, principal);
  (this.authority as unknown as { detachedExpiryCloseTimeoutMs: number }).detachedExpiryCloseTimeoutMs =
    25;
};

void runBrokerDaemon();
