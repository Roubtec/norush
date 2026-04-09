# Implement OpenAI Flex Adapter

## Why this task exists

OpenAI Flex processing offers batch-tier pricing (50% off) with synchronous semantics.
This adapter gives norush a "cheap but still real-time" fallback mode for users who want savings without deferred delivery.

## Scope

**Included:**
- `OpenAIFlexAdapter` implementing the `Provider` interface
- Synchronous request with `"service_tier": "flex"` parameter
- 429 handling with retry and backoff (Flex may reject when resources are unavailable)
- 15-minute SDK timeout (per PLAN.md recommendation)
- Integration into the provider registry so users can select `flex` as a mode

**Out of scope:**
- Batching logic for Flex (it's per-request, not batched)
- Automatic mode switching between batch and flex (future optimization)

## Context and references

- PLAN.md Section 2.3 (OpenAI Flex Processing) — mechanism, pricing, latency, timeout
- PLAN.md Section 2.4 (Comparison Matrix) — Flex vs Batch comparison
- PLAN.md Section 3.2 (Components) — OpenAIFlexAdapter listed as Phase 4

## Target files or areas

```
packages/core/src/
├── providers/
│   └── openai-flex.ts        # OpenAIFlexAdapter
packages/core/test/
└── providers/
    └── openai-flex.test.ts
```

## Implementation notes

- Flex is **synchronous** — the adapter sends a single request and waits for the response. It still implements the `Provider` interface, but `submitBatch` sends requests one at a time (or could process the array serially/in parallel).
- Add `"service_tier": "flex"` to the request body.
- Set SDK timeout to 15 minutes (900,000ms).
- On 429: retry with exponential backoff. Flex 429s mean resources are temporarily unavailable, not a rate limit on the account.
- Results are available immediately — `fetchResults` returns the already-received response.
- The `checkStatus` method can return `ended` immediately since Flex is synchronous.
- Consider whether Flex requests should bypass the normal queue/batch flow or go through it with a batch size of 1.

### Dependencies

- Requires task 1-02 (Provider interface).
- Requires task 1-05 (OpenAI SDK already added as dependency).

## Acceptance criteria

- `OpenAIFlexAdapter` implements all `Provider` interface methods.
- Requests include `"service_tier": "flex"`.
- SDK timeout is set to 15 minutes.
- 429 responses trigger retry with backoff.
- Results are returned synchronously.
- Unit tests verify request formatting, 429 retry, and timeout configuration.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- `pnpm test` passes all Flex adapter tests.
- Integration test (conditional on env var): send a Flex request, verify response received synchronously.

## Review plan

- Verify `service_tier: "flex"` is included in the request.
- Verify timeout is 15 minutes, not the default.
- Check 429 retry behavior is distinct from rate-limit handling.
