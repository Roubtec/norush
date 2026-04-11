# Cron Batch Example

A self-contained script that demonstrates using norush in a serverless/cron context where the process is short-lived.

## Overview

Instead of running a long-lived worker with `engine.start()`, this script calls `engine.tick()` once per invocation.
This is suitable for:

- Cron jobs (system cron, Cloud Scheduler, etc.)
- Serverless functions (AWS Lambda, Azure Functions, etc.)
- CI/CD pipelines

Each `tick()` performs one cycle of: flush queued requests, poll batch statuses, deliver completed results, and sweep retention.

## Setup

```bash
cd examples/cron-batch
npm install
```

## Run

```bash
# Set required environment variables
export DATABASE_URL=postgres://user:pass@localhost:5432/norush
export ANTHROPIC_API_KEY=sk-ant-...

# Enqueue some work (first run)
node enqueue.js

# Process one tick (run on a schedule)
node tick.js
```

## Cron Setup

Run `tick.js` every minute via system cron:

```cron
* * * * * cd /path/to/examples/cron-batch && node tick.js >> /var/log/norush-tick.log 2>&1
```

Or every 5 minutes:

```cron
*/5 * * * * cd /path/to/examples/cron-batch && node tick.js
```

## How It Works

1. **enqueue.js** creates a norush engine, queues one or more requests, and exits.
2. **tick.js** creates a norush engine, calls `tick()` once, and exits.
3. Each `tick()` automatically flushes, polls, delivers, and sweeps.
4. State is persisted in PostgreSQL, so each invocation picks up where the last left off.
