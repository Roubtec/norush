# Implement Claude and OpenAI Provider Adapters

## Why this task exists

The engine needs to talk to LLM providers through a uniform `Provider` interface.
This task implements the two primary adapters — Claude (Anthropic Message Batches) and OpenAI (Batch API with JSONL file upload).

## Scope

**Included:**
- `ClaudeAdapter` implementing `Provider` — submit, check status, fetch results, cancel
- `OpenAIBatchAdapter` implementing `Provider` — JSONL file upload, batch create, status check, output file download, cancel
- Request/response mapping: convert `NorushRequest` to provider-specific format and provider responses back to `NorushResult`
- `custom_id` generation and mapping (norush_id ↔ provider custom_id)
- Unit tests with mocked SDK responses

**Out of scope:**
- OpenAI Flex adapter (Phase 4)
- Retry logic and circuit breaker (those live in the engine layer — tasks 1-07, 1-08)
- Multi-key failover (Phase 3)

## Context and references

- PLAN.md Section 2.1 (Anthropic Message Batches API) — format, status flow, auth
- PLAN.md Section 2.2 (OpenAI Batch API) — JSONL file upload, two-step submission, output file
- PLAN.md Section 2.4 (Comparison Matrix) — differences between providers
- PLAN.md Section 3.2 (Components) — adapter responsibilities
- PLAN.md Section 3.3 (Core Interfaces) — `Provider` interface (defined in task 1-02)
- PLAN.md Section 6.2 (Result Pipeline) — OpenAI output file handling (line-by-line streaming)

## Target files or areas

```
packages/core/src/
├── providers/
│   ├── claude.ts           # ClaudeAdapter
│   ├── openai-batch.ts     # OpenAIBatchAdapter
│   └── index.ts            # re-exports
packages/core/test/
└── providers/
    ├── claude.test.ts
    └── openai-batch.test.ts
```

## Implementation notes

- **ClaudeAdapter:**
  - Uses `@anthropic-ai/sdk` for API calls.
  - `submitBatch`: POST array of `{ custom_id, params }`. Each `params` is a standard Messages API body.
  - `checkStatus`: GET batch by ID. Map `in_progress` → processing, `ended` → ended.
  - `fetchResults`: Use SDK's `results()` iterator to stream results one at a time. Yield `NorushResult` for each.
  - Auth via `x-api-key` header (SDK handles this).

- **OpenAIBatchAdapter:**
  - Uses `openai` SDK for API calls.
  - `submitBatch`: (1) Build JSONL string from requests, (2) upload via Files API, (3) create batch referencing file ID.
  - `checkStatus`: GET batch by ID. Map `validating`/`in_progress` → processing, `completed` → ended, `expired`/`cancelled`/`failed` → terminal states.
  - `fetchResults`: Download output file by `output_file_id`. Parse JSONL line-by-line. Also check `error_file_id` for per-request errors.
  - Output line order may not match input — use `custom_id` to correlate.
  - For large output files, stream the download and parse line-by-line (memory bounded).

- **Shared concerns:**
  - `custom_id` should be the `norush_id` (or a derivative) so results map back trivially.
  - Both adapters should return normalized `NorushResult` objects with `norushId`, `response`, `stopReason`, `inputTokens`, `outputTokens`.
  - Provider-specific error shapes should be caught and normalized into a common error type.

### Dependencies

- Requires task 1-02 (Provider interface, NorushRequest, NorushResult types).
- Provider SDK packages (`@anthropic-ai/sdk`, `openai`) must be added as dependencies.

## Acceptance criteria

- `ClaudeAdapter` implements all 4 `Provider` methods.
- `OpenAIBatchAdapter` implements all 4 `Provider` methods including the two-step JSONL submission.
- Both adapters correctly map between `NorushRequest`/`NorushResult` and provider-specific formats.
- `custom_id` round-trips correctly (norush_id → provider → result → norush_id).
- Unit tests verify request formatting, response parsing, status mapping, and error handling using mocked SDK calls.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- `pnpm test` passes all provider adapter tests.
- Verify by reading test mocks that the request/response shapes match the real provider API specs from PLAN.md Section 2.1 and 2.2.

## Review plan

- Compare request formatting against PLAN.md Section 2.1 (Claude) and 2.2 (OpenAI).
- Verify status mapping covers all provider states.
- Check that OpenAI adapter handles both `output_file_id` and `error_file_id`.
- Confirm streaming/line-by-line parsing for OpenAI results.
