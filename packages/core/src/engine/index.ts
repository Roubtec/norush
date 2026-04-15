/**
 * Engine module re-exports.
 */

export { RequestQueue, estimateBytes, type RequestQueueOptions } from './queue.js';
export {
  BatchManager,
  PROVIDER_LIMITS,
  type BatchManagerOptions,
  type ProviderLimits,
  type KeyResolver,
} from './batch-manager.js';
export {
  StatusTracker,
  type StatusTrackerOptions,
  type StatusTrackerEventName,
  type StatusTrackerEventHandler,
} from './status-tracker.js';
export {
  OrphanRecovery,
  type OrphanRecoveryOptions,
  type OrphanRecoveryResult,
} from './orphan-recovery.js';
export {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitBreakerState,
  type CircuitBreakerSnapshot,
} from './circuit-breaker.js';
export {
  ResultIngester,
  type ResultIngesterOptions,
  type IngestionResult,
} from './result-ingester.js';
export {
  DeliveryWorker,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  DEFAULT_MAX_DELIVERY_ATTEMPTS,
  type DeliveryWorkerOptions,
  type DeliveryCallback,
  type DeliveryEventName,
  type DeliveryEventHandler,
} from './delivery-worker.js';
export { Repackager, type RepackagerOptions, type RepackageResult } from './repackager.js';
export {
  RetentionWorker,
  parseRetentionPolicy,
  computeCutoffDate,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_HARD_CAP_DAYS,
  DEFAULT_INTERVAL_MS as DEFAULT_RETENTION_INTERVAL_MS,
  type RetentionPolicy,
  type RetentionPolicyResolver,
  type RetentionWorkerOptions,
  type RetentionSweepResult,
} from './retention-worker.js';
