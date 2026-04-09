import { describe, expect, it, vi } from "vitest";
import { ConsoleTelemetry } from "../telemetry/console.js";
import { NoopTelemetry } from "../telemetry/noop.js";

describe("NoopTelemetry", () => {
  it("implements TelemetryHook without throwing", () => {
    const telemetry = new NoopTelemetry();

    // All methods should be callable without error
    expect(() => telemetry.counter("test", 1)).not.toThrow();
    expect(() => telemetry.counter("test", 1, { env: "test" })).not.toThrow();
    expect(() => telemetry.histogram("test", 42)).not.toThrow();
    expect(() =>
      telemetry.histogram("test", 42, { env: "test" }),
    ).not.toThrow();
    expect(() => telemetry.event("test")).not.toThrow();
    expect(() => telemetry.event("test", { key: "value" })).not.toThrow();
  });

  it("does not log anything", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const telemetry = new NoopTelemetry();

    telemetry.counter("test", 1);
    telemetry.histogram("test", 42);
    telemetry.event("test");

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("ConsoleTelemetry", () => {
  it("logs counter with [norush] prefix", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const telemetry = new ConsoleTelemetry();

    telemetry.counter("requests_queued", 5);

    expect(spy).toHaveBeenCalledWith(
      "[norush] counter requests_queued=5",
    );
    spy.mockRestore();
  });

  it("logs counter with tags", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const telemetry = new ConsoleTelemetry();

    telemetry.counter("requests_queued", 5, {
      provider: "claude",
      model: "claude-sonnet-4-6",
    });

    expect(spy).toHaveBeenCalledWith(
      "[norush] counter requests_queued=5 {provider=claude,model=claude-sonnet-4-6}",
    );
    spy.mockRestore();
  });

  it("logs histogram with [norush] prefix", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const telemetry = new ConsoleTelemetry();

    telemetry.histogram("batch_turnaround_ms", 12345);

    expect(spy).toHaveBeenCalledWith(
      "[norush] histogram batch_turnaround_ms=12345",
    );
    spy.mockRestore();
  });

  it("logs histogram with tags", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const telemetry = new ConsoleTelemetry();

    telemetry.histogram("batch_turnaround_ms", 500, { provider: "openai" });

    expect(spy).toHaveBeenCalledWith(
      "[norush] histogram batch_turnaround_ms=500 {provider=openai}",
    );
    spy.mockRestore();
  });

  it("logs event with [norush] prefix", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const telemetry = new ConsoleTelemetry();

    telemetry.event("circuit_breaker_tripped");

    expect(spy).toHaveBeenCalledWith(
      "[norush] event circuit_breaker_tripped",
    );
    spy.mockRestore();
  });

  it("logs event with data payload", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const telemetry = new ConsoleTelemetry();

    telemetry.event("batch_submitted", { batchId: "abc123", count: 42 });

    expect(spy).toHaveBeenCalledWith(
      '[norush] event batch_submitted {"batchId":"abc123","count":42}',
    );
    spy.mockRestore();
  });

  it("logs counter without tags when tags are empty", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const telemetry = new ConsoleTelemetry();

    telemetry.counter("test", 1, {});

    expect(spy).toHaveBeenCalledWith("[norush] counter test=1");
    spy.mockRestore();
  });
});
