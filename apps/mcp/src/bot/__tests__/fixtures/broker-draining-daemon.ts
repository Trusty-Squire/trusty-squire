import { BrokerAuthority } from "../../broker/authority.js";
import { runBrokerDaemon } from "../../broker/daemon.js";

const inventory = BrokerAuthority.prototype.inventory;
BrokerAuthority.prototype.inventory = function () {
  return { ...inventory.call(this), quarantined: 1 };
};

void runBrokerDaemon();
