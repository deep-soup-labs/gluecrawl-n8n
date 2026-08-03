# CLAUDE.md

## What this is

`n8n-nodes-gluecrawl` is the n8n community-node package wrapping Gluecrawl's public `/v1` API.
Two node classes (`Gluecrawl` action node, `Gluecrawl Trigger` webhook node) plus one credential
(`Gluecrawl API`). It is a **pure client** — no backend changes belong here, and no Gluecrawl
business logic is reimplemented in it.

The repo is public and MIT-licensed because n8n Cloud verification requires both.

**API-side truth lives in `gluecrawl-api/CLAUDE.md`** (auth, credits, job/run status machines,
the `/v1` routers under `app/routers/v1/`). When this package's behaviour and that repo disagree,
that repo wins — read the router before "fixing" a node. The workspace-root `CLAUDE.md` has the
cross-repo picture.

## Non-negotiable constraints (n8n Cloud verification)

Verification is a hard gate: unverified packages cannot be installed on n8n Cloud at all, which
is the whole point of the project. Breaking any of these fails the review, not just the build.

- **Zero runtime dependencies.** `dependencies` in `package.json` must stay empty/absent.
  `n8n-workflow` is a `peerDependency` + `devDependency` only. No axios, no lodash, no
  node-fetch, no date libraries. Every HTTP call goes through
  `this.helpers.httpRequestWithAuthentication` / `this.helpers.httpRequest`, which is why
  `nodes/Gluecrawl/transport/` exists — operations never call the helpers directly.
- **No `process.env`, no `fs`, no `child_process`.** Configuration comes from the credential
  (including the base URL) and from node parameters. Nothing else.
- **One service per package.** No generic HTTP escape hatch, no second vendor.
- **English only**, in code, comments, docs and user-facing strings.
- Node 22, TypeScript `strict`. `npm run lint` includes `@n8n/eslint-plugin-community-nodes`,
  which encodes most of the review checklist — treat its warnings as errors.
- Before a release submission, run `npm run scan` and expect it clean. **`npm run lint` is not
  a substitute**: the scan additionally applies `eslint-plugin-n8n-nodes-base` (parameter-copy
  and icon rules) and runs with `allowInlineConfig: false`, so an `eslint-disable` comment in
  the source does not suppress a scan finding. The published `npx @n8n/scan-community-package`
  CLI only accepts an npm package name with provenance, so it cannot run against a working
  tree — `scripts/scan.mjs` drives the same scanner library over the local source and a
  freshly packed tarball, which is the two legs the real scan performs.

## The `/v1` error contract

There are **four** shapes to handle, and code that handles only the first shows users
"undefined":

| Shape | Body                                  | Produced by                                                                                                                                                                                |
| ----- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A     | `{"error": {"code", "message", ...}}` | Every `HTTPException` path in the API.                                                                                                                                                     |
| B     | `{"detail": [{loc, msg, type}]}`      | FastAPI request validation. **The API registers no `RequestValidationError` handler**, so this is genuinely reachable — `max_pages > 100`, a malformed `input` union, a bad schedule body. |
| C     | Not JSON                              | ALB/CloudFront HTML, an empty body, a timeout with no response at all.                                                                                                                     |
| D     | Flat `{code, message, status}`        | A failure something already normalised — what a `NodeApiError` carries on `errorResponse`.                                                                                                 |

All four are normalised in `nodes/Gluecrawl/transport/errors.ts` and nowhere else. Envelope A
carries useful extras beyond `code`/`message` (`limit`, `upgrade_url`, ...) — keep them on the
`NodeApiError` rather than flattening them away.

### `NodeApiError` must be unwrapped, not passed through

**n8n-core never hands a node the raw HTTP failure.** `httpRequestWithAuthentication` catches it
and re-throws `new NodeApiError(this.getNode(), error)`. So at runtime every failure reaching
`toGluecrawlApiError` is already a `NodeApiError`, and a blanket "already a `NodeApiError`, leave
it alone" short-circuit silently disables the entire mapper in production — every code-specific
message and both `isGluecrawlErrorCode` branches in the trigger — while
every unit test still passes, because the tests throw the axios-shaped error the code was written
against.

That wrapper keeps the parsed response body on `context.data` (not `cause`, which the class
field declaration overwrites with `undefined`) and the status on `httpCode`. Both are probed.

The errors this package builds are tagged with `markGluecrawlError` instead, and only a tagged
error short-circuits. **Any new hand-built `NodeApiError` carrying Gluecrawl copy must be marked**,
or the first operation-level re-wrap flattens it into a generic transport failure.

### One error-item shape, everywhere

