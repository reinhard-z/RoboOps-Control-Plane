import {
  createFleetPlatformRuntime,
  listenFleetPlatform
} from "./server.js";

export { loadFleetPlatformConfig } from "./config.js";
export { PlatformEventHub } from "./event-hub.js";
export type { PlatformStreamEvent } from "./event-hub.js";
export { ConsoleStructuredLogger, SilentStructuredLogger } from "./logging.js";
export type { StructuredLogger } from "./logging.js";
export { InMemoryDomainStateRepository } from "@roboops/fleet-persistence";
export type { DomainStateRepository } from "@roboops/fleet-persistence";
export { createSeededDomainState } from "./repository.js";
export { FleetPlatformService } from "./service.js";
export type { EdgeCommandTransport, MissionCommandServiceResult } from "./service.js";
export {
  createFleetPlatformRuntime,
  listenFleetPlatform
} from "./server.js";
export type {
  FleetPlatformRuntime,
  FleetPlatformRuntimeOptions
} from "./server.js";
export type {
  CreateMissionRequest,
  EdgeWireMessage,
  FleetPlatformConfig,
  PlatformWireMessage,
  RequestContext
} from "./types.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  const runtime = createFleetPlatformRuntime();
  await listenFleetPlatform(runtime);
  console.log(
    JSON.stringify({
      level: "info",
      message: "fleet platform listening",
      host: runtime.config.host,
      port: runtime.config.port
    })
  );
}
