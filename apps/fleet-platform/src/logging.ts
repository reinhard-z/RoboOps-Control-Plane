/** Structured log fields kept small enough for local console and future collectors. */
export type LogFields = Readonly<Record<string, unknown>>;

/** Minimal logger interface so tests can silence logs without changing app logic. */
export interface StructuredLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** JSON console logger used by the Fleet Platform API service. */
export class ConsoleStructuredLogger implements StructuredLogger {
  info(message: string, fields: LogFields = {}): void {
    writeLog("info", message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    writeLog("warn", message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    writeLog("error", message, fields);
  }
}

/** No-op logger useful for deterministic tests. */
export class SilentStructuredLogger implements StructuredLogger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

/** Emits one structured log line with a consistent top-level shape. */
function writeLog(level: string, message: string, fields: LogFields): void {
  console.log(
    JSON.stringify({
      level,
      message,
      time: new Date().toISOString(),
      ...fields
    })
  );
}
