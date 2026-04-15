/**
 * MemoryStore unit tests.
 *
 * Runs the shared Store contract suite against the in-memory implementation.
 * No external dependencies required — always runs.
 */

import { describe } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import { runStoreContractTests } from './store-contract.test.js';

describe('MemoryStore', () => {
  runStoreContractTests(() => new MemoryStore());
});
