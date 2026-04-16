/**
 * Anthropic (Claude) provider catalog source.
 *
 * Anthropic does not publish a stable machine-readable pricing/lifecycle
 * endpoint. Their model-deprecations page does publish an HTML table with
 * a "Model status" section and a "Deprecation history" section listing
 * recommended replacements — those are the shape this module parses.
 * Pricing is filled from a small hardcoded table keyed on the model id,
 * because the pricing marketing page is awkward to scrape headlessly.
 *
 * This module exposes two entry points:
 *
 *   - `parseAnthropicDeprecationPage(html)` — pure function from HTML to
 *     an array of `ParsedCatalogEntry`. The refresh path and the fixture
 *     tests both call this.
 *
 *   - `fetchAnthropicCatalog()` — hits the live documentation URL and
 *     returns a parsed catalog. Falls back to an empty array on error so
 *     the caller can decide whether to touch DB rows.
 *
 * If the parser extracts zero rows, the caller treats that as a parse
 * failure (upstream shape change) and leaves the existing catalog rows
 * untouched rather than wiping them.
 */

import type { ProviderLifecycleState } from '@norush/core';
import type { ParsedCatalogEntry } from './types.js';

// ---------------------------------------------------------------------------
// Known URLs (exported for tests + ops docs)
// ---------------------------------------------------------------------------

export const ANTHROPIC_DEPRECATIONS_URL =
  'https://platform.claude.com/docs/en/about-claude/model-deprecations';

// ---------------------------------------------------------------------------
// Pricing table (USD per token).
//
// Anthropic's pricing page is not machine-readable, so we keep a small
// hardcoded map. The scheduled refresh copies these into the catalog
// alongside the live lifecycle data, so the UI always sees one row per
// model. Update this table when Anthropic announces a price change.
// ---------------------------------------------------------------------------

const ANTHROPIC_PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-5-20251014': { input: 15.0 / 1_000_000, output: 75.0 / 1_000_000 },
  'claude-opus-4-1-20250805': { input: 15.0 / 1_000_000, output: 75.0 / 1_000_000 },
  'claude-opus-4-20250514': { input: 15.0 / 1_000_000, output: 75.0 / 1_000_000 },
  'claude-sonnet-4-5-20250929': { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  'claude-sonnet-4-20250514': { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  'claude-haiku-4-5': { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
  'claude-3-5-haiku-20241022': { input: 0.8 / 1_000_000, output: 4.0 / 1_000_000 },
  'claude-3-5-sonnet-20241022': { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  'claude-3-5-sonnet-20240620': { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  'claude-3-opus-20240229': { input: 15.0 / 1_000_000, output: 75.0 / 1_000_000 },
  'claude-3-sonnet-20240229': { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  'claude-3-haiku-20240307': { input: 0.25 / 1_000_000, output: 1.25 / 1_000_000 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseState(raw: string): ProviderLifecycleState {
  const s = raw.toLowerCase().trim();
  if (s === 'active') return 'active';
  if (s === 'legacy') return 'legacy';
  if (s === 'deprecated') return 'deprecated';
  if (s === 'retired') return 'retired';
  // Unknown token — conservative default so we don't accidentally mark
  // something callable as retired.
  return 'active';
}

function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'n/a' || trimmed === '—' || trimmed === '-') {
    return null;
  }
  const t = Date.parse(trimmed);
  if (Number.isNaN(t)) return null;
  return new Date(t);
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function titleCaseFromModelId(model: string): string {
  // Best-effort: turn "claude-sonnet-4-5-20250929" into "Claude Sonnet 4.5".
  const withoutDate = model.replace(/-\d{8}$/, '');
  const parts = withoutDate.split('-');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (/^\d+$/.test(p)) {
      // Number segment — collapse consecutive numbers into "4.5".
      const nums: string[] = [p];
      while (i + 1 < parts.length && /^\d+$/.test(parts[i + 1])) {
        i += 1;
        nums.push(parts[i]);
      }
      out.push(nums.join('.'));
    } else if (p.length > 0) {
      out.push(p.charAt(0).toUpperCase() + p.slice(1));
    }
  }
  return out.join(' ');
}

// ---------------------------------------------------------------------------
// HTML parsers
//
// The deprecation page has two sections we care about:
//   - "Model status" — a table of (model, current state, deprecation date,
//     retirement date).
//   - "Deprecation history" — a table/section naming the recommended
//     replacement per deprecated model.
//
// We parse the HTML with simple regexes because we don't want a DOM
// library dependency for this one file. Matches are defensive: we never
// throw on a shape change, we return whatever rows we managed to parse.
// If the whole table disappears, we return [] and the caller treats that
// as a parse failure.
// ---------------------------------------------------------------------------

interface RowCells {
  cells: string[];
}

function extractTables(html: string): string[] {
  const tables: string[] = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(html)) !== null) {
    tables.push(m[1]);
  }
  return tables;
}

function parseTableRows(tableInner: string): RowCells[] {
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows: RowCells[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(tableInner)) !== null) {
    const inner = m[1];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    const cells: string[] = [];
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(inner)) !== null) {
      cells.push(decodeEntities(stripTags(c[1])));
    }
    if (cells.length > 0) rows.push({ cells });
  }
  return rows;
}

