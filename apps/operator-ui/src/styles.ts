/** CSS for the practical, dashboard-style Operator UI. */
export const operatorUiStyles = `
:root {
  color-scheme: light;
  --bg: #f4f6f8;
  --surface: #ffffff;
  --surface-subtle: #eef2f6;
  --border: #d6dde5;
  --text: #18212f;
  --muted: #617086;
  --online-bg: #dff7e8;
  --online-text: #0d6b3a;
  --stale-bg: #fff4c7;
  --stale-text: #7a5200;
  --degraded-bg: #ffe3cb;
  --degraded-text: #9a3d00;
  --offline-bg: #e4e7eb;
  --offline-text: #334155;
  --reconnecting-bg: #dbeafe;
  --reconnecting-text: #1d4ed8;
  --danger-bg: #fee2e2;
  --danger-text: #b91c1c;
  --focus: #2563eb;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
}

button,
input {
  font: inherit;
}

button {
  min-height: 42px;
  border: 1px solid #1e4ed8;
  border-radius: 8px;
  background: #2563eb;
  color: #ffffff;
  cursor: pointer;
  font-weight: 700;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

button:hover:not(:disabled) {
  background: #1d4ed8;
}

.secondary-button {
  width: 100%;
  margin-top: 10px;
  border-color: #b91c1c;
  background: #ffffff;
  color: #b91c1c;
}

.secondary-button:hover:not(:disabled) {
  background: #fee2e2;
}

.demo-controls .secondary-button {
  margin-top: 0;
  border-color: var(--border);
  color: var(--text);
}

.demo-controls .secondary-button:hover:not(:disabled) {
  background: var(--surface-subtle);
}

.app-shell {
  min-height: 100vh;
  padding: 20px;
}

.topbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  max-width: 1400px;
  margin: 0 auto 18px;
}

.topbar h1,
.panel h2 {
  margin: 0;
  line-height: 1.1;
  letter-spacing: 0;
}

.topbar h1 {
  font-size: 30px;
}

.panel h2 {
  font-size: 18px;
}

.eyebrow {
  margin: 0 0 5px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}

.topbar-status {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 14px;
  font-weight: 700;
  text-align: right;
}

.api-label {
  max-width: 42vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: var(--offline-text);
}

.console-grid {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) minmax(280px, 0.9fr) minmax(360px, 1.2fr);
  gap: 16px;
  max-width: 1400px;
  margin: 0 auto;
}

.panel {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  padding: 16px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.robot-panel,
.command-panel,
.mission-detail-panel {
  align-self: start;
}

.event-panel {
  grid-column: 3;
  grid-row: 1 / span 3;
  min-height: 640px;
}

.metric-grid,
.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin: 0;
}

.metric-grid div,
.detail-grid div {
  min-width: 0;
}

.detail-wide {
  grid-column: 1 / -1;
}

dt {
  margin-bottom: 4px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
}

dd {
  min-width: 0;
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.detail-code {
  font-family:
    "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 13px;
  line-height: 1.35;
  word-break: break-word;
}

dd small {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}

.status-pill {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 900;
  line-height: 1.2;
  overflow-wrap: anywhere;
  text-transform: uppercase;
}

.tone-online {
  background: var(--online-bg);
  color: var(--online-text);
}

.tone-stale {
  background: var(--stale-bg);
  color: var(--stale-text);
}

.tone-degraded {
  background: var(--degraded-bg);
  color: var(--degraded-text);
}

.tone-offline {
  background: var(--offline-bg);
  color: var(--offline-text);
}

.tone-reconnecting {
  background: var(--reconnecting-bg);
  color: var(--reconnecting-text);
}

.tone-danger {
  background: var(--danger-bg);
  color: var(--danger-text);
}

.tone-neutral {
  background: var(--surface-subtle);
  color: var(--muted);
}

.pose-form {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.pose-form label {
  display: grid;
  gap: 5px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
}

.pose-form input {
  width: 100%;
  min-height: 42px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  background: #ffffff;
  color: var(--text);
  font-weight: 700;
}

.pose-form button {
  grid-column: 1 / -1;
}

.action-message {
  min-height: 20px;
  margin: 12px 0 0;
  color: var(--muted);
  font-size: 13px;
  font-weight: 700;
}

.action-message.error {
  color: var(--danger-text);
}

.demo-controls {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}

.demo-controls-title {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
}

.mission-list {
  display: grid;
  gap: 8px;
}

.mission-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
  width: 100%;
  min-height: 62px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #ffffff;
  padding: 10px;
  color: var(--text);
  text-align: left;
}

.mission-row .status-pill {
  justify-self: end;
  max-width: 150px;
}

.mission-row:hover,
.mission-row.selected {
  border-color: var(--focus);
  background: #f8fbff;
}

.mission-copy {
  display: grid;
  min-width: 0;
}

.mission-id {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 900;
}

.mission-meta {
  margin-top: 5px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
}

.mission-reason {
  margin-top: 4px;
  color: var(--degraded-text);
  font-size: 12px;
  font-weight: 800;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.empty-state {
  margin: 0;
  color: var(--muted);
  font-weight: 700;
}

.event-feed {
  display: grid;
  gap: 8px;
  max-height: 560px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}

.event-item {
  min-width: 0;
  border-left: 4px solid var(--border);
  border-radius: 6px;
  background: #fafbfc;
  padding: 10px 12px;
}

.event-item.tone-online {
  border-left-color: var(--online-text);
}

.event-item.tone-stale,
.event-item.tone-degraded {
  border-left-color: var(--degraded-text);
}

.event-item.tone-reconnecting {
  border-left-color: var(--reconnecting-text);
}

.event-item.tone-danger,
.event-item.tone-offline {
  border-left-color: var(--danger-text);
}

.event-title {
  margin: 0;
  font-size: 14px;
  font-weight: 900;
  line-height: 1.3;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.event-detail,
.event-time {
  margin: 5px 0 0;
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.35;
  overflow-wrap: anywhere;
  word-break: break-word;
}

@media (max-width: 1080px) {
  .console-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .event-panel {
    grid-column: 1 / -1;
    grid-row: auto;
    min-height: 360px;
  }
}

@media (max-width: 720px) {
  .app-shell {
    padding: 14px;
  }

  .topbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .topbar-status {
    width: 100%;
    text-align: left;
  }

  .api-label {
    max-width: 100%;
  }

  .console-grid,
  .metric-grid,
  .detail-grid {
    grid-template-columns: 1fr;
  }
}
`;
