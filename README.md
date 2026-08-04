# @gluecrawl/n8n-nodes-gluecrawl

This is an n8n community node. It lets you use **[Gluecrawl](https://www.gluecrawl.ai)** in your
n8n workflows.

> Point Gluecrawl at a URL and describe what you want in plain English. Its mapper agents work
> out the selectors and pagination once, then every later run replays that config
> deterministically and returns structured rows.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/reference/license/)
workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[AI Agent Tool Usage](#ai-agent-tool-usage)
[Development](#development)
[Resources](#resources)
[Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
in the n8n community nodes documentation, using the package name
`@gluecrawl/n8n-nodes-gluecrawl`.

Manual install, from your n8n user folder:

```bash
cd ~/.n8n
npm install @gluecrawl/n8n-nodes-gluecrawl
```

Restart n8n afterwards.

> [!NOTE]
> n8n Cloud installs **verified** community nodes only. This package is built against the
> verification rules and is submitted through the n8n Creator Hub. Until verification is granted,
> use self-hosted n8n.

## Operations

The package ships two nodes.

### Gluecrawl

| Resource | Operation    | Endpoint                      | Notes                                                                        |
| -------- | ------------ | ----------------------------- | ---------------------------------------------------------------------------- |
| Job      | Create       | `POST /v1/jobs`               | URL plus a **Goal** or explicit **Columns**. **Charges credits upfront.**    |
| Job      | Get          | `GET /v1/jobs/{id}`           | Status, and once `ready` the `columns` the scraper will produce              |
| Job      | Get Many     | `GET /v1/jobs`                | Paginated, with Return All                                                   |
| Job      | Delete       | `DELETE /v1/jobs/{id}`        | Cascade-deletes the job's schedule. Irreversible.                            |
| Run      | Start        | `POST /v1/jobs/{id}/runs`     | Reruns a `ready` job on its cached config. No LLM work, no upfront charge.   |
| Run      | Get          | `GET /v1/runs/{id}`           | Status, item and page counts, credits used, billing breakdown                |
| Run      | Get Many     | `GET /v1/jobs/{id}/runs`      | Run history for one job, paginated                                           |
| Run      | Get Items    | `GET /v1/runs/{id}/items`     | One n8n item per scraped row. Return All auto-paginates at 500 rows/request. |
| Run      | Download CSV | `GET /v1/runs/{id}/items/csv` | The run's rows as a CSV file on the item's binary property                   |

Each operation is its own entry in the node panel — search "Gluecrawl" and pick the action
directly.

The rows a scrape produced are **operations on Run**, not a resource of their own: `/v1` has no
item entity to address, and every row endpoint is keyed on a run.

### Gluecrawl Trigger

| Event           | Fires when                                             |
| --------------- | ------------------------------------------------------ |
| `run.completed` | A run reached `completed`. The usual entry point.      |
| `run.failed`    | A run reached `failed`                                 |
| `job.ready`     | The mapper finished and the job is scrapeable          |
| `job.failed`    | The mapper failed; the job is dead and needs replacing |

An optional **Job** filter drops events for other jobs. Leave it empty to receive events for
every job on the account.

## Credentials

API keys are available on **every paid plan (Starter and above)**. The Free plan can use the
dashboard but cannot mint a key — a `403` saying your plan does not include API access is this
gate, and is fixed on the [pricing page](https://www.gluecrawl.ai/#pricing).

1. Sign up at [gluecrawl.ai](https://www.gluecrawl.ai) and verify your email address.
2. Mint a key in the dashboard under **Settings → API keys**.
3. In n8n, create a **Gluecrawl API** credential and paste the key.

| Field        | Notes                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| **API Key**  | Stored encrypted by n8n, sent as `Authorization: Bearer <key>`                                          |
| **Base URL** | Defaults to `https://api.gluecrawl.ai`. A trailing slash, or a URL already ending in `/v1`, is handled. |

Press **Test** after saving. The test issues a cheap authenticated read (`GET /v1/jobs?limit=1`)
because `/v1` has no dedicated auth-check endpoint, and it distinguishes a bad key from an
unverified email address and from a plan without API access.

> [!IMPORTANT]
> There is **one active key per account**. Minting a new key revokes the previous one
> immediately, and every workflow still using it starts failing with `invalid_api_key`.

## Compatibility

- **Node.js 22 or higher.**
- **n8n 1.79.0 or higher** for AI tool support. Earlier versions work for everything else.
- Developed and tested against `n8n-workflow` 2.x.
- Zero runtime dependencies, by design — an n8n Cloud verification requirement.

## Usage

### The Job → Run → rows model

A **job** holds the mapper config for one URL. Creating one runs the LLM mapper and charges
credits upfront. A **run** executes that config and produces **rows**. Reruns skip the mapper
entirely, so create the job once and rerun it.

Job statuses:

| Status        | Meaning                                                         |
| ------------- | --------------------------------------------------------------- |
| `in_progress` | Mapping is still running                                        |
| `ready`       | Mapper config exists; the job can be rerun cheaply              |
| `failed`      | Mapping failed. **Terminal.**                                   |
| `stale`       | A scrape found zero items, usually a site change. **Terminal.** |

Gluecrawl never re-maps an existing job, so retrying a run against a `failed` or `stale` one
keeps returning `409 job_not_ready`. Create a new job instead.

### Picking jobs and runs

**Job** and **Run** fields are pickers with two modes: **From List** (browse or search your
account — select the credential first) and **By ID** (paste a UUID, or use an expression such as
`{{ $json.id }}`).

- Jobs are listed as `host - status`, runs as `timestamp - status`. Two jobs on the same host
  with the same status look identical — pick by ID if you keep several.
- `Run: Get`, `Run: Get Items` and `Run: Download CSV` ask for a **Job** as well as a **Run**.
  The job only scopes the run list; it is not sent to the API. Every Gluecrawl output carrying a
  run ID carries the job ID beside it, so both fields fill from the same upstream record.
- Changing the Job does **not** clear a run already chosen — that is n8n's behaviour for any
  dependent picker. The node checks the two agree before reading anything, so a stale selection
  fails loudly instead of returning another job's data.

### Waiting for a scrape to finish

Job: Create and Run: Start both offer **Wait for Completion**, which polls `/v1` in-process until
the work is done. It is **off by default**.

> [!WARNING]
> The poll holds the n8n execution for the whole scrape — on n8n Cloud, one of your plan's
> concurrency slots (5 on Starter, 20 on Pro). Job: Create is the expensive one: it waits out the
> LLM mapper _and_ the first scrape.

- **Webhook-triggered workflows should leave it off.** n8n fails a webhook request that has not
  answered within 100 seconds with a `524`, well under the wait's own 300-second default.
- **A timeout does not cancel anything.** `/v1` has no cancel endpoint. On expiry the node fails
  with an error naming the run id, but the run keeps executing and is **still charged**. Recover
  it with Run: Get / Run: Get Items, or let the trigger pick it up. Retrying starts a second
  billable run.
- **Stopping the execution does stop the polling.** "Stop execution", a workflow timeout or a
  worker shutdown ends the wait on the next tick, and the node makes no further API calls. The
  same caveat as a timeout applies to the work itself: the run continues on Gluecrawl's side and
  is still charged, so collect it by run id rather than starting another.
- Turn it on for short interactive scrapes and the AI-agent path. For anything scheduled or
  high-volume, leave it off and let the Gluecrawl Trigger wake the workflow on `run.completed`.

### Output shapes

- **Scraped rows.** Job: Create (with row output on) and Run: Start emit identical keys: the
  row's extracted columns plus `run_id`, `page_number` and `item_index`. Those three are written
  last, so they win a name clash with a column of the same name. Use Run: Get Items with
  **Simplify** on for the raw, un-merged row.
- **Simplify.** Job: Get and Run: Get return the raw record by default. The toggle flattens
  nested fields — a job's `input` and `columns` to the goal text and column names, a run's
  `billing` to `credits_settled`. Job: Delete confirms with `{deleted: true, id}`.
- **Continue On Fail.** Every operation emits the same error item: `error` holds the summary,
  `errorDescription` the actionable half. Run-scoped operations also carry `run_id`. One Switch
  expression covers the whole package.

### Trigger behaviour

**Each trigger workflow registers its own endpoint.** An account holds up to 5. If it is at the
cap, activation fails with an error naming the limit; the node never deletes one of your
endpoints to make room.

**Adopt, don't clobber.** The trigger only touches an endpoint pointing at itself. On activation
it adopts an endpoint already pointing at this workflow's URL (updating the event list if it
drifted) or registers a new one; endpoints pointing elsewhere are never repointed or deleted. On
deactivation it deletes the endpoint **only if it created it and it still points here**, so
deactivating a workflow can never destroy a webhook you configured yourself.

**Deliveries are signed** with HMAC-SHA256 over the exact bytes sent:

```
X-Gluecrawl-Signature: t=<unix seconds>,v1=<hex digest>
```

signed as `{timestamp}.{raw body}` with a per-endpoint secret. **A delivery that does not verify
is rejected** and never reaches your workflow. The timestamp is inside the signed material and
checked against a 5-minute tolerance, so a captured delivery cannot be replayed.

> [!NOTE]
> Gluecrawl discloses the secret once, when the endpoint is created. An endpoint the node
> **adopted** therefore has a secret it never saw, and its deliveries are refused. Deactivate and
> reactivate to register an endpoint the node owns.

After verifying, the node fetches the referenced run or job and emits the API record rather than
the bare payload, since the next node usually wants it. A `webhook.test` delivery is emitted as a
marked test item (`test: true`) — trigger one from the dashboard to confirm wiring without
running a scrape.

**Delivery is at-least-once.** Gluecrawl attempts each delivery up to 5 times, backing off
roughly 10s, 30s, 2m and 10m, with a 10-second timeout per attempt. A brief n8n outage costs
latency rather than the event — but **your workflow can see the same event twice**. Key
de-duplication on the payload's `event_id`.

Webhook targets must be **https** and resolve to a **public** IP; `http://localhost` and private
ranges are rejected with `422 invalid_webhook_url`.

### Costs and rate limits

**Every Job: Create mints a persistent job and runs the LLM mapper.** The creation cost is
charged upfront and there is no dedupe by URL, so:

- Give AI agents a small **Max Pages**, and steer them toward **Run: Start** against an existing
  job.
- For anything recurring, create the job once and rerun it.
- Jobs persist until deleted. Housekeeping is Job: Get Many + Job: Delete.

Runs that fail through the platform's dead-letter path are refunded automatically, as is
`502 enqueue_failed`, which is safe to retry.

| Endpoint group                          | Limit            |
| --------------------------------------- | ---------------- |
| Job: Create                             | 60 / minute      |
| Run: Start                              | 10 / minute      |
| Webhook create / update / delete / test | 10 / minute      |
| All GET operations, including CSV       | not rate limited |

Exceeding a limit returns `429`; the node surfaces `Retry-After` in the error so a Wait node or
n8n's retry setting can honour it.

### Example workflows

| Goal              | Workflow                                                                       |
| ----------------- | ------------------------------------------------------------------------------ |
| Scheduled refresh | Schedule Trigger → Gluecrawl (Run: Start, wait on) → Run: Get Items → Sheets   |
| Event-driven      | Gluecrawl Trigger (`run.completed`) → Run: Get Items → transform → destination |
| On-demand scrape  | Form / Chat trigger → Gluecrawl (Job: Create, goal mode, wait on) → reply      |

The event-driven shape is the one to prefer at any volume: the workflow wakes only when a run
actually finishes, and costs no execution time while the scrape is running.

## AI Agent Tool Usage

The action node sets `usableAsTool`, so an AI Agent can call it directly. Gluecrawl returns
tabular JSON rather than a Markdown blob, which is what makes the result usable by the next tool
in the chain without a parsing step.

- **Self-hosted n8n needs `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`** to allow community
  nodes as AI tools.
- The canonical agent call is **Job: Create** in goal mode with **Wait for Completion** and row
  output on — an agent has nowhere to put a job id it cannot resolve in the same call. This is
  the one place the inline wait is clearly worth it.
- Job and Run fields are resource locators, so `$fromAI()` can fill them. Point agents at
  **Run: Start** against an existing job wherever one exists — it skips the mapper and the
  upfront charge.
- Keep **Max Pages** small. Every Job: Create an agent makes is a new billable job.

## Development

Node 22 and npm. No runtime dependencies, so `npm ci` installs only the toolchain.

```bash
npm ci
npm run lint        # eslint, including the n8n community-node ruleset
npm run typecheck
npm test            # jest, /v1 mocked with nock
npm run build       # tsc to dist/ plus icon assets
npm run scan        # the n8n community-package scan, source and packed tarball
```

To try the nodes in a real editor:

```bash
npm run build
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes && npm install /absolute/path/to/gluecrawl-n8n
```

**Testing the trigger locally needs a public URL.** Gluecrawl refuses non-https and private-IP
targets, so `http://localhost:5678/...` fails with `422 invalid_webhook_url` — including on "Test
workflow", which calls the same registration hook. `n8n start --tunnel` no longer works: n8n 2.0
removed the flag and **ignores it silently**, leaving the webhook base URL on localhost. Run your
own tunnel and hand n8n its address:

```bash
cloudflared tunnel --url http://localhost:5678   # prints https://<name>.trycloudflare.com
N8N_WEBHOOK_URL="https://<name>.trycloudflare.com" npx n8n start
```

`N8N_WEBHOOK_URL` is the n8n 2.x name for the old `WEBHOOK_URL`. n8n echoes the value on startup
("Editor is now accessible via: ..."), the quickest check that the node will register a public
URL. Quick tunnels get a fresh hostname every restart, so expect to re-register the trigger.

**Releasing** is tag-driven and CI-only. Land on `main` with CI green, bump `version`, then
`git tag vX.Y.Z && git push origin vX.Y.Z`. The publish workflow builds, tests and publishes with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements), which verified
community nodes must carry. **Never run `npm publish` locally** — a local publish produces an
unattested tarball.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [Gluecrawl](https://www.gluecrawl.ai) — product, pricing and dashboard
- [Issues and feature requests](https://github.com/deep-soup-labs/gluecrawl-n8n/issues)

## Version history

### Unreleased

- **Wait for Completion now honours execution cancellation.** Stopping a workflow — from the
  editor, a workflow timeout, or a queue-mode worker shutting down — previously left the poll
  sleeping out its current tick and then issuing more API calls for the rest of its timeout
  budget. It now stops on the next tick and makes no further calls. A cancellation is also no
  longer reported as a Gluecrawl failure, and is no longer converted into an error item when
  Continue On Fail is on.

### 1.0.2

Why it changed: the wait is an in-process poll that holds the n8n execution — and a Cloud
concurrency slot — for the whole scrape, and it timed out on the default path. A timeout there
cancels nothing, because `/v1` has no cancel endpoint, so the run kept going and stayed billable.

- The **Timeout** field is unchanged at 300s and still unbounded.
- README restructured onto n8n's community-node template.

### 1.0.1

- Dropped the endpoint notice from the Gluecrawl Trigger parameters
- Published under the `@gluecrawl` npm org

### 1.0.0

- Initial release: Job and Run operations, the Gluecrawl Trigger, and AI tool support

## License

[MIT](LICENSE)
