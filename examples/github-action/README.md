# GitHub Actions Example

Example workflows showing how to integrate norush with GitHub Actions for scheduled batch processing.

## Workflows

### `batch-tick.yml`

A scheduled workflow that runs `engine.tick()` on a cron schedule.
Useful when you don't want to run a dedicated worker process.

**How it works:**
1. Runs on a schedule (every 5 minutes by default).
2. Checks out the repository, installs dependencies, and builds.
3. Runs a single `tick()` cycle that flushes, polls, delivers, and sweeps.
4. Exits. GitHub Actions handles scheduling the next run.

### `batch-enqueue.yml`

A workflow that enqueues requests when triggered manually or by a repository event.
Demonstrates using `workflow_dispatch` for on-demand batch submission.

## Setup

1. Copy the workflow files to your `.github/workflows/` directory.
2. Configure the required secrets in your GitHub repository settings:

| Secret | Description |
|--------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | Anthropic API key (optional) |
| `OPENAI_API_KEY` | OpenAI API key (optional) |

3. The workflow will run automatically on the configured schedule.

## Customization

Adjust the cron schedule in `batch-tick.yml`:

```yaml
schedule:
  - cron: "*/5 * * * *"   # Every 5 minutes
  - cron: "0 * * * *"     # Every hour
  - cron: "0 */6 * * *"   # Every 6 hours
```

Note: GitHub Actions cron has a minimum granularity of 5 minutes and may be delayed during high-load periods.
