# @gluecrawl/n8n-nodes-gluecrawl

n8n community nodes for [Gluecrawl](https://www.gluecrawl.ai) — agentic web scraping.

Point Gluecrawl at a URL and describe what you want in plain English, or name the columns
yourself. Gluecrawl's mapper agents work out the selectors and pagination once, then every
later run replays that config deterministically. This package exposes that Job → Run → rows
model as n8n operations, plus a webhook trigger that fires when a run finishes.

The package ships two node classes:

- **Gluecrawl** — the action node (jobs, runs, and the rows a run extracted). Also available to
  AI Agents as a tool.
- **Gluecrawl Trigger** — a webhook trigger for `run.completed`, `run.failed`, `job.ready`
  and `job.failed`.

---

## Requirements: the plan gate

**Gluecrawl API keys are available on every paid plan — Starter and above.** The Free plan can
use the dashboard but cannot mint an API key, and without a key these nodes cannot authenticate.

- One **active key per account**. Creating a new key revokes the previous one immediately —
  rotate deliberately, since every workflow using the old key starts failing with
  `invalid_api_key`.
- Keys are minted in the Gluecrawl dashboard under **Settings → API keys**.
- The account's email address must be verified and the account must be active.

If you see a `403` telling you your plan does not include API access, that is this gate. Upgrade
to a paid plan on the [Gluecrawl pricing page](https://www.gluecrawl.ai/#pricing).

---

## Installation

### Self-hosted n8n

In the n8n editor: **Settings → Community Nodes → Install**, enter `@gluecrawl/n8n-nodes-gluecrawl`,
accept the community-node risk prompt, install. n8n restarts the node loader and both nodes
appear in the node panel.

Manual install (Docker or a custom image) — from your n8n user folder:

```bash
cd ~/.n8n
npm install @gluecrawl/n8n-nodes-gluecrawl
```

Restart n8n afterwards.

### n8n Cloud

n8n Cloud installs **verified** community nodes only. This package is built against the
verification rules (zero runtime dependencies, no filesystem or environment access, single
service, MIT licence) and is submitted through the n8n Creator Hub. Until verification is
granted, use self-hosted n8n.

---

## Credential setup

Create a **Gluecrawl API** credential:

| Field        | Notes                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API Key**  | From the Gluecrawl dashboard. Stored encrypted by n8n and sent as `Authorization: Bearer <key>`.                                                                          |
| **Base URL** | Defaults to `https://api.gluecrawl.ai`. Change it only if you were given a different host to target. A trailing slash — or a URL that already ends in `/v1` — is handled. |

Press **Test** after saving. The test issues a cheap authenticated read (`GET /v1/jobs?limit=1`)
because `/v1` has no dedicated auth-check endpoint. A failure distinguishes a bad key from an
unverified email address and from a plan without API access.

---

## Operations

Every operation below is its own entry in the n8n node panel — search for "Gluecrawl" and pick
the action directly; there is no need to drop the node and then hunt through dropdowns.

| Resource | Operation    | Endpoint                      | Notes                                                                                                                                                                                                                                                                                       |
| -------- | ------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Job**  | Create       | `POST /v1/jobs`               | URL plus either a plain-English **Goal** or an explicit **Columns** list (name + type: text, number, array, url, date). Optional **Max Pages** (1–100). Waits for mapping and the first run by default, and can emit the scraped rows directly. **Charges credits — see Costs and limits.** |
| Job      | Get          | `GET /v1/jobs/{id}`           | Returns the job's status and, once `ready`, its `columns` (`listing` / `detail`) — the output schema the scraper will produce.                                                                                                                                                              |
| Job      | Get Many     | `GET /v1/jobs`                | Paginated, with a Return All option.                                                                                                                                                                                                                                                        |
| Job      | Delete       | `DELETE /v1/jobs/{id}`        | Cascade-deletes the job's schedule. Irreversible.                                                                                                                                                                                                                                           |
| **Run**  | Start        | `POST /v1/jobs/{id}/runs`     | Reruns a `ready` job against its cached mapper config — no LLM work, no upfront charge, cost settled after completion. Optional **Max Pages** override. Waits for the run to finish by default.                                                                                             |
| Run      | Get          | `GET /v1/runs/{id}`           | Status, item and page counts, credits used, billing breakdown.                                                                                                                                                                                                                              |
| Run      | Get Many     | `GET /v1/jobs/{id}/runs`      | Run history for one job, paginated.                                                                                                                                                                                                                                                         |
| Run      | Get Items    | `GET /v1/runs/{id}/items`     | One n8n item per scraped row: the row's `data` plus `page_number` and `item_index`. Return All auto-paginates at the API maximum of 500 rows per request.                                                                                                                                   |
| Run      | Download CSV | `GET /v1/runs/{id}/items/csv` | The run's rows as a CSV file on the item's binary property — ready for Gmail, Drive or S3 nodes.                                                                                                                                                                                            |

The rows a scrape produced are **operations on Run**, not a resource of their own. `/v1` has no
item entity to address — every row endpoint is keyed on a run, rows carry no id, and reading is
the only thing you can do with one — so a separate resource only made you pick the same Run
twice under two different names.

### Picking jobs and runs

**Job** and **Run** fields are pickers, not bare text boxes. Each has two modes:

- **From List** — browse or search the jobs on your account, and the runs of the selected job.
  The list is fetched with your credential, so select the credential first.
- **By ID** — paste a UUID, or switch to Expression and wire an ID from an upstream node, e.g.
  `{{ $json.id }}`. This is the mode to use when the ID comes from another node rather than from
  you.

Jobs are listed as `host - status` (a leading `www.` is dropped), runs as
`timestamp - status`. The status matters: **Run: Start** only accepts a `ready` job, and
`failed` / `stale` are terminal — those need a new job, not a retry. Two jobs against the same
host with the same status look identical in the list; pick by ID if you keep several.

`Run: Get`, `Run: Get Items` and `Run: Download CSV` ask for a **Job** as well as a **Run**. The
job is what scopes the run list — `/v1` lists runs only under a job. It is not sent to the API,
which identifies the run by its ID alone. Every Gluecrawl output that carries a run ID carries
the job ID beside it (`Run: Start` returns `job_id` on the run, `Job: Create` returns the job
with the run nested under `run`, and the trigger emits both), so both fields can be filled from
the same upstream record.

Note that changing the Job does **not** clear a run already chosen in the Run field — that is
n8n's behaviour for any dependent picker, not something the node can override. The node checks
the two agree before it reads anything and fails with a clear message if they have drifted
apart, so a mismatch can never quietly return another job's data.

### Output shapes

Two shapes are contracts rather than incidental details, because workflows branch on them.

**Scraped rows.** Job: Create (with row output on) and Run: Start emit the same keys: the
row's extracted columns, plus `run_id`, `page_number` and `item_index`. Those three are written
last, so they win a name clash with a column of the same name — a downstream node correlating
on `run_id` has to be able to trust it. Use Run: Get Items with **Simplify** on if you need the
raw, un-merged row instead.

**Simplify.** Job: Get and Run: Get return the raw record by default and offer a **Simplify**
toggle that flattens the nested fields: a job's `input` and `columns` collapse to the goal text
and the column names, and a run's `billing` collapses to `credits_settled`. It is off by default
on both, because the full record is usually why you fetched one. Job: Delete confirms with
`{deleted: true, id}`.

**Continue On Fail.** Every operation on every resource emits the same error item: `error`
holds the short summary, `errorDescription` holds the actionable half (which plan to upgrade to,
whether a retry helps, whether the job is dead). Operations scoped to one run also carry
`run_id`. One Switch-node expression covers the whole package.

### Job statuses

`in_progress` → mapping is still running. `ready` → mapper config exists; the job can be rerun
cheaply. `failed` → mapping failed. `stale` → a scrape found zero items, usually because the
site changed.

**`failed` and `stale` are terminal.** Gluecrawl does not re-map an existing job, so retrying a
run against one will keep returning `409 job_not_ready`. Create a new job instead.

### AI Agent tool

The action node sets `usableAsTool`, so an AI Agent can call it directly. The canonical agent
call is **Job: Create** in goal mode with waiting and row output enabled: URL plus a
plain-English goal in, structured rows out. Gluecrawl returns tabular JSON rather than a
Markdown blob, which is what makes the result usable by the next tool in the chain without a
parsing step. Read the Costs and limits section before wiring an agent loop to it.

---

## Trigger

The **Gluecrawl Trigger** node subscribes to four events:

| Event           | Fires when                                                              |
| --------------- | ----------------------------------------------------------------------- |
| `run.completed` | A scrape run reached `completed`. The usual entry point for a pipeline. |
| `run.failed`    | A scrape run reached `failed`.                                          |
| `job.ready`     | The mapper finished and the job is scrapeable.                          |
| `job.failed`    | The mapper failed; the job is dead and needs replacing.                 |

An optional **Job** filter drops events for other jobs before they reach the workflow. It is the
same picker the action node uses — choose a job from the list, or paste an ID. Leave it empty to
receive events for every job on the account.

### Several endpoints per account

A Gluecrawl account can hold up to **5 webhook endpoints**, and each Gluecrawl Trigger workflow
registers its own. Several trigger workflows can therefore run side by side, and alongside any
webhook you configured in the dashboard, without competing for a slot.

If the account is already at the cap, activation fails with an error naming the limit. The node
never deletes one of your endpoints to make room.

### Adopt, don't clobber

The trigger only ever touches an endpoint that points at itself:

- **On activation**, the node lists the account's webhooks. If one already points at this
  workflow's webhook URL, the node adopts it and updates the event list if it drifted.
  Otherwise it registers a new endpoint of its own. Endpoints pointing anywhere else are
  ignored — never repointed, never deleted.
- **On deactivation**, the node deletes the endpoint **only if it created it and it still points
  at this workflow**. It re-checks both before deleting, so an endpoint it merely adopted — or
  one you re-created or repointed from the dashboard in the meantime — is left alone.
  Deactivating a workflow can never destroy a webhook you configured yourself.

### Signed deliveries

Every delivery carries an HMAC-SHA256 signature over the exact bytes sent:

```
X-Gluecrawl-Signature: t=<unix seconds>,v1=<hex digest>
```

signed as `{timestamp}.{raw body}` with a secret unique to that endpoint. Gluecrawl discloses
the secret **once**, in the response that creates the endpoint; the trigger stores it with the
workflow and verifies every delivery against it. **A delivery whose signature does not verify is
rejected** — it never reaches your workflow. The timestamp is inside the signed material and is
checked against a 5-minute tolerance, so a captured delivery cannot be replayed later.

One consequence worth knowing: an endpoint the node **adopted** rather than created has a secret
the node never saw, so its deliveries cannot be verified and are refused. Deactivate and
reactivate the workflow to register an endpoint it owns.

After verifying, the node fetches the referenced run (or job) from `/v1` and emits the API's
response rather than the bare payload. That is now purely for convenience — payloads carry only
ids and statuses, and the next node (usually **Run: Get Items**) wants the record.

A `webhook.test` delivery is emitted as a clearly marked test item (`test: true`), so you can
confirm the wiring end to end without running a scrape. The node does not send one itself:
trigger it from the Gluecrawl dashboard, or by calling `POST /v1/webhooks/{id}/test` against the
endpoint the trigger registered.

### Delivery is at-least-once

Gluecrawl attempts each delivery up to **5 times**, backing off roughly 10s, 30s, 2m and 10m,
with a 10-second timeout per attempt. A brief n8n outage therefore costs latency rather than the
event.

The flip side is that **your workflow can see the same event twice**: a delivery that arrived and
was processed but whose acknowledgement was lost gets retried. Each payload carries a stable
event id (`event_id` on the emitted item) — key your de-duplication on that if replaying an event
would be harmful. Where completeness matters more than duplication, recipe A's periodic sweep is
still a good backstop.

Webhook target URLs must be **https** and resolve to a **public** IP. `http://localhost` and
private ranges are rejected with `422 invalid_webhook_url`, which is why testing the trigger
against a local n8n needs a public tunnel (see Local development).

---

## Recipes

### A. Scheduled refresh

**Schedule Trigger → Gluecrawl (Run: Start) → Gluecrawl (Run: Get Items) → Google Sheets.**

Run an existing `ready` job on n8n's clock. Because the job is already mapped there is no LLM
work and no upfront charge — the run replays the cached config. Leave waiting enabled so the
Get Items step sees a completed run, then dedupe on a stable key before appending rows.

### B. Event-driven pipeline

**Gluecrawl Trigger (`run.completed`) → Gluecrawl (Run: Get Items) → transform → destination.**

No polling and no wasted executions: the workflow wakes only when a run actually finishes. The
trigger's verified output already carries the run id, so the Get Items step just reads it.

### C. On-demand scrape

**Form / Chat trigger → Gluecrawl (Job: Create, goal mode, wait + output rows) → reply.**

The user supplies a URL and a goal; the node mints the job, waits for mapping and the first run,
and emits the rows. Two nodes, one round trip. This is also the AI-agent path — keep Max Pages
small here, since each submission is a new billable job.

---

## Costs and limits

Gluecrawl bills in credits. Two behaviours are worth internalising before you automate against
this package.

**A wait timeout does not cancel the run.** The wait options on Job: Create and Run: Start poll
the API; they do not control it. `/v1` has no cancel endpoint. When a wait exceeds its timeout
the node fails with an error containing the run id, but **the run keeps executing on
Gluecrawl's side and is still charged**. Recover it later with Run: Get / Run: Get Items using
that id, or let the trigger pick up its completion. Raising the timeout is usually a better
answer than retrying, because a retry starts a second billable run.

**Every Job: Create mints a persistent job and runs the LLM mapper.** The job-creation cost is
charged upfront, at creation time, and mapping happens on every new job — there is no dedupe by
URL. Consequences:

- An AI Agent looping on Job: Create accumulates jobs and credits, quickly. Give agents a small
  Max Pages, and steer them toward **Run: Start** against an existing job whenever one already
  exists for that URL.
- For anything recurring, create the job once and rerun it. Reruns skip the mapper entirely.
- Jobs persist until deleted. Housekeeping is Job: Get Many + Job: Delete.

Runs that fail through the platform's dead-letter path have their credits refunded
automatically; `502 enqueue_failed` is likewise refunded and is safe to retry.

### Rate limits

| Endpoint group                                   | Limit            |
| ------------------------------------------------ | ---------------- |
| Job: Create                                      | 60 / minute      |
| Run: Start                                       | 10 / minute      |
| Webhook create / update / delete / test          | 10 / minute      |
| All GET operations (job, run and row reads, CSV) | not rate limited |

Exceeding a limit returns `429`; the node surfaces the `Retry-After` value in the error so a
Wait node or n8n's own retry setting can honour it.

---

## Local development

Node 22 and npm. The package has **no runtime dependencies** by design (an n8n Cloud
verification requirement), so `npm ci` only installs the toolchain.

```bash
npm ci
npm run lint        # eslint, including the n8n community-node ruleset
npm run typecheck
npm test            # jest, /v1 mocked with nock
npm run build       # tsc to dist/ plus icon assets
npm run format      # prettier
```

To try the nodes in a real editor, build and link the package into your n8n user folder:

```bash
npm run build
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes && npm install /absolute/path/to/gluecrawl-n8n
```

Restart n8n and the nodes appear in the panel.

**Testing the trigger locally needs a public URL.** Gluecrawl rejects webhook targets that are
not https or that resolve to a private IP, so `http://localhost:5678/...` will be refused with
`422 invalid_webhook_url`. This applies to "Test workflow" as much as to activation: n8n calls
the same `create` hook for the `/webhook-test/` URL.

`n8n start --tunnel` no longer works — n8n 2.0 removed the flag and **ignores it silently**, so
the run looks normal while the webhook base URL stays `http://localhost:5678`. Put your own
tunnel in front of n8n instead and tell n8n its public address:

```bash
cloudflared tunnel --url http://localhost:5678   # prints https://<name>.trycloudflare.com
N8N_WEBHOOK_URL="https://<name>.trycloudflare.com" npx n8n start
```

`N8N_WEBHOOK_URL` is the n8n 2.x name for what used to be `WEBHOOK_URL`. n8n echoes the value
back on startup ("Editor is now accessible via: ..."), which is the quickest way to confirm the
node will register a public URL rather than a loopback one. A quick tunnel gets a fresh hostname
every restart, so re-registering the trigger after a restart is expected.

---

## Releasing

Publishing runs in CI with an [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
statement, which verified community nodes are required to carry. **Never run `npm publish`
locally** — a local publish produces an unattested tarball.

1. Land the change on `main` with CI green.
2. Bump `version` in `package.json` and commit.
3. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
4. The `publish` workflow builds, tests, and publishes with `--provenance`.
5. For a first-time or re-verification submission, follow up on
   [creators.n8n.io](https://creators.n8n.io).

---

## Support

- Gluecrawl product and account questions: [gluecrawl.ai](https://www.gluecrawl.ai)
- Bugs and feature requests for these nodes:
  [GitHub issues](https://github.com/deep-soup-labs/gluecrawl-n8n/issues)

## License

[MIT](LICENSE)
