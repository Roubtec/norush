# Build Usage Dashboard

## Why this task exists

Users need visibility into their batch processing activity: how many requests, costs, response times, and success rates.
This dashboard surfaces the telemetry and usage data that norush already tracks.

## Scope

**Included:**
- Dashboard page showing usage statistics for the authenticated user
- Metrics: total requests, batches, success/failure rates, tokens used, estimated cost
- Time period selector: last 24h, 7d, 30d
- Batch turnaround time distribution
- Cost breakdown by provider and model
- Summary of current spend limits and utilization

**Out of scope:**
- Admin/operator dashboard (future)
- Real-time streaming updates (use page reload or polling)
- Export/download of usage data
- Detailed per-request audit log

## Context and references

- PLAN.md Section 6.7 (Telemetry) — metric categories: volume, latency, errors, cost, size
- PLAN.md Section 3.3 (Core Interfaces) — `Store.getStats(userId, period)` method
- PLAN.md Section 6.6 (Data Retention) — token counts and timing survive content scrubbing

## Target files or areas

```
packages/web/src/
├── routes/
│   └── (app)/
│       └── dashboard/
│           ├── +page.svelte          # Dashboard UI
│           └── +page.server.ts       # Load stats from store
├── lib/
│   └── components/
│       ├── StatsCard.svelte          # Reusable stat display card
│       └── UsageChart.svelte         # Simple chart component (bar or line)
```

## Implementation notes

- **`Store.getStats()`** should aggregate from `requests`, `batches`, and `results` tables. Query patterns:
  - Count requests by status within the period.
  - Sum `input_tokens` and `output_tokens` from results.
  - Calculate average batch turnaround (`ended_at - submitted_at`).
  - Group by provider and model for cost breakdown.
- **Cost estimation:** Use known pricing per provider/model (can be hardcoded initially or configurable). Calculate: `tokens * rate` for standard vs batch pricing, show savings.
- **Charts:** Keep it simple — CSS-based bar charts or a lightweight library. No heavy charting dependencies.
- **Data survives scrubbing:** Token counts, timestamps, and status metadata are preserved even after content scrubbing (PLAN.md Section 6.6), so historical analytics always work.
- **Spend limit utilization:** Show current period usage vs configured limits (from `user_limits` table).

### Dependencies

- Requires task 2-01 (SvelteKit scaffold).
- Requires task 2-02 (Auth — user must be logged in).
- Requires task 1-03 (Store — `getStats()` method implementation).
- Requires task 3-04 (Spend limits — to show utilization).

## Acceptance criteria

- Dashboard page loads and shows usage stats for the authenticated user.
- Stats are accurate for the selected time period.
- Cost breakdown shows per-provider and per-model totals.
- Savings indicator shows how much was saved vs real-time pricing.
- Spend limit utilization is displayed (current usage / limit).
- Page handles zero-data state gracefully (new user with no activity).
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- Submit several requests across providers/models. Wait for completion. Visit dashboard → verify stats reflect actual activity.
- Switch time periods → verify stats update accordingly.
- Test with a new user (no data) → verify empty state renders.

## Review plan

- Verify stats queries are scoped to the authenticated user.
- Verify cost calculations use correct per-model rates.
- Check that the page performs well (queries are indexed, no N+1).
- Confirm the dashboard works after content scrubbing (metadata survives).
