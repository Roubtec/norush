import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import { BatchManager, PROVIDER_LIMITS, type KeyResolver } from '../../engine/batch-manager.js';
import type { BatchingConfig } from '../../config/types.js';
import type { Provider } from '../../interfaces/provider.js';
import type { NewRequest, NorushRequest, ProviderBatchRef } from '../../types.js';
import type { ApiKeyInfo } from '../../keys/selector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNewRequest(overrides: Partial<NewRequest> = {}): NewRequest {
  return {
    provider: 'claude',
    model: 'claude-sonnet-4-5-20250929',
    params: {
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
    },
    userId: 'user_01',
    ...overrides,
  };
}

function defaultBatching(overrides: Partial<BatchingConfig> = {}): BatchingConfig {
  return {
    maxRequests: 1000,
    maxBytes: 50_000_000,
    flushIntervalMs: 0,
    ...overrides,
  };
}

function mockProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    submitBatch: vi.fn().mockResolvedValue({
      providerBatchId: 'provider_batch_001',
      provider: 'claude',
    } satisfies ProviderBatchRef),
    checkStatus: vi.fn().mockResolvedValue('processing'),
    fetchResults: vi.fn(),
    cancelBatch: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BatchManager', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  // -------------------------------------------------------------------------
  // Basic flush
  // -------------------------------------------------------------------------

  describe('flush', () => {
    it('does nothing when there are no queued requests', async () => {
      const provider = mockProvider();
      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      expect(provider.submitBatch).not.toHaveBeenCalled();
    });

    it('submits a single batch for queued requests', async () => {
      // Create some queued requests.
      await store.createRequest(makeNewRequest());
      await store.createRequest(makeNewRequest());

      const provider = mockProvider();
      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      expect(provider.submitBatch).toHaveBeenCalledOnce();
      const submitted = (provider.submitBatch as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as NorushRequest[];
      expect(submitted).toHaveLength(2);
    });

    it('creates a batch record before calling the provider', async () => {
      await store.createRequest(makeNewRequest());

      const callOrder: string[] = [];

      const provider = mockProvider({
        submitBatch: vi.fn().mockImplementation(async () => {
          callOrder.push('provider_called');
          return { providerBatchId: 'pb_001', provider: 'claude' as const };
        }),
      });

      const originalCreateBatch = store.createBatch.bind(store);
      vi.spyOn(store, 'createBatch').mockImplementation(async (...args) => {
        callOrder.push('batch_created');
        return originalCreateBatch(...args);
      });

      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      expect(callOrder).toEqual(['batch_created', 'provider_called']);
    });
  });

  // -------------------------------------------------------------------------
  // Write-before-submit protocol
  // -------------------------------------------------------------------------

  describe('write-before-submit protocol', () => {
    it("creates batch with status 'pending' before submission", async () => {
      const reqRecord = await store.createRequest(makeNewRequest());

      let batchStatusDuringSubmit: string | undefined;

      const provider = mockProvider({
        submitBatch: vi.fn().mockImplementation(async (reqs: NorushRequest[]) => {
          // Check the batch record status during provider call.
          const req = await store.getRequest(reqs[0].id);
          if (req?.batchId) {
            const batch = await store.getBatch(req.batchId);
            batchStatusDuringSubmit = batch?.status;
          }
          return { providerBatchId: 'pb_001', provider: 'claude' as const };
        }),
      });

      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      // During the provider call, the batch should still be 'pending'.
      expect(batchStatusDuringSubmit).toBe('pending');

      // After flush, the batch should be 'submitted'.
      const stored = await store.getRequest(reqRecord.id);
      expect(stored).toBeTruthy();
      expect(stored?.batchId).toBeTruthy();
      const batch = await store.getBatch(stored?.batchId ?? '');
      expect(batch).toBeTruthy();
      expect(batch?.status).toBe('submitted');
      expect(batch?.providerBatchId).toBe('pb_001');
      expect(batch?.submissionAttempts).toBe(1);
      expect(batch?.submittedAt).toBeInstanceOf(Date);
    });

    it('increments submission_attempts before calling provider', async () => {
      await store.createRequest(makeNewRequest());

      let submissionAttemptsDuringCall: number | undefined;

      const provider = mockProvider({
        submitBatch: vi.fn().mockImplementation(async (reqs: NorushRequest[]) => {
          const req = await store.getRequest(reqs[0].id);
          if (req?.batchId) {
            const batch = await store.getBatch(req.batchId);
            submissionAttemptsDuringCall = batch?.submissionAttempts;
          }
          return { providerBatchId: 'pb_002', provider: 'claude' as const };
        }),
      });

      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      expect(submissionAttemptsDuringCall).toBe(1);
    });

    it("on submission failure: requests are reverted to 'queued' and batch remains pending", async () => {
      const reqRecord = await store.createRequest(makeNewRequest());

      const provider = mockProvider({
        submitBatch: vi.fn().mockRejectedValue(new Error('API error')),
      });

      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      // Requests should be reverted to 'queued' so the next flush can retry.
      const stored = await store.getRequest(reqRecord.id);
      expect(stored).toBeTruthy();
      expect(stored?.status).toBe('queued');
      expect(stored?.batchId).toBeNull();

      // Batch record stays in 'pending' with NULL provider_batch_id for observability.
      const pendingBatches = await store.getPendingBatches();
      expect(pendingBatches).toHaveLength(1);
      expect(pendingBatches[0].status).toBe('pending');
      expect(pendingBatches[0].providerBatchId).toBeNull();
      expect(pendingBatches[0].submissionAttempts).toBe(1);
    });

    it("updates requests to 'batched' status with batch_id", async () => {
      const r1 = await store.createRequest(makeNewRequest());
      const r2 = await store.createRequest(makeNewRequest());

      const provider = mockProvider();
      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      const stored1 = await store.getRequest(r1.id);
      const stored2 = await store.getRequest(r2.id);
      expect(stored1).toBeTruthy();
      expect(stored2).toBeTruthy();
      expect(stored1?.status).toBe('batched');
      expect(stored2?.status).toBe('batched');
      expect(stored1?.batchId).toBeTruthy();
      expect(stored1?.batchId).toBe(stored2?.batchId);
    });
  });

  // -------------------------------------------------------------------------
  // Grouping logic
  // -------------------------------------------------------------------------

  describe('request grouping', () => {
    it('groups requests by (provider, model, userId)', async () => {
      // Two requests for same group.
      await store.createRequest(
        makeNewRequest({
          provider: 'claude',
          model: 'claude-sonnet-4-5-20250929',
          userId: 'user_01',
        }),
      );
      await store.createRequest(
        makeNewRequest({
          provider: 'claude',
          model: 'claude-sonnet-4-5-20250929',
          userId: 'user_01',
        }),
      );
      // One request for a different model.
      await store.createRequest(
        makeNewRequest({ provider: 'claude', model: 'claude-opus-4-6', userId: 'user_01' }),
      );

      const claudeProvider = mockProvider();
      const providers = new Map([['claude', claudeProvider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      // Should create 2 batches: one for sonnet (2 reqs), one for opus (1 req).
      expect(claudeProvider.submitBatch).toHaveBeenCalledTimes(2);

      const calls = (claudeProvider.submitBatch as ReturnType<typeof vi.fn>).mock.calls;
      const sizes = calls.map((c: unknown[]) => (c[0] as NorushRequest[]).length).sort();
      expect(sizes).toEqual([1, 2]);
    });

    it('creates separate batches for different users (key isolation)', async () => {
      await store.createRequest(makeNewRequest({ userId: 'user_A' }));
      await store.createRequest(makeNewRequest({ userId: 'user_B' }));

      const provider = mockProvider();
      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      // Two separate batches: one per user.
      expect(provider.submitBatch).toHaveBeenCalledTimes(2);
    });

    it('creates separate batches for different providers', async () => {
      await store.createRequest(makeNewRequest({ provider: 'claude', userId: 'user_01' }));
      await store.createRequest(
        makeNewRequest({ provider: 'openai', model: 'gpt-4o', userId: 'user_01' }),
      );

      const claudeProvider = mockProvider();
      const openaiProvider = mockProvider({
        submitBatch: vi.fn().mockResolvedValue({
          providerBatchId: 'oai_batch_001',
          provider: 'openai',
        }),
      });

      const providers = new Map([
        ['claude', claudeProvider],
        ['openai', openaiProvider],
      ]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      expect(claudeProvider.submitBatch).toHaveBeenCalledOnce();
      expect(openaiProvider.submitBatch).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Size-based splitting
  // -------------------------------------------------------------------------

  describe('size-based splitting', () => {
    it('splits batches that exceed provider max request count', async () => {
      // Create 5 requests (should split into 2 batches: 3 + 2).
      for (let i = 0; i < 5; i++) {
        await store.createRequest(makeNewRequest());
      }

      const provider = mockProvider();
      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching({ maxRequests: 100 }),
        providerLimits: {
          claude: { maxRequests: 3, maxBytes: 256 * 1024 * 1024 },
          openai: { maxRequests: 50_000, maxBytes: 200 * 1024 * 1024 },
        },
      });

      await manager.flush();

      expect(provider.submitBatch).toHaveBeenCalledTimes(2);

      const calls = (provider.submitBatch as ReturnType<typeof vi.fn>).mock.calls;
      const firstBatch = calls[0][0] as NorushRequest[];
      const secondBatch = calls[1][0] as NorushRequest[];
      expect(firstBatch).toHaveLength(3);
      expect(secondBatch).toHaveLength(2);
    });

    it('splits batches that exceed provider max byte size', async () => {
      // Create requests with known param sizes.
      const largeContent = 'x'.repeat(500);
      const req = makeNewRequest({
        params: { messages: [{ role: 'user', content: largeContent }] },
      });
      const reqBytes = new TextEncoder().encode(JSON.stringify(req.params)).byteLength;

      await store.createRequest(makeNewRequest({ params: req.params }));
      await store.createRequest(makeNewRequest({ params: req.params }));
      await store.createRequest(makeNewRequest({ params: req.params }));

      const provider = mockProvider();
      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching({ maxRequests: 100 }),
        // Set limit so that only 2 requests fit per batch.
        providerLimits: {
          claude: { maxRequests: 100_000, maxBytes: reqBytes * 2 + 1 },
          openai: { maxRequests: 50_000, maxBytes: 200 * 1024 * 1024 },
        },
      });

      await manager.flush();

      // Should split: 2 + 1.
      expect(provider.submitBatch).toHaveBeenCalledTimes(2);

      const calls = (provider.submitBatch as ReturnType<typeof vi.fn>).mock.calls;
      const firstBatch = calls[0][0] as NorushRequest[];
      const secondBatch = calls[1][0] as NorushRequest[];
      expect(firstBatch).toHaveLength(2);
      expect(secondBatch).toHaveLength(1);
    });

    it('skips a request whose params alone exceed the byte limit and emits telemetry', async () => {
      const req = makeNewRequest({
        params: { messages: [{ role: 'user', content: 'x'.repeat(100) }] },
      });
      const reqBytes = new TextEncoder().encode(JSON.stringify(req.params)).byteLength;

      await store.createRequest(req);

      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };
      const provider = mockProvider();
      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
        telemetry,
        // Byte limit smaller than a single request.
        providerLimits: {
          claude: { maxRequests: 100_000, maxBytes: reqBytes - 1 },
          openai: { maxRequests: 50_000, maxBytes: 200 * 1024 * 1024 },
        },
      });

      await manager.flush();

      // Oversized request must not be submitted.
      expect(provider.submitBatch).not.toHaveBeenCalled();
      expect(telemetry.event).toHaveBeenCalledWith(
        'request_oversized',
        expect.objectContaining({ reqBytes, limitBytes: reqBytes - 1 }),
      );
    });

    it('respects different limits per provider', () => {
      expect(PROVIDER_LIMITS.claude.maxRequests).toBe(100_000);
      expect(PROVIDER_LIMITS.claude.maxBytes).toBe(256 * 1024 * 1024);
      expect(PROVIDER_LIMITS.openai.maxRequests).toBe(50_000);
      expect(PROVIDER_LIMITS.openai.maxBytes).toBe(200 * 1024 * 1024);
    });
  });

  // -------------------------------------------------------------------------
  // Provider adapter resolution
  // -------------------------------------------------------------------------

  describe('provider adapter resolution', () => {
    it("resolves adapter by 'provider::userId' key first", async () => {
      await store.createRequest(makeNewRequest({ provider: 'claude', userId: 'user_01' }));

      const specificProvider = mockProvider();
      const fallbackProvider = mockProvider();

      const providers = new Map([
        ['claude::user_01', specificProvider],
        ['claude', fallbackProvider],
      ]);

      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      expect(specificProvider.submitBatch).toHaveBeenCalledOnce();
      expect(fallbackProvider.submitBatch).not.toHaveBeenCalled();
    });

    it('falls back to provider-only key when specific key not found', async () => {
      await store.createRequest(makeNewRequest({ provider: 'claude', userId: 'user_99' }));

      const fallbackProvider = mockProvider();
      const providers = new Map([['claude', fallbackProvider]]);

      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      expect(fallbackProvider.submitBatch).toHaveBeenCalledOnce();
    });

    it('skips batch when no adapter is found', async () => {
      await store.createRequest(makeNewRequest({ provider: 'openai', model: 'gpt-4o' }));

      const telemetry = {
        counter: vi.fn(),
        histogram: vi.fn(),
        event: vi.fn(),
      };

      // No openai provider registered.
      const providers = new Map([['claude', mockProvider()]]);

      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
        telemetry,
      });

      await manager.flush();

      expect(telemetry.event).toHaveBeenCalledWith(
        'batch_submit_error',
        expect.objectContaining({
          error: expect.stringContaining('No provider adapter found'),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // NorushRequest mapping
  // -------------------------------------------------------------------------

  describe('NorushRequest mapping', () => {
    it('maps Request records to NorushRequest payloads for the provider', async () => {
      const reqRecord = await store.createRequest(
        makeNewRequest({
          params: { max_tokens: 2048, messages: [{ role: 'user', content: 'test' }] },
        }),
      );

      const provider = mockProvider();
      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      const submitted = (provider.submitBatch as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as NorushRequest[];
      expect(submitted).toHaveLength(1);
      expect(submitted[0].id).toBe(reqRecord.id);
      expect(submitted[0].provider).toBe('claude');
      expect(submitted[0].model).toBe('claude-sonnet-4-5-20250929');
      expect(submitted[0].params).toEqual({
        max_tokens: 2048,
        messages: [{ role: 'user', content: 'test' }],
      });
    });
  });

  // -------------------------------------------------------------------------
  // Telemetry
  // -------------------------------------------------------------------------

  describe('telemetry', () => {
    it('emits batches_submitted counter on success', async () => {
      await store.createRequest(makeNewRequest());

      const telemetry = {
        counter: vi.fn(),
        histogram: vi.fn(),
        event: vi.fn(),
      };

      const provider = mockProvider();
      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
        telemetry,
      });

      await manager.flush();

      expect(telemetry.counter).toHaveBeenCalledWith('batches_submitted', 1, {
        provider: 'claude',
        status: 'success',
      });

      expect(telemetry.event).toHaveBeenCalledWith(
        'batch_submitted',
        expect.objectContaining({
          provider: 'claude',
          providerBatchId: 'provider_batch_001',
        }),
      );
    });

    it('emits batches_submitted counter with failure status on error', async () => {
      await store.createRequest(makeNewRequest());

      const telemetry = {
        counter: vi.fn(),
        histogram: vi.fn(),
        event: vi.fn(),
      };

      const provider = mockProvider({
        submitBatch: vi.fn().mockRejectedValue(new Error('Network timeout')),
      });

      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
        telemetry,
      });

      await manager.flush();

      expect(telemetry.counter).toHaveBeenCalledWith('batches_submitted', 1, {
        provider: 'claude',
        status: 'failure',
      });

      expect(telemetry.event).toHaveBeenCalledWith(
        'batch_submit_error',
        expect.objectContaining({
          error: 'Network timeout',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Batch record accuracy
  // -------------------------------------------------------------------------

  describe('batch record accuracy', () => {
    it('batch requestCount matches the number of requests in the batch', async () => {
      await store.createRequest(makeNewRequest());
      await store.createRequest(makeNewRequest());
      await store.createRequest(makeNewRequest());

      const provider = mockProvider();
      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      const queued = await store.getQueuedRequests(100);
      expect(queued).toHaveLength(0); // all should be 'batched' now

      // Get the batch from the submitted batches.
      const inFlight = await store.getInFlightBatches();
      expect(inFlight.length).toBeGreaterThanOrEqual(1);
      expect(inFlight[0].requestCount).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Multi-token failover
  // -------------------------------------------------------------------------

  describe('multi-token failover', () => {
    function makeKeyResolver(
      keys: ApiKeyInfo[],
      providersByKeyId: Map<string, Provider>,
    ): KeyResolver {
      return {
        getKeysForUser: vi.fn().mockResolvedValue(keys),
        buildProvider: vi.fn().mockImplementation(async (keyId: string) => {
          const p = providersByKeyId.get(keyId);
          if (!p) throw new Error(`No provider for key ${keyId}`);
          return p;
        }),
      };
    }

    function makeApiKey(overrides: Partial<ApiKeyInfo> = {}): ApiKeyInfo {
      return {
        id: 'key_01',
        provider: 'claude',
        label: 'primary',
        priority: 0,
        failoverEnabled: true,
        revokedAt: null,
        ...overrides,
      };
    }

    it('submits with the primary key when it succeeds', async () => {
      await store.createRequest(makeNewRequest({ userId: 'user_01' }));

      const primaryProvider = mockProvider();
      const backupProvider = mockProvider();

      const keys = [
        makeApiKey({ id: 'key_primary', label: 'Primary', priority: 0 }),
        makeApiKey({ id: 'key_backup', label: 'Backup', priority: 1 }),
      ];

      const providersByKeyId = new Map([
        ['key_primary', primaryProvider],
        ['key_backup', backupProvider],
      ]);

      const keyResolver = makeKeyResolver(keys, providersByKeyId);

      const manager = new BatchManager({
        store,
        providers: new Map(),
        batching: defaultBatching(),
        keyResolver,
      });

      await manager.flush();

      expect(primaryProvider.submitBatch).toHaveBeenCalledOnce();
      expect(backupProvider.submitBatch).not.toHaveBeenCalled();
    });

    it('falls back to backup key on 429 rate limit error', async () => {
      await store.createRequest(makeNewRequest({ userId: 'user_01' }));

      const primaryProvider = mockProvider({
        submitBatch: vi.fn().mockRejectedValue(new Error('HTTP 429: rate limit exceeded')),
      });
      const backupProvider = mockProvider();

      const keys = [
        makeApiKey({ id: 'key_primary', label: 'Primary', priority: 0 }),
        makeApiKey({ id: 'key_backup', label: 'Backup', priority: 1 }),
      ];

      const providersByKeyId = new Map([
        ['key_primary', primaryProvider],
        ['key_backup', backupProvider],
      ]);

      const keyResolver = makeKeyResolver(keys, providersByKeyId);

      const manager = new BatchManager({
        store,
        providers: new Map(),
        batching: defaultBatching(),
        keyResolver,
      });

      await manager.flush();

      expect(primaryProvider.submitBatch).toHaveBeenCalledOnce();
      expect(backupProvider.submitBatch).toHaveBeenCalledOnce();
    });

    it('falls back to backup key on credit exhaustion error', async () => {
      await store.createRequest(makeNewRequest({ userId: 'user_01' }));

      const primaryProvider = mockProvider({
        submitBatch: vi.fn().mockRejectedValue(new Error('Insufficient credit balance')),
      });
      const backupProvider = mockProvider();

      const keys = [
        makeApiKey({ id: 'key_primary', label: 'Primary', priority: 0 }),
        makeApiKey({ id: 'key_backup', label: 'Backup', priority: 1 }),
      ];

      const providersByKeyId = new Map([
        ['key_primary', primaryProvider],
        ['key_backup', backupProvider],
      ]);

      const keyResolver = makeKeyResolver(keys, providersByKeyId);

      const manager = new BatchManager({
        store,
        providers: new Map(),
        batching: defaultBatching(),
        keyResolver,
      });

      await manager.flush();

      expect(primaryProvider.submitBatch).toHaveBeenCalledOnce();
      expect(backupProvider.submitBatch).toHaveBeenCalledOnce();
    });

    it('does NOT failover on non-rate-limit errors (e.g., network)', async () => {
      const reqRecord = await store.createRequest(makeNewRequest({ userId: 'user_01' }));

      const primaryProvider = mockProvider({
        submitBatch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      });
      const backupProvider = mockProvider();

      const keys = [
        makeApiKey({ id: 'key_primary', label: 'Primary', priority: 0 }),
        makeApiKey({ id: 'key_backup', label: 'Backup', priority: 1 }),
      ];

      const providersByKeyId = new Map([
        ['key_primary', primaryProvider],
        ['key_backup', backupProvider],
      ]);

      const keyResolver = makeKeyResolver(keys, providersByKeyId);

      const manager = new BatchManager({
        store,
        providers: new Map(),
        batching: defaultBatching(),
        keyResolver,
      });

      await manager.flush();

      expect(primaryProvider.submitBatch).toHaveBeenCalledOnce();
      expect(backupProvider.submitBatch).not.toHaveBeenCalled();

      // For non-failover errors, requests should remain 'batched' (not reset to
      // queued) so that orphan recovery can reconcile without risking a duplicate
      // submission (the provider may have accepted the batch before the error).
      const stored = await store.getRequest(reqRecord.id);
      expect(stored?.status).toBe('batched');
      expect(stored?.batchId).not.toBeNull();

      // The batch should remain 'pending' for orphan recovery, not 'failed'.
      const pendingBatches = await store.getPendingBatches();
      expect(pendingBatches).toHaveLength(1);
    });

    it('records the key used on the batch record', async () => {
      await store.createRequest(makeNewRequest({ userId: 'user_01' }));

      const primaryProvider = mockProvider();

      const keys = [makeApiKey({ id: 'key_primary', label: 'Production Key', priority: 0 })];

      const providersByKeyId = new Map([['key_primary', primaryProvider]]);

      const keyResolver = makeKeyResolver(keys, providersByKeyId);

      const manager = new BatchManager({
        store,
        providers: new Map(),
        batching: defaultBatching(),
        keyResolver,
      });

      await manager.flush();

      const inFlight = await store.getInFlightBatches();
      expect(inFlight).toHaveLength(1);
      expect(inFlight[0].apiKeyId).toBe('key_primary');
      expect(inFlight[0].apiKeyLabel).toBe('Production Key');
    });

    it('records the fallback key on the batch record when primary fails', async () => {
      await store.createRequest(makeNewRequest({ userId: 'user_01' }));

      const primaryProvider = mockProvider({
        submitBatch: vi.fn().mockRejectedValue(new Error('429 rate limit')),
      });
      const backupProvider = mockProvider();

      const keys = [
        makeApiKey({ id: 'key_primary', label: 'Primary', priority: 0 }),
        makeApiKey({ id: 'key_backup', label: 'Backup', priority: 1 }),
      ];

      const providersByKeyId = new Map([
        ['key_primary', primaryProvider],
        ['key_backup', backupProvider],
      ]);

      const keyResolver = makeKeyResolver(keys, providersByKeyId);

      const manager = new BatchManager({
        store,
        providers: new Map(),
        batching: defaultBatching(),
        keyResolver,
      });

      await manager.flush();

      const inFlight = await store.getInFlightBatches();
      expect(inFlight).toHaveLength(1);
      expect(inFlight[0].apiKeyId).toBe('key_backup');
      expect(inFlight[0].apiKeyLabel).toBe('Backup');
    });

    it('handles all keys exhausted gracefully', async () => {
      const reqRecord = await store.createRequest(makeNewRequest({ userId: 'user_01' }));

      const primaryProvider = mockProvider({
        submitBatch: vi.fn().mockRejectedValue(new Error('429 rate limit')),
      });
      const backupProvider = mockProvider({
        submitBatch: vi.fn().mockRejectedValue(new Error('Quota exceeded')),
      });

      const keys = [
        makeApiKey({ id: 'key_primary', label: 'Primary', priority: 0 }),
        makeApiKey({ id: 'key_backup', label: 'Backup', priority: 1 }),
      ];

      const providersByKeyId = new Map([
        ['key_primary', primaryProvider],
        ['key_backup', backupProvider],
      ]);

      const keyResolver = makeKeyResolver(keys, providersByKeyId);
      const telemetry = {
        counter: vi.fn(),
        histogram: vi.fn(),
        event: vi.fn(),
      };

      const manager = new BatchManager({
        store,
        providers: new Map(),
        batching: defaultBatching(),
        keyResolver,
        telemetry,
      });

      await manager.flush();

      // Both providers should have been attempted.
      expect(primaryProvider.submitBatch).toHaveBeenCalledOnce();
      expect(backupProvider.submitBatch).toHaveBeenCalledOnce();

      // Request should be back to queued (last key also failed, so
      // the batch was reset).
      const stored = await store.getRequest(reqRecord.id);
      expect(stored?.status).toBe('queued');
      expect(stored?.batchId).toBeNull();

      // Telemetry should record the exhaustion.
      expect(telemetry.event).toHaveBeenCalledWith(
        'batch_submit_error',
        expect.objectContaining({
          error: 'All API keys exhausted during failover',
          keysAttempted: 2,
        }),
      );
    });

    it('emits failover_used telemetry when backup key succeeds', async () => {
      await store.createRequest(makeNewRequest({ userId: 'user_01' }));

      const primaryProvider = mockProvider({
        submitBatch: vi.fn().mockRejectedValue(new Error('429 rate limit')),
      });
      const backupProvider = mockProvider();

      const keys = [
        makeApiKey({ id: 'key_primary', label: 'Primary', priority: 0 }),
        makeApiKey({ id: 'key_backup', label: 'Backup', priority: 1 }),
      ];

      const providersByKeyId = new Map([
        ['key_primary', primaryProvider],
        ['key_backup', backupProvider],
      ]);

      const keyResolver = makeKeyResolver(keys, providersByKeyId);
      const telemetry = {
        counter: vi.fn(),
        histogram: vi.fn(),
        event: vi.fn(),
      };

      const manager = new BatchManager({
        store,
        providers: new Map(),
        batching: defaultBatching(),
        keyResolver,
        telemetry,
      });

      await manager.flush();

      expect(telemetry.event).toHaveBeenCalledWith(
        'failover_used',
        expect.objectContaining({
          fromKeyId: 'key_primary',
          toKeyId: 'key_backup',
          attemptIndex: 1,
        }),
      );
    });

    it('handles no active keys gracefully', async () => {
      await store.createRequest(makeNewRequest({ userId: 'user_01' }));

      const keyResolver = makeKeyResolver([], new Map());
      const telemetry = {
        counter: vi.fn(),
        histogram: vi.fn(),
        event: vi.fn(),
      };

      const manager = new BatchManager({
        store,
        providers: new Map(),
        batching: defaultBatching(),
        keyResolver,
        telemetry,
      });

      await manager.flush();

      expect(telemetry.event).toHaveBeenCalledWith(
        'batch_submit_error',
        expect.objectContaining({
          error: 'No active API keys found for user/provider',
        }),
      );
    });

    it('respects key priority order across multiple candidates', async () => {
      await store.createRequest(makeNewRequest({ userId: 'user_01' }));

      const callOrder: string[] = [];

      const provider1 = mockProvider({
        submitBatch: vi.fn().mockImplementation(async () => {
          callOrder.push('key_low');
          throw new Error('429 rate limit');
        }),
      });
      const provider2 = mockProvider({
        submitBatch: vi.fn().mockImplementation(async () => {
          callOrder.push('key_mid');
          throw new Error('Quota exceeded');
        }),
      });
      const provider3 = mockProvider({
        submitBatch: vi.fn().mockImplementation(async () => {
          callOrder.push('key_high');
          return { providerBatchId: 'pb_001', provider: 'claude' as const };
        }),
      });

      const keys = [
        makeApiKey({ id: 'key_high', label: 'High', priority: 20 }),
        makeApiKey({ id: 'key_low', label: 'Low', priority: 0 }),
        makeApiKey({ id: 'key_mid', label: 'Mid', priority: 10 }),
      ];

      const providersByKeyId = new Map([
        ['key_low', provider1],
        ['key_mid', provider2],
        ['key_high', provider3],
      ]);

      const keyResolver = makeKeyResolver(keys, providersByKeyId);

      const manager = new BatchManager({
        store,
        providers: new Map(),
        batching: defaultBatching(),
        keyResolver,
      });

      await manager.flush();

      // Keys should be tried in priority order: low(0) -> mid(10) -> high(20)
      expect(callOrder).toEqual(['key_low', 'key_mid', 'key_high']);
    });
  });

  // -------------------------------------------------------------------------
  // Execution-time lifecycle preflight
  // -------------------------------------------------------------------------

  describe('lifecycle preflight', () => {
    it('short-circuits retired-model requests to failed_final without submitting', async () => {
      await store.upsertProviderCatalogEntry({
        provider: 'claude',
        model: 'claude-3-5-haiku-20241022',
        displayLabel: 'Claude 3.5 Haiku',
        inputUsdPerToken: 0.8 / 1_000_000,
        outputUsdPerToken: 4.0 / 1_000_000,
        lifecycleState: 'retired',
        deprecatedAt: new Date('2025-12-19'),
        retiresAt: new Date('2026-02-19'),
        replacementModel: 'claude-haiku-4-5',
      });

      const req = await store.createRequest(makeNewRequest({ model: 'claude-3-5-haiku-20241022' }));

      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };
      const provider = mockProvider();
      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
        telemetry,
      });

      await manager.flush();

      // Must not submit to the provider.
      expect(provider.submitBatch).not.toHaveBeenCalled();

      // Request should be terminal.
      const stored = await store.getRequest(req.id);
      expect(stored?.status).toBe('failed_final');
      expect(stored?.batchId).toBeNull();

      // Telemetry event fires with the full structured payload so the UI can
      // surface a useful explanation rather than "provider returned an error".
      expect(telemetry.event).toHaveBeenCalledWith(
        'request_retired_model_blocked',
        expect.objectContaining({
          requestId: req.id,
          reason: 'model_retired',
          model: 'claude-3-5-haiku-20241022',
          provider: 'claude',
          replacementModel: 'claude-haiku-4-5',
        }),
      );
      expect(telemetry.counter).toHaveBeenCalledWith(
        'requests_retired_model_blocked',
        1,
        expect.objectContaining({ provider: 'claude', model: 'claude-3-5-haiku-20241022' }),
      );

      // Event log captures the failure reason for later UI surfacing.
      const events = store.getEvents();
      const failureEvent = events.find((e) => e.event === 'failed_final_retired_model');
      expect(failureEvent).toBeTruthy();
      expect(failureEvent?.details).toMatchObject({
        reason: 'model_retired',
        replacementModel: 'claude-haiku-4-5',
      });
    });

    it('still submits deprecated-model requests (Composer already hides them from new submissions)', async () => {
      await store.upsertProviderCatalogEntry({
        provider: 'claude',
        model: 'claude-sonnet-4-20250514',
        displayLabel: 'Claude Sonnet 4',
        inputUsdPerToken: 3.0 / 1_000_000,
        outputUsdPerToken: 15.0 / 1_000_000,
        lifecycleState: 'deprecated',
        deprecatedAt: new Date('2026-04-14'),
        retiresAt: new Date('2026-06-15'),
        replacementModel: 'claude-sonnet-4-5-20250929',
      });

      await store.createRequest(makeNewRequest({ model: 'claude-sonnet-4-20250514' }));

      const provider = mockProvider();
      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      expect(provider.submitBatch).toHaveBeenCalledOnce();
    });

    it('submits requests whose model is absent from the catalog (unknown/just-released)', async () => {
      // Catalog is empty for this model; the catalog may lag upstream and
      // we don't want to false-positive against a just-released model.
      await store.createRequest(makeNewRequest({ model: 'claude-brand-new-20260501' }));

      const provider = mockProvider();
      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      expect(provider.submitBatch).toHaveBeenCalledOnce();
    });

    it('submits active-model requests normally', async () => {
      await store.upsertProviderCatalogEntry({
        provider: 'claude',
        model: 'claude-sonnet-4-5-20250929',
        displayLabel: 'Claude Sonnet 4.5',
        inputUsdPerToken: 3.0 / 1_000_000,
        outputUsdPerToken: 15.0 / 1_000_000,
        lifecycleState: 'active',
        deprecatedAt: null,
        retiresAt: null,
        replacementModel: null,
      });

      await store.createRequest(makeNewRequest({ model: 'claude-sonnet-4-5-20250929' }));

      const provider = mockProvider();
      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      expect(provider.submitBatch).toHaveBeenCalledOnce();
    });

    it('mixes retired and active requests: retired ones short-circuit, active ones still submit', async () => {
      await store.upsertProviderCatalogEntry({
        provider: 'claude',
        model: 'claude-3-5-haiku-20241022',
        displayLabel: 'Claude 3.5 Haiku',
        inputUsdPerToken: 0.8 / 1_000_000,
        outputUsdPerToken: 4.0 / 1_000_000,
        lifecycleState: 'retired',
        deprecatedAt: new Date('2025-12-19'),
        retiresAt: new Date('2026-02-19'),
        replacementModel: 'claude-haiku-4-5',
      });

      const retiredReq = await store.createRequest(
        makeNewRequest({ model: 'claude-3-5-haiku-20241022' }),
      );
      const activeReq = await store.createRequest(
        makeNewRequest({ model: 'claude-sonnet-4-5-20250929' }),
      );

      const provider = mockProvider();
      const providers = new Map([['claude', provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      // Only the active request reaches the provider adapter.
      expect(provider.submitBatch).toHaveBeenCalledOnce();
      const submitted = (provider.submitBatch as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as NorushRequest[];
      expect(submitted).toHaveLength(1);
      expect(submitted[0].id).toBe(activeReq.id);

      // Retired request is terminal, active request is batched.
      expect((await store.getRequest(retiredReq.id))?.status).toBe('failed_final');
      expect((await store.getRequest(activeReq.id))?.status).toBe('batched');
    });
  });
});