Every operation's "Continue On Fail" branch emits `{error, errorDescription}` via
`resources/shared.ts` → `errorOutputItem`, plus resource context such as `run_id`. Map the error
**before** the `continueOnFail()` check: `description` is the actionable half, and dropping it is
exactly what makes a mapped error useless to the user who chose to keep going.

### Status → code map

| Status | Code                    | Node behaviour                                                                                                                           |
| ------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | `invalid_api_key`       | Point at the dashboard; note that minting a new key revokes the old one.                                                                 |
| 403    | `email_not_verified`    | Account-level, not key-level. Must be mapped — the PRD omitted it.                                                                       |
| 403    | `plan_required`         | Echo the API message and add the upgrade URL. API access starts at Starter.                                                              |
| 402    | `insufficient_credits`  | Add credits; not retryable as-is.                                                                                                        |
| 404    | `not_found`             | Wrong id, wrong account, or a deleted job/run.                                                                                           |
| 409    | `job_not_ready`         | Either mapping is still in progress, or the job is `failed`/`stale` — which is terminal and needs a **new job**, not a retry. Say which. |
| 409    | `job_limit_reached`     | Genuinely reachable: Starter caps active jobs at 10 (Pro/Enterprise are uncapped). Real UX, not defensive mapping.                       |
| 409    | `webhook_limit_reached` | The account has no free endpoint slots (cap is API-side, currently 5). Carries `limit`. Trigger-specific.                                |
| 422    | `page_limit_exceeded`   | Carries `limit` + `upgrade_url`. Every API-capable plan caps at 100 pages — the node's own `MAX_MAX_PAGES` — so map defensively.         |
| 422    | `invalid_webhook_url`   | Target is not https, or resolves to a private/loopback IP.                                                                               |
| 429    | `rate_limited`          | Surface `Retry-After` from the response headers.                                                                                         |
| 502    | `enqueue_failed`        | Retryable; credits are auto-refunded. Say so, so users retry instead of filing a bug.                                                    |

### `plan_required`

API access starts at **Starter** (`allows_api = true`, one key), so the API's own
"requires a Starter plan or higher" message is correct and is echoed straight through, like every
other code. Only Free cannot mint a key. The override that used to rewrite this copy to
Pro/Enterprise is gone — do not reintroduce it.

### Rate limits worth remembering

Job create 60/min; schedule set/remove 60/min; run start 10/min; webhook mutations (create,
update, delete, test) 10/min. GETs are not rate limited at the v1 layer, which is what makes the
wait-loops and Return All auto-pagination affordable.

## Trigger conventions

An account holds **several** webhook endpoints (the API caps them; 5 at the time of writing,
enforced as an application-level count, not a database constraint). Each trigger workflow
registers its **own**, so workflows no longer compete for a slot.

**Adopt, don't clobber** still holds, and still exists to avoid destroying something the user
configured elsewhere — it is just no longer the common path.

- `checkExists`: `GET /v1/webhooks`; an endpoint whose `url` equals this workflow's webhook URL
  counts as existing. If the event set drifted, `PATCH` it rather than recreating.
- `create`: reuse an endpoint already pointing **here**; otherwise `POST` a new one. Endpoints
  pointing elsewhere are ignored, never repointed or deleted. A `409 webhook_limit_reached`
  surfaces the cap and tells the user to free a slot — the node never evicts one to make room.
- `delete`: only delete an endpoint **this node created** _and_ that still points here. Ownership
  (endpoint id + `createdByNode` flag) is recorded in workflow static data; an adopted endpoint
  survives deactivation.

Ownership belongs to the **endpoint**, not to the node, and three rules keep it that way:

- The flag may only survive when `staticData.webhookId` still equals the id of the endpoint
  found. Deleting an endpoint in the dashboard and re-creating it against the same n8n URL mints
  a new id, and carrying the flag across that would let deactivation destroy a user-created
  endpoint.
- `delete` re-lists first. `PATCH` can change an endpoint's `url` while keeping its id, so the
  remembered id alone does not prove the endpoint still belongs here.
- `delete` clears the ownership record **only after** the API call succeeds (or 404s).

**Verify the signature, then emit.** Deliveries carry
`X-Gluecrawl-Signature: t=<unix>,v1=<hex hmac-sha256>` over `{timestamp}.{raw body}`, keyed by a
per-endpoint secret. Three things follow, and all three are load-bearing:

- Verification runs against `getRequestObject().rawBody`, **never** against `getBodyData()`.
  The signature covers transmitted bytes; a re-serialised object is a different byte string.
- A delivery that does not verify is **rejected** (the node throws), not emitted. Failing closed
  is safe precisely because deliveries are now retried — see below.
- The secret is disclosed **once**, in the `POST /v1/webhooks` response, and is stored in
  workflow static data next to the ownership record. An **adopted** endpoint's secret went to
  whoever created it, so `create` deliberately clears any stored secret when adopting, and the
  handler then fails closed rather than verifying against a wrong key.

