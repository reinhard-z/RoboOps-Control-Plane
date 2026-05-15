import { describe, expect, it } from "vitest";

import { loadOperatorUiConfig } from "../src/config.js";
import { renderOperatorUiDocument } from "../src/document.js";

describe("operator UI config", () => {
  it("keeps demo controls disabled unless explicitly configured", () => {
    const config = loadOperatorUiConfig({});

    expect(config.demoMode).toBe(false);
    expect(config.demoAdminToken).toBeUndefined();
  });

  it("requires explicit UI demo mode while allowing the shared demo token env", () => {
    const config = loadOperatorUiConfig({
      OPERATOR_DEMO_MODE: "true",
      DEMO_ADMIN_TOKEN: "local-demo-token"
    });

    expect(config.demoMode).toBe(true);
    expect(config.demoAdminToken).toBe("local-demo-token");
  });

  it("lets the Operator UI token override the shared backend token", () => {
    const config = loadOperatorUiConfig({
      OPERATOR_DEMO_MODE: "true",
      DEMO_ADMIN_TOKEN: "backend-token",
      OPERATOR_DEMO_ADMIN_TOKEN: "ui-token"
    });

    expect(config.demoAdminToken).toBe("ui-token");
  });

  it("renders demo controls only when demo mode and token are both present", () => {
    const baseConfig = loadOperatorUiConfig({});
    const missingTokenConfig = loadOperatorUiConfig({
      OPERATOR_DEMO_MODE: "true"
    });
    const enabledConfig = loadOperatorUiConfig({
      OPERATOR_DEMO_MODE: "true",
      OPERATOR_DEMO_ADMIN_TOKEN: "ui-token"
    });

    expect(renderOperatorUiDocument(baseConfig)).not.toContain("demo-reset-button");
    expect(renderOperatorUiDocument(missingTokenConfig)).not.toContain(
      "demo-reset-button"
    );
    expect(renderOperatorUiDocument(enabledConfig)).toContain("demo-reset-button");
    expect(renderOperatorUiDocument(enabledConfig)).toContain("ui-token");
  });
});
