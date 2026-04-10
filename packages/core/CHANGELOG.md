# Changelog

All notable changes to `@norush/core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial release of `@norush/core`.
- Multi-provider batch engine supporting Anthropic (Claude), OpenAI Batch, and OpenAI Flex APIs.
- `createNorush()` factory for assembling and running the engine.
- `MemoryStore` and `PostgresStore` storage backends.
- Request queue with automatic batching and configurable flush intervals.
- Batch lifecycle management: submission, polling, status tracking, and crash recovery.
- Result ingestion and delivery via callbacks and webhooks.
- Circuit breaker for provider fault isolation.
- Orphan recovery for requests/batches abandoned after crashes.
- Repackager for re-batching failed or expired requests.
- Data retention worker with configurable policies.
- API key encryption at rest with master key rotation CLI (`norush-rotate-key`).
- Webhook signing and delivery with HMAC verification.
- Adaptive rate limiting with health-score-based adjustments.
- Configurable polling strategies: linear, backoff, deadline-aware, and eager.
- Pricing helpers for cost estimation and savings calculation.
- Telemetry hooks with noop and console implementations.