The subsequent `GET /v1/runs/{id}` (or `/v1/jobs/{id}`) is now **enrichment**, not authentication:
payloads carry only ids and statuses, and downstream nodes want the record. It is still bounded
by `VERIFY_TIMEOUT_MS` so the handler answers before the API abandons the attempt.

**Delivery is at-least-once within a bounded budget**: 5 attempts, 10s/30s/2m/10m backoff, 10s
per attempt. Two consequences for anything built on this: a consumer must tolerate **duplicates**
(a delivery that succeeded but whose acknowledgement was lost is retried), and the stable event
`id` in the payload is what makes de-duplication possible. Anything in the docs implying
exactly-once delivery is wrong.

## Wait loops do not cancel anything

`/v1` has no cancel endpoint. The wait options on Job: Create and Run: Start are polling loops
and nothing more. On timeout, throw a `NodeApiError` whose message contains the run id **and**
states plainly that the run is still executing and will still be charged. Never word a timeout as
if the run was aborted — that is the single easiest way to mislead a user into paying twice by
retrying.

Related: every Job: Create mints a persistent job, charges the creation cost upfront, and runs
the LLM mapper. There is no dedupe by URL. That is why the node description and the tool
description steer AI agents toward small `max_pages` and toward Run: Start against an existing
job. Keep that steer in any copy you edit.

## Layout and boundaries

```
credentials/GluecrawlApi.credentials.ts   API key + Base URL, generic auth, credential test
nodes/Gluecrawl/
  types.ts            /v1 wire types + shared constants (page sizes, max_pages bounds)
  transport/          the only place that talks HTTP: request wrapper, error mapping,
                      poll/wait helpers, offset pagination
  resources/shared.ts   cross-resource output shapes (error item, scraped row)
  resources/{job,run,item}/*.operation.ts
nodes/GluecrawlTrigger/
tests/                jest + nock
```

Icons are `gluecrawl.light.svg` / `gluecrawl.dark.svg`, duplicated next to each node class and
the credential (n8n resolves `file:` relative to the compiled `.js`). SVG is not optional: the
verification scan errors on a PNG icon.

- Operation files import from `transport/`, never from `this.helpers` directly. The base URL
  join, the error normalisation and the auth injection all live in one place precisely so they
  cannot drift per-operation.
- Wire types belong in `types.ts`. Do not redeclare a `Run` shape inside an operation.
- **`null`-valued fields are omitted from `/v1` responses, not sent as `null`** (`error`,
  `schedule`, `input`, `columns`). Optional-chaining everywhere; `columns` only appears once the
  job is `ready`.
- The `input` union's column entries use `type` (`text | number | array | url | date`), **not**
  `description`. An unknown key is silently dropped by the API and `type` defaults to `text`, so
  a typo here produces a wrong job with no error.
- `max_pages` is an integer 1–100 on both create and rerun.

## Dev loop

```bash
npm ci
npm run lint && npm run typecheck && npm test
npm run build          # tsc → dist/ + copy icons
```

Testing inside a real editor: `npm run build`, then
`cd ~/.n8n/nodes && npm install /abs/path/to/this/repo`, then restart n8n.

**The trigger cannot be tested against a local URL.** Gluecrawl rejects webhook targets that are
not https or that resolve to a private/loopback IP (`422 invalid_webhook_url`), so
`http://localhost:5678/webhook/...` is refused at registration time. Use `n8n start --tunnel` or
an ngrok/Cloudflare tunnel, or point the credential's Base URL at staging and register a
publicly reachable URL. There is no offline path — the lifecycle tests mock `/v1` with nock
instead.

Tests: one file per operation, `/v1` mocked with nock, every error-envelope case covered
(including B and C). Trigger tests cover `create`/`checkExists`/`delete` plus inbound payload →
verify-fetch → emit. Before each release, run one end-to-end smoke recipe against staging by
hand — nock cannot catch a contract drift.

## Releasing

Tag-driven, provenance-signed, CI-only.

1. Land on `main`, CI green.
2. Bump `version` in `package.json`, commit.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. `.github/workflows/publish.yml` builds, tests and runs `npm publish --provenance` with
   `id-token: write` and `NPM_TOKEN`.

**Never `npm publish` locally.** A local publish produces a tarball with no provenance
attestation, which fails verification and cannot be un-published cleanly. Verification
submissions go through [creators.n8n.io](https://creators.n8n.io) after the npm release exists.

## Style

Match the surrounding code. Comments explain **why** a non-obvious decision was made (the
error-envelope trio, the adopt-don't-clobber rules, the base-URL join); they never narrate what
the code plainly says. No emojis anywhere — code, comments, docs, commit messages, or output.
