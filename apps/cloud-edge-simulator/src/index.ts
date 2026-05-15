import { runCloudEdgeSimulator } from "./client.js";
import { loadCloudEdgeSimulatorConfig } from "./config.js";

export { runCloudEdgeSimulator } from "./client.js";
export type {
  CloudEdgeSimulatorRuntime,
  CloudEdgeSimulatorRuntimeOptions
} from "./client.js";
export {
  createEdgeConnectUrl,
  loadCloudEdgeSimulatorConfig
} from "./config.js";
export {
  createHelloMessage,
  createInitialSimulatorState,
  createReconnectHandshakeMessage,
  createTelemetryMessage,
  handlePlatformMessage,
  parsePlatformMessage
} from "./messages.js";
export type {
  CloudEdgeSimulatorConfig,
  SimulatorEdgeMessage,
  SimulatorPlatformMessage,
  SimulatorScenario,
  SimulatorState,
  SimulatorStep
} from "./types.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  const runtime = runCloudEdgeSimulator(loadCloudEdgeSimulatorConfig());
  const stop = () => {
    runtime.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
