import { describe, expect, it } from "vitest";
import {
  VERSION,
  resolveConfig,
  NoopTelemetry,
  ConsoleTelemetry,
  MemoryStore,
  PostgresStore,
  migrate,
  ClaudeAdapter,
  OpenAIBatchAdapter,
  StatusTracker,
  OrphanRecovery,
  CircuitBreaker,
  createNorush,
  deriveKey,
  encrypt,
  decrypt,
  maskApiKey,
} from "../index.js";

// Type-only imports to verify they are exported
import type {
  NorushId,
  BatchId,
  ResultId,
  ProviderName,
  RequestStatus,
  BatchStatus,
  DeliveryStatus,
  ProviderBatchRef,
  NewRequest,
  Request as _Request,
  NorushRequest,
  NewBatch,
  Batch as _Batch,
  NewResult,
  Result as _Result,
  NorushResult,
  PollContext,
  DateRange,
  UsageStats,
  HealthScore,
  Provider,
  Store as _Store,
  PollingStrategy,
  TelemetryHook,
  BatchingConfig,
  PollingConfig,
  ProviderKeyConfig,
  EnvConfig,
  OperatorConfig,
  UserConfig,
  ResolvedConfig,
  ClaudeAdapterOptions,
  OpenAIBatchAdapterOptions,
  StatusTrackerEventName,
  StatusTrackerEventHandler,
  OrphanRecoveryResult,
  CircuitBreakerState,
  CircuitBreakerSnapshot,
  NorushConfig,
  NorushEngine as _NorushEngine,
  NorushEventName,
  NorushEventHandler,
  EncryptedPayload,
} from "../index.js";

