import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadOperatorUiConfig, type OperatorUiConfig } from "./config.js";
import { renderOperatorUiDocument } from "./document.js";
import { operatorUiStyles } from "./styles.js";

/** Running Operator UI HTTP server used by CLI startup and smoke tests. */
export interface OperatorUiRuntime {
  readonly server: Server;
  readonly config: OperatorUiConfig;
}

/** Creates the local static UI server without binding a TCP port. */
export function createOperatorUiRuntime(
  config: OperatorUiConfig = loadOperatorUiConfig()
): OperatorUiRuntime {
  const server = createServer((request, response) => {
    handleHttpRequest(request, response, config).catch((error: unknown) => {
      sendText(
        response,
        500,
        `operator ui error: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  });

  return { server, config };
}

/** Starts the Operator UI HTTP server and resolves when it is listening. */
export function listenOperatorUi(runtime: OperatorUiRuntime): Promise<void> {
  return new Promise((resolve) => {
    runtime.server.listen(runtime.config.port, runtime.config.host, resolve);
  });
}

/** Routes one browser request across HTML, CSS, JS modules, and health checks. */
async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: OperatorUiConfig
): Promise<void> {
  const url = parseRequestUrl(request);
  if (!url) {
    sendText(response, 400, "request URL is required");
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "method not allowed");
    return;
  }

  if (url.pathname === "/health/live") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    sendHtml(response, renderOperatorUiDocument(config));
    return;
  }

  if (url.pathname === "/styles.css") {
    sendCss(response, operatorUiStyles);
    return;
  }

  if (url.pathname.startsWith("/assets/") && url.pathname.endsWith(".js")) {
    const source = await readClientModule(basename(url.pathname));
    if (!source) {
      sendText(response, 404, "asset not found");
      return;
    }
    sendJavaScript(response, source);
    return;
  }

  sendText(response, 404, "not found");
}

/** Reads built JS modules, or transpiles TS modules for the lightweight dev server. */
async function readClientModule(assetName: string): Promise<string | undefined> {
  if (!/^[a-z-]+\.js$/u.test(assetName)) {
    return undefined;
  }

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const builtPath = join(currentDir, assetName);
  if (existsSync(builtPath)) {
    return readFile(builtPath, "utf8");
  }

  const sourcePath = join(currentDir, assetName.replace(/\.js$/u, ".ts"));
  if (!existsSync(sourcePath)) {
    return undefined;
  }

  const source = await readFile(sourcePath, "utf8");
  const ts = await import("typescript");
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
}

/** Sends an HTML response. */
function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8"
  });
  response.end(body);
}

/** Sends a CSS response. */
function sendCss(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/css; charset=utf-8"
  });
  response.end(body);
}

/** Sends a browser JavaScript module response. */
function sendJavaScript(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/javascript; charset=utf-8"
  });
  response.end(body);
}

/** Sends a JSON response for health probes. */
function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

/** Sends a plain text error response. */
function sendText(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8"
  });
  response.end(body);
}

/** Parses URL safely for Node HTTP request paths. */
function parseRequestUrl(request: IncomingMessage): URL | undefined {
  if (!request.url) {
    return undefined;
  }
  return new URL(request.url, "http://localhost");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runtime = createOperatorUiRuntime();
  await listenOperatorUi(runtime);
  console.log(
    JSON.stringify({
      level: "info",
      message: "operator ui listening",
      url: `http://${runtime.config.host}:${runtime.config.port}`,
      apiBaseUrl: runtime.config.apiBaseUrl,
      robotId: runtime.config.robotId
    })
  );
}
