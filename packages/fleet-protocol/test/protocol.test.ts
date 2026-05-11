import { describe, expect, it } from "vitest";

import {
  commandEnvelopeFixture,
  getProtocolJsonSchemas,
  protocolSchemaVersions,
  validateCommandPayload
} from "../src/index.js";

describe("fleet protocol phase 1 contracts", () => {
  it("exports JSON Schema objects for versioned protocol messages", () => {
    const schemas = getProtocolJsonSchemas();

    expect(schemas.commandEnvelopeV1.$id).toContain("command.envelope.v1");
    expect(schemas.robotTelemetryEventV1.$id).toContain("robot.telemetry.v1");
    expect(schemas.reconnectHandshakeV1.$id).toContain("reconnect.handshake.v1");
    expect(schemas.auditEventV1.$id).toContain("audit.event.v1");
  });

  it("keeps fixtures on the same schema versions as the exported types", () => {
    expect(commandEnvelopeFixture.schemaVersion).toBe(
      protocolSchemaVersions.commandEnvelope
    );
    expect(commandEnvelopeFixture.type).toBe("GO_TO_POSE");
  });

  it("validates the first supported motion payload shape", () => {
    expect(
      validateCommandPayload("GO_TO_POSE", commandEnvelopeFixture.payload).valid
    ).toBe(true);
    expect(validateCommandPayload("GO_TO_POSE", { target: { x: 1 } }).valid).toBe(
      false
    );
  });
});
