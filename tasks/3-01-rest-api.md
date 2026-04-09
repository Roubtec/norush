# Implement REST API for Programmatic Access

## Why this task exists

Broker mode requires a programmatic API for submitting requests, checking status, and retrieving results — not just the chat UI.
This task exposes the core engine over HTTP for developer consumers.

## Scope

**Included:**
- `POST /api/v1/requests` — submit one or more requests
- `GET /api/v1/requests/:id` — get request status and result
- `GET /api/v1/requests` — list user's requests (paginated, filterable by status)
- `GET /api/v1/batches` — list user's batches (paginated)
- `GET /api/v1/batches/:id` — get batch status and request summary
- `POST /api/v1/flush` — manually trigger batch flush
- API authentication via bearer token (issued per-user, stored in DB)
- Input validation and error response format
- API versioning via URL prefix (`/api/v1/`)

**Out of scope:**
- Webhook delivery (task 3-02)
- Multi-token failover (task 3-03)
- Rate limiting (task 3-04)
- API documentation site (Phase 4)

## Context and references

- PLAN.md Section 5.2 (Broker Mode) — users submit via API, receive results via webhook
- PLAN.md Section 5.3 (Developer Library) — programmatic access pattern
- PLAN.md Section 5.1 — architecture: API Server with SvelteKit server routes
- PLAN.md Section 4.1 (Schema) — request/batch/result data model

## Target files or areas

```
packages/web/src/
├── routes/
│   └── api/
│       └── v1/
│           ├── requests/
│           │   ├── +server.ts        # POST (create) + GET (list)
│           │   └── [id]/
│           │       └── +server.ts    # GET (single request with result)
│           ├── batches/
│           │   ├── +server.ts        # GET (list)
│           │   └── [id]/
│           │       └── +server.ts    # GET (single batch)
│           └── flush/
│               └── +server.ts        # POST (manual flush)
├── lib/
│   └── server/
│       └── api-auth.ts               # API token validation middleware
packages/web/test/
└── api/v1/
    ├── requests.test.ts              # CRUD, pagination, filtering, validation
    ├── batches.test.ts               # List and detail endpoints
    ├── flush.test.ts                 # Manual flush trigger
    └── api-auth.test.ts              # Token validation, rejection, scoping
```

## Implementation notes

- **API authentication:** Bearer token in `Authorization` header. Tokens are separate from WorkOS sessions — generate a random token per user, hash and store in a new `api_tokens` table (or add to `users`). Validate on every API request.
- **Request submission (`POST /api/v1/requests`):** Accept a body with `provider`, `model`, `params` (the LLM request), and optional `callback_url` and `webhook_secret`. Call `norush.enqueue()`. Return the created request with `norush_id`.
- **Batch submission:** Can accept an array of requests for bulk submission.
- **Pagination:** Use cursor-based pagination with ULID cursors (since ULIDs are time-sorted). `?cursor=ULID&limit=50`.
- **Filtering:** `GET /api/v1/requests?status=queued&provider=claude`.
- **Error format:** Consistent JSON error responses: `{ error: { code, message, details? } }`.
- All endpoints are scoped to the authenticated user — no cross-user access.

### Dependencies

- Requires task 2-01 (SvelteKit server routes).
- Requires task 2-02 (Auth — need user context).
- Requires task 1-09 (norush engine for enqueue/flush).

## Acceptance criteria

- All listed endpoints are implemented and return correct data.
- API token authentication works (reject requests without valid token).
- Requests are scoped to the authenticated user.
- Pagination works with cursor-based navigation.
- Status filtering works on request list endpoint.
- Input validation rejects malformed requests with clear error messages.
- Error responses follow a consistent format.
- Unit tests cover: all endpoints (happy path + error cases), bearer token validation (valid, missing, invalid), pagination (cursor navigation, limit), status filtering, input validation (missing fields, wrong types), user scoping (no cross-user access).
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- `pnpm test` passes all REST API tests.
- `curl -H "Authorization: Bearer TOKEN" POST /api/v1/requests` creates a request.
- `curl GET /api/v1/requests/:id` returns the request with its current status.
- Pagination: request with `limit=2` returns 2 items and a cursor for the next page.
- Invalid token → 401. Missing required field → 400 with descriptive error.

## Review plan

- Verify all endpoints are scoped to the authenticated user (no IDOR).
- Verify input validation covers required fields and type constraints.
- Verify pagination uses cursor-based approach (not offset-based).
- Check error response consistency across all endpoints.
- Review test coverage: auth rejection, pagination edge cases (empty page, last page), invalid input shapes.