/**
 * Parse a single catalog row from an already-split cell list.
 *
 * Expected column order (based on the Anthropic deprecation page as
 * observed on 2026-04-16): Model, Status, Deprecation date, Retirement date.
 * Extra columns are ignored. Missing columns default to null / active.
 */
function rowToEntry(cells: string[]): ParsedCatalogEntry | null {
  if (cells.length < 2) return null;
  const model = cells[0].trim();
  if (!model || model.toLowerCase() === 'model') return null;

  // A model id always contains a lowercase letter and at least one digit or dash.
  // This filters out summary rows like "Total models: 12".
  if (!/^[a-z0-9][a-z0-9-]+$/.test(model)) return null;

  const lifecycleState = normaliseState(cells[1] ?? 'active');
  const deprecatedAt = parseDate(cells[2]);
  const retiresAt = parseDate(cells[3]);

  const pricing = ANTHROPIC_PRICING[model] ?? null;

  return {
    provider: 'claude',
    model,
    displayLabel: titleCaseFromModelId(model),
    inputUsdPerToken: pricing?.input ?? null,
    outputUsdPerToken: pricing?.output ?? null,
    lifecycleState,
    deprecatedAt,
    retiresAt,
    // Replacement hint is filled in from the history section below.
    replacementModel: null,
  };
}

/**
 * Pull `(model, replacement)` pairs out of the "Deprecation history"
 * section. The section has variable structure but consistently renders
 * pairs as "<model> was deprecated ... Use <replacement> instead" either
 * inside a `<li>` or inside a table cell.
 */
function extractReplacementHints(html: string): Map<string, string> {
  const hints = new Map<string, string>();
  const text = decodeEntities(stripTags(html));

  // The deprecation-history section is free-form prose. Each entry we
  // care about mentions the old model followed by a deprecation/retirement
  // verb phrase, followed by "Use <replacement> instead" (or a close
  // variant). We split the text into candidate windows keyed on the verb
  // phrase — "was deprecated", "was retired", "is being deprecated", etc —
  // and within each window pair the nearest surrounding model ids.
  //
  // This anchors on the verb phrase rather than on the old-model id so we
  // don't accidentally grab a model id from the status table at the top
  // of the page.
  const anchorRe =
    /(claude-[a-z0-9-]+)\s+(?:was|is|will be)\s+(?:being\s+)?(?:deprecated|retired|sunset)\b[\s\S]{0,300}?\b(?:use|replaced by|successor(?: is)?|recommended(?: replacement)?(?: is)?)\b[\s\S]{0,100}?(claude-[a-z0-9-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(text)) !== null) {
    const from = m[1];
    const to = m[2];
    if (from && to && from !== to && !hints.has(from)) {
      hints.set(from, to);
    }
  }
  return hints;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pure parser: HTML → catalog entries. Exported for tests (fixtures live
 * at `packages/web/test/fixtures/provider-catalog/anthropic-*.html`).
 *
 * Returns [] on any shape mismatch so the caller can detect parse failure
 * and preserve existing catalog rows.
 */
export function parseAnthropicDeprecationPage(html: string): ParsedCatalogEntry[] {
  const entries: ParsedCatalogEntry[] = [];
  const tables = extractTables(html);

  for (const table of tables) {
    const rows = parseTableRows(table);
    for (const row of rows) {
      const entry = rowToEntry(row.cells);
      if (entry) entries.push(entry);
    }
  }

  // Merge replacement hints so deprecated/retired rows know where to
  // point users next.
  if (entries.length > 0) {
    const hints = extractReplacementHints(html);
    for (const entry of entries) {
      if (!entry.replacementModel) {
        const hint = hints.get(entry.model);
        if (hint) entry.replacementModel = hint;
      }
    }
  }

  // Dedupe on model id — if the page repeats a row, last-writer-wins.
  const byModel = new Map<string, ParsedCatalogEntry>();
  for (const entry of entries) {
    byModel.set(entry.model, entry);
  }
  return [...byModel.values()];
}

/** Timeout for upstream catalog fetches (10 s). Prevents a hung connection
 *  from stalling the hourly refresh loop indefinitely. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Live-fetch the Anthropic catalog from the deprecations page.
 *
 * Returns [] on network error, timeout, or empty parse. Callers interpret []
 * as "don't touch the DB rows" per the parser-robustness rule in the task.
 */
export async function fetchAnthropicCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<ParsedCatalogEntry[]> {
  try {
    const res = await fetchImpl(ANTHROPIC_DEPRECATIONS_URL, {
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseAnthropicDeprecationPage(html);
  } catch {
    return [];
  }
}
