import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@roboops/fleet-domain": fromRoot("./packages/fleet-domain/src/index.ts"),
      "@roboops/fleet-persistence": fromRoot(
        "./packages/fleet-persistence/src/index.ts"
      ),
      "@roboops/fleet-protocol": fromRoot("./packages/fleet-protocol/src/index.ts"),
      "@roboops/observability": fromRoot("./packages/observability/src/index.ts"),
      "@roboops/test-support": fromRoot("./packages/test-support/src/index.ts")
    }
  }
});