describe("@norush/core exports", () => {
  it("exports VERSION", () => {
    expect(VERSION).toBe("0.0.0");
  });

  it("exports resolveConfig function", () => {
    expect(typeof resolveConfig).toBe("function");
  });

  it("exports NoopTelemetry class", () => {
    const t = new NoopTelemetry();
    expect(t).toBeInstanceOf(NoopTelemetry);
  });

  it("exports ConsoleTelemetry class", () => {
    const t = new ConsoleTelemetry();
    expect(t).toBeInstanceOf(ConsoleTelemetry);
  });

  it("exports MemoryStore class", () => {
    const s = new MemoryStore();
    expect(s).toBeInstanceOf(MemoryStore);
  });

  it("exports PostgresStore class", () => {
    expect(PostgresStore).toBeDefined();
    expect(typeof PostgresStore).toBe("function");
  });

  it("exports migrate function", () => {
    expect(typeof migrate).toBe("function");
  });

  it("exports ClaudeAdapter class", () => {
    expect(ClaudeAdapter).toBeDefined();
    expect(typeof ClaudeAdapter).toBe("function");
  });

  it("exports OpenAIBatchAdapter class", () => {
    expect(OpenAIBatchAdapter).toBeDefined();
    expect(typeof OpenAIBatchAdapter).toBe("function");
  });

  it("exports StatusTracker class", () => {
    expect(StatusTracker).toBeDefined();
    expect(typeof StatusTracker).toBe("function");
  });

  it("exports OrphanRecovery class", () => {
    expect(OrphanRecovery).toBeDefined();
    expect(typeof OrphanRecovery).toBe("function");
  });

  it("exports CircuitBreaker class", () => {
    const cb = new CircuitBreaker();
    expect(cb).toBeInstanceOf(CircuitBreaker);
    expect(cb.state).toBe("closed");
  });

  it("exports createNorush factory function", () => {
    expect(typeof createNorush).toBe("function");
  });

  it("exports crypto vault functions", () => {
    expect(typeof deriveKey).toBe("function");
    expect(typeof encrypt).toBe("function");
    expect(typeof decrypt).toBe("function");
    expect(typeof maskApiKey).toBe("function");
  });

  // Type-level assertions — these verify that all type exports compile.
  // They don't execute meaningful runtime checks; the test passing means
  // the types resolved correctly during compilation.
  it("type exports compile correctly", () => {
    // Verify type aliases are usable
    const _id: NorushId = "01ABC";
    const _batchId: BatchId = "01DEF";
    const _resultId: ResultId = "01GHI";
    const _provider: ProviderName = "claude";
    const _reqStatus: RequestStatus = "queued";
    const _batchStatus: BatchStatus = "pending";
    const _deliveryStatus: DeliveryStatus = "delivered";

    // Verify interface types are usable
    const _ref: ProviderBatchRef = {
      providerBatchId: "x",
      provider: "openai",
    };
    const _pollCtx: PollContext = {
      batchId: "b",
      provider: "claude",
      submittedAt: new Date(),
      lastPolledAt: null,
      pollCount: 0,
      expiresAt: new Date(),
    };
    const _dateRange: DateRange = { from: new Date(), to: new Date() };
    const _health: HealthScore = { factor: 1.0, reason: "healthy" };
    const _stats: UsageStats = {
      totalRequests: 0,
      succeededRequests: 0,
      failedRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalBatches: 0,
    };

    // Verify config types are usable
    const _batchCfg: BatchingConfig = {
      maxRequests: 100,
      maxBytes: 1_000_000,
      flushIntervalMs: 60_000,
    };
    const _pollCfg: PollingConfig = { intervalMs: 30_000, maxRetries: 3 };
    const _keyCfg: ProviderKeyConfig = { apiKey: "sk-test" };
    const _envCfg: EnvConfig = {};
    const _opCfg: OperatorConfig = {};
    const _userCfg: UserConfig = {};
    const _resolved: ResolvedConfig = resolveConfig();

    const _claudeOpts: ClaudeAdapterOptions = { apiKey: "sk-test" };
    const _openaiOpts: OpenAIBatchAdapterOptions = { apiKey: "sk-test" };
    const _cbState: CircuitBreakerState = "closed";
    const _cbSnapshot: CircuitBreakerSnapshot = {
      state: "closed",
      consecutiveFailures: 0,
      lastFailureAt: null,
      lastTrippedAt: null,
    };
    const _eventName: StatusTrackerEventName = "batch:completed";
    const _eventHandler: StatusTrackerEventHandler = () => {};
    const _orphanResult: OrphanRecoveryResult = { recovered: 0, failed: 0 };
    const _norushEventName: NorushEventName = "batch:completed";
    const _norushEventHandler: NorushEventHandler = () => {};
    const _norushConfig: NorushConfig = {
      store: new MemoryStore(),
      providers: new Map(),
    };

    // Use variables to avoid unused-variable lint errors
    expect(_claudeOpts).toBeDefined();
    expect(_openaiOpts).toBeDefined();
    expect(_cbState).toBeDefined();
    expect(_cbSnapshot).toBeDefined();
    expect(_eventName).toBeDefined();
    expect(_eventHandler).toBeDefined();
    expect(_orphanResult).toBeDefined();
    expect(_norushEventName).toBeDefined();
    expect(_norushEventHandler).toBeDefined();
    const _encPayload: EncryptedPayload = { blob: Buffer.alloc(0) };
    expect(_norushConfig).toBeDefined();
    expect(_encPayload).toBeDefined();
    expect(_id).toBeDefined();
    expect(_batchId).toBeDefined();
    expect(_resultId).toBeDefined();
    expect(_provider).toBeDefined();
    expect(_reqStatus).toBeDefined();
    expect(_batchStatus).toBeDefined();
    expect(_deliveryStatus).toBeDefined();
    expect(_ref).toBeDefined();
    expect(_pollCtx).toBeDefined();
    expect(_dateRange).toBeDefined();
    expect(_health).toBeDefined();
    expect(_stats).toBeDefined();
    expect(_batchCfg).toBeDefined();
    expect(_pollCfg).toBeDefined();
    expect(_keyCfg).toBeDefined();
    expect(_envCfg).toBeDefined();
    expect(_opCfg).toBeDefined();
    expect(_userCfg).toBeDefined();
    expect(_resolved).toBeDefined();
  });

  // These types are interfaces — we verify they exist as types by
  // creating compatible objects. This is a compile-time check.
  it("interface types are assignable", () => {
    // NewRequest
    const _newReq: NewRequest = {
      provider: "claude",
      model: "claude-sonnet-4-6",
      params: { messages: [] },
      userId: "user1",
    };

    // NewBatch
    const _newBatch: NewBatch = {
      provider: "openai",
      apiKeyId: "key1",
      requestCount: 10,
    };

    // NewResult
    const _newResult: NewResult = {
      requestId: "req1",
      batchId: "batch1",
      response: { content: "hello" },
    };

    // NorushRequest
    const _norushReq: NorushRequest = {
      id: "req1",
      externalId: "ext1",
      provider: "claude",
      model: "claude-sonnet-4-6",
      params: {},
    };

    // NorushResult
    const _norushResult: NorushResult = {
      requestId: "req1",
      response: {},
      success: true,
    };

    expect(_newReq).toBeDefined();
    expect(_newBatch).toBeDefined();
    expect(_newResult).toBeDefined();
    expect(_norushReq).toBeDefined();
    expect(_norushResult).toBeDefined();

    // Verify Provider, Store, PollingStrategy, TelemetryHook types exist
    // by assigning NoopTelemetry to TelemetryHook
    const _hook: TelemetryHook = new NoopTelemetry();
    expect(_hook).toBeDefined();

    // PollingStrategy type check
    const _strategy: PollingStrategy = {
      nextInterval: () => 60_000,
    };
    expect(_strategy).toBeDefined();

    // Provider type check (minimal mock)
    const _prov: Provider = {
      submitBatch: async () => ({ providerBatchId: "x", provider: "claude" }),
      checkStatus: async () => "processing",
      fetchResults: async function* () {
        /* empty */
      },
      cancelBatch: async () => {},
    };
    expect(_prov).toBeDefined();
  });
});
