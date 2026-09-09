import { BrowserController } from "../../browser.js";
import { runBrokerDaemon } from "../../broker/daemon.js";
import { OperatorBroker } from "../../broker/operator.js";

BrowserController.prototype.detectSessionProviders = async () => ["google"];

const connected = OperatorBroker.prototype.connected;
OperatorBroker.prototype.connected = async function (principal) {
  await connected.call(this, principal);
  (
    this.authority as unknown as { detachedExpiryCloseTimeoutMs: number }
  ).detachedExpiryCloseTimeoutMs = 25;
};

void runBrokerDaemon();
