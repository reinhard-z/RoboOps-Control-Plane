/** Structured log fields kept JSON-compatible for local logs and future collectors. */
export type LogFields = Readonly<Record<string, unknown>>;

/** Minimal logger interface used by apps without depending on a logging library. */
export interface StructuredLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** JSON console logger for local processes and simple hosted demos. */
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

/** No-op logger useful for deterministic unit tests and embedded callers. */
export class SilentStructuredLogger implements StructuredLogger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

/** Correlation fields propagated through logs, commands, and responses. */
export interface TraceContext {
  readonly correlationId: string;
  readonly causationId?: string;
}

/** Header map shape shared by Node HTTP requests and test doubles. */
export type HeaderMap = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/** Prometheus exposition content type for text format version 0.0.4. */
export const prometheusTextContentType =
  "text/plain; version=0.0.4; charset=utf-8";

const maxLabelValueLength = 80;

/** Returns a safe correlation id from headers without logging arbitrary input. */
export function readCorrelationIdHeader(
  headers: HeaderMap,
  headerName = "x-correlation-id"
): string | undefined {
  const value = headers[headerName] ?? headers[headerName.toLowerCase()];
  const firstValue = Array.isArray(value) ? value[0] : value;
  return normalizeTraceId(firstValue);
}

/** Keeps trace identifiers useful while rejecting values that look like payload text. */
export function normalizeTraceId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(normalized)) {
    return normalized;
  }
  return undefined;
}

/** Projects trace context into structured log fields without copying request data. */
export function traceLogFields(context: TraceContext): LogFields {
  return {
    correlationId: context.correlationId,
    ...(context.causationId ? { causationId: context.causationId } : {})
  };
}

/** Classifies unknown errors without exposing raw messages or connection data. */
export function classifyErrorType(error: unknown): string {
  if (error instanceof Error) {
    const safeName = normalizeErrorName(error.name);
    return safeName ?? "Error";
  }
  return typeof error;
}

/** Metric label values are sanitized and length-bounded before exposition. */
export function sanitizeMetricLabelValue(value: unknown): string {
  const raw = String(value ?? "unknown");
  const withoutSecrets = raw
    .replaceAll(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/g, "[redacted-url]")
    .replaceAll(
      /\b(password|passwd|pwd|user|username)=([^\s"'<>]+)/gi,
      "$1=[redacted]"
    )
    .replaceAll(/[\r\n\t]/g, " ")
    .replaceAll(/\s{2,}/g, " ")
    .trim();
  const fallback = withoutSecrets.length > 0 ? withoutSecrets : "unknown";
  if (fallback.length <= maxLabelValueLength) {
    return fallback;
  }
  return `${fallback.slice(0, maxLabelValueLength - 3)}...`;
}

/** Registry for dependency-free counters exposed in Prometheus text format. */
export class MetricsRegistry {
  private readonly counters = new Map<string, CounterMetric>();

  counter(definition: CounterDefinition): CounterMetric {
    const existing = this.counters.get(definition.name);
    if (existing) {
      existing.assertCompatible(definition);
      return existing;
    }

    const counter = new CounterMetric(definition);
    this.counters.set(definition.name, counter);
    return counter;
  }

  renderPrometheusText(): string {
    const sections = [...this.counters.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((counter) => counter.renderPrometheusText());
    return `${sections.join("\n")}${sections.length > 0 ? "\n" : ""}`;
  }
}

/** Prometheus counter metadata; label names define the only accepted labels. */
export interface CounterDefinition {
  readonly name: string;
  readonly help: string;
  readonly labelNames?: readonly string[];
}

/** Monotonic counter with bounded, declared label names. */
export class CounterMetric {
  private readonly values = new Map<string, number>();
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];

  constructor(definition: CounterDefinition) {
    this.name = requireMetricName(definition.name);
    this.help = definition.help;
    this.labelNames = (definition.labelNames ?? []).map(requireLabelName);
  }

  increment(labels: Readonly<Record<string, unknown>> = {}, value = 1): void {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("counter increment must be a positive finite number");
    }

    const key = this.labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  /** Guards shared registries against accidentally reusing a name differently. */
  assertCompatible(definition: CounterDefinition): void {
    const nextLabelNames = definition.labelNames ?? [];
    if (
      this.help !== definition.help ||
      this.labelNames.length !== nextLabelNames.length ||
      this.labelNames.some((labelName, index) => labelName !== nextLabelNames[index])
    ) {
      throw new Error(`metric ${this.name} is already registered differently`);
    }
  }

  renderPrometheusText(): string {
    const lines = [
      `# HELP ${this.name} ${escapeHelpText(this.help)}`,
      `# TYPE ${this.name} counter`
    ];
    const samples = [...this.values.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    );
    for (const [key, value] of samples) {
      lines.push(`${this.name}${key} ${formatMetricValue(value)}`);
    }
    return lines.join("\n");
  }

  /** Builds the label set in declaration order and drops undeclared labels. */
  private labelKey(labels: Readonly<Record<string, unknown>>): string {
    if (this.labelNames.length === 0) {
      return "";
    }
    const labelPairs = this.labelNames.map((labelName) => {
      const value = sanitizeMetricLabelValue(labels[labelName]);
      return `${labelName}="${escapeLabelValue(value)}"`;
    });
    return `{${labelPairs.join(",")}}`;
  }
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

/** Enforces Prometheus metric naming before names reach rendered output. */
function requireMetricName(name: string): string {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) {
    throw new Error(`invalid metric name ${name}`);
  }
  return name;
}

/** Enforces Prometheus label naming before labels reach rendered output. */
function requireLabelName(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`invalid label name ${name}`);
  }
  return name;
}

/** Keeps error type labels useful while rejecting payload-like values. */
function normalizeErrorName(name: string): string | undefined {
  if (/^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(name)) {
    return name;
  }
  return undefined;
}

/** Escapes label values using the Prometheus text exposition rules. */
function escapeLabelValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

/** Escapes help text so comments remain single-line and parseable. */
function escapeHelpText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

/** Keeps integer counters compact while preserving decimal increments if used. */
function formatMetricValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}
