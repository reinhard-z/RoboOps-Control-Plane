import type { OperatorUiConfig } from "./config.js";

/** Renders the single-page operator console shell with runtime config injected. */
export function renderOperatorUiDocument(config: OperatorUiConfig): string {
  const browserConfig = {
    apiBaseUrl: config.apiBaseUrl,
    robotId: config.robotId,
    pollIntervalMs: config.pollIntervalMs,
    ...(demoControlsEnabled(config)
      ? { demo: { adminToken: config.demoAdminToken } }
      : {})
  };

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>RoboOps Operator Console</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <div class="app-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">RoboOps MVP</p>
          <h1>Operator Console</h1>
        </div>
        <div class="topbar-status" aria-live="polite">
          <span id="stream-dot" class="dot tone-neutral"></span>
          <span id="stream-label">Connecting</span>
          <span id="api-label" class="api-label"></span>
        </div>
      </header>

      <main class="console-grid">
        <section class="panel robot-panel" aria-labelledby="robot-heading">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Robot</p>
              <h2 id="robot-heading">robot-a</h2>
            </div>
            <span id="robot-connection" class="status-pill tone-neutral">UNKNOWN</span>
          </div>
          <dl class="metric-grid">
            <div>
              <dt>Health</dt>
              <dd><span id="robot-health" class="status-pill tone-neutral">unknown</span></dd>
            </div>
            <div>
              <dt>Battery</dt>
              <dd id="robot-battery">unknown</dd>
            </div>
            <div>
              <dt>Last telemetry</dt>
              <dd>
                <span id="robot-telemetry-age">never</span>
                <small id="robot-telemetry-time"></small>
              </dd>
            </div>
            <div>
              <dt>Edge agent</dt>
              <dd id="robot-agent">unknown</dd>
            </div>
          </dl>
        </section>

        <section class="panel command-panel" aria-labelledby="command-heading">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Command</p>
              <h2 id="command-heading">GO_TO_POSE</h2>
            </div>
          </div>
          <form id="mission-form" class="pose-form">
            <label>
              <span>X</span>
              <input id="target-x" type="number" step="0.1" value="2">
            </label>
            <label>
              <span>Y</span>
              <input id="target-y" type="number" step="0.1" value="4.5">
            </label>
            <label>
              <span>Theta</span>
              <input id="target-theta" type="number" step="0.01" value="1.57">
            </label>
            <button id="create-mission-button" type="submit">Create Mission</button>
          </form>
          <button id="cancel-mission-button" class="secondary-button" type="button" disabled>
            Cancel Mission
          </button>
          ${demoControlsEnabled(config) ? renderDemoControls() : ""}
          <p id="action-message" class="action-message" role="status"></p>
        </section>

        <section class="panel missions-panel" aria-labelledby="missions-heading">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Missions</p>
              <h2 id="missions-heading">Mission List</h2>
            </div>
          </div>
          <div id="mission-list" class="mission-list"></div>
        </section>

        <section class="panel mission-detail-panel" aria-labelledby="mission-detail-heading">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Selected</p>
              <h2 id="mission-detail-heading">Mission Details</h2>
            </div>
          </div>
          <dl class="detail-grid">
            <div class="detail-wide">
              <dt>Mission ID</dt>
              <dd id="mission-id" class="detail-code">none</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>
                <span id="mission-state" class="status-pill tone-neutral">none</span>
                <small id="mission-state-detail">No mission selected</small>
              </dd>
            </div>
            <div>
              <dt>Lifecycle</dt>
              <dd><span id="mission-lifecycle" class="status-pill tone-neutral">none</span></dd>
            </div>
            <div>
              <dt>Operational</dt>
              <dd><span id="mission-operational" class="status-pill tone-neutral">none</span></dd>
            </div>
            <div>
              <dt>Current command</dt>
              <dd id="mission-command" class="detail-code">none</dd>
            </div>
            <div>
              <dt>Acked command</dt>
              <dd id="mission-ack" class="detail-code">none</dd>
            </div>
            <div class="detail-wide">
              <dt>Reason</dt>
              <dd id="mission-reason">none</dd>
            </div>
          </dl>
        </section>

        <section class="panel event-panel" aria-labelledby="event-heading">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Live Feed</p>
              <h2 id="event-heading">Events</h2>
            </div>
          </div>
          <ol id="event-feed" class="event-feed"></ol>
        </section>
      </main>
    </div>
    <script>
      window.__ROBOOPS_OPERATOR_CONFIG__ = ${safeJson(browserConfig)};
    </script>
    <script type="module" src="/assets/client.js"></script>
  </body>
</html>`;
}

/** Returns true only when the local UI has enough config to call demo admin endpoints. */
function demoControlsEnabled(
  config: OperatorUiConfig
): config is OperatorUiConfig & { readonly demoAdminToken: string } {
  return config.demoMode && Boolean(config.demoAdminToken);
}

/** Renders local-only controls for resetting and steering the incident demo. */
function renderDemoControls(): string {
  return `<div class="demo-controls" aria-label="Demo controls">
            <p class="demo-controls-title">Demo</p>
            <button id="demo-reset-button" class="secondary-button" type="button">
              Reset State
            </button>
            <button id="demo-start-button" type="button">
              Start Clean Mission
            </button>
            <button id="demo-stale-button" class="secondary-button" type="button">
              Mark Stale
            </button>
            <button id="demo-reconnect-button" class="secondary-button" type="button">
              Reconnect
            </button>
          </div>`;
}

/** Escapes JSON for safe placement inside an inline script tag. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
