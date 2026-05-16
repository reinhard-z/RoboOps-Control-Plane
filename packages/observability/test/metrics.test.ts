import { describe, expect, it } from "vitest";

import {
  MetricsRegistry,
  readCorrelationIdHeader,
  sanitizeMetricLabelValue
} from "../src/index.js";

describe("observability metrics registry", () => {
  it("renders counters in Prometheus text format", () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter({
      name: "roboops_test_requests_total",
      help: "Requests handled by the test.",
      labelNames: ["method", "route"]
    });

    counter.increment({ method: "GET", route: "/metrics" });
    counter.increment({ method: "GET", route: "/metrics" }, 2);

    expect(registry.renderPrometheusText()).toBe(
      [
        "# HELP roboops_test_requests_total Requests handled by the test.",
        "# TYPE roboops_test_requests_total counter",
        'roboops_test_requests_total{method="GET",route="/metrics"} 3',
        ""
      ].join("\n")
    );
  });

  it("drops undeclared labels and sanitizes bounded label values", () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter({
      name: "roboops_test_failures_total",
      help: "Failures with safe labels.",
      labelNames: ["error_type"]
    });

    counter.increment({
      error_type:
        "DriverError postgres://user:secret@127.0.0.1:55432/roboops_control_plane with a very long diagnostic payload that should be truncated",
      raw_error: "must not be rendered"
    });

    const text = registry.renderPrometheusText();
    expect(text).toContain('error_type="DriverError [redacted-url] with a very long diagnostic payload that should be..."');
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("raw_error");
    expect(text).not.toContain("must not be rendered");
  });

  it("normalizes correlation IDs from headers", () => {
    expect(
      readCorrelationIdHeader({ "x-correlation-id": " corr-incident:123 " })
    ).toBe("corr-incident:123");
    expect(
      readCorrelationIdHeader({
        "x-correlation-id": "raw body { password: secret }"
      })
    ).toBeUndefined();
  });

  it("sanitizes metric label values before rendering", () => {
    expect(
      sanitizeMetricLabelValue(
        "connection failed postgres://user:password@localhost/db\npassword=secret"
      )
    ).toBe("connection failed [redacted-url] password=[redacted]");
  });
});
