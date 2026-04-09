import type {
  BatchStatus,
  NorushRequest,
  NorushResult,
  ProviderBatchRef,
} from "../types.js";

/**
 * Provider adapter interface.
 *
 * Each LLM provider (Anthropic, OpenAI) implements this interface to abstract
 * away submission format, polling mechanics, and result retrieval.
 */
export interface Provider {
  /** Submit a batch of requests to the provider. */
  submitBatch(requests: NorushRequest[]): Promise<ProviderBatchRef>;

  /** Check the current status of a previously submitted batch. */
  checkStatus(ref: ProviderBatchRef): Promise<BatchStatus>;

  /**
   * Fetch results for a completed batch.
   *
   * AsyncIterable allows Claude to yield results as individual requests
   * complete (early streaming), while OpenAI yields all results at once
   * after the batch finishes — same interface, different timing.
   */
  fetchResults(ref: ProviderBatchRef): AsyncIterable<NorushResult>;

  /** Cancel a batch that is in progress at the provider. */
  cancelBatch(ref: ProviderBatchRef): Promise<void>;
}
