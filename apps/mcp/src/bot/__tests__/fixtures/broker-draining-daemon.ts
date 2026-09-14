import { BrowserController } from "../../browser.js";
import { runBrokerDaemon } from "../../broker/daemon.js";

BrowserController.prototype.detectSessionProviders = async () => ["google"];

void runBrokerDaemon();
