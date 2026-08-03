/**
 * Wire types for the Gluecrawl `/v1` API.
 *
 * Mirrors `gluecrawl-api/app/schemas/v1/*` exactly. Two API quirks are encoded
 * here and matter to every consumer:
 *
 * 1. Null-valued optional fields are OMITTED from the JSON, not sent as null.
 *    That is why the optional fields below are `?:` rather than `| null`.
 * 2. `Job.columns` only materialises once the mapper has produced a config,
 *    i.e. once `status === 'ready'`.
 */

import type { IDataObject } from 'n8n-workflow';

// -------------------------------------------------------------------------
// Jobs
// -------------------------------------------------------------------------

/** `agent_status` on the underlying record. `failed` and `stale` are terminal. */
export type JobStatus = 'in_progress' | 'ready' | 'failed' | 'stale';

/** Job statuses past which the mapper will never run again for this job. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['ready', 'failed', 'stale'];

/** Job statuses that mean the job is unusable and needs replacing, not retrying. */
export const DEAD_JOB_STATUSES: readonly JobStatus[] = ['failed', 'stale'];

/** Derived from the handler the job bills at. */
export type ProtectionLevel = 'light' | 'moderate' | 'heavy' | 'strict';

export type ColumnType = 'text' | 'number' | 'array' | 'url' | 'date';

export const COLUMN_TYPES: readonly ColumnType[] = ['text', 'number', 'array', 'url', 'date'];

/**
 * A requested extraction column. The field is `type`, never `description` —
 * the API silently drops unknown keys and defaults `type` to `text`.
 */
export interface ColumnSpec {
	name: string;
	type: ColumnType;
}

export interface GoalInput {
	type: 'goal';
	value: string;
}

export interface ColumnsInput {
	type: 'columns';
	value: ColumnSpec[];
}

/** Tagged union discriminated on `type`; exactly one of goal/columns. */
export type JobInput = GoalInput | ColumnsInput;

/** Columns the mapper actually resolved, split by page role. */
export interface JobColumns {
	listing: ColumnSpec[];
	detail: ColumnSpec[];
}

export interface Job {
	id: string;
	url: string;
	input?: JobInput;
	columns?: JobColumns;
	status?: JobStatus;
	protection_level?: ProtectionLevel;
	max_pages?: number;
	schedule?: ScheduleConfig;
	error?: string;
	created_at: string;
	updated_at: string;
}

/** Body of `POST /v1/jobs`. */
export interface CreateJobBody extends IDataObject {
	url: string;
	input: JobInput;
	max_pages?: number;
}

// -------------------------------------------------------------------------
// Schedules
// -------------------------------------------------------------------------

export type ScheduleIntervalType = 'one-time' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

export const SCHEDULE_INTERVAL_TYPES: readonly ScheduleIntervalType[] = [
	'one-time',
	'minutes',
	'hours',
	'days',
	'weeks',
	'months',
];

/**
 * Body of `PUT /v1/jobs/{id}/schedule`.
 *
 * API-side validator: `interval_type: 'weeks'` requires a non-empty `weekdays`
 * AND `every === 1` (EventBridge cron cannot express multi-week intervals with
 * weekdays). Enforce that in the node UI rather than letting the user find out
 * via a 422.
 */
export interface ScheduleConfig extends IDataObject {
	enabled: boolean;
	interval_type: ScheduleIntervalType;
	every: number;
	/** 12-hour clock, e.g. "9:00 AM". */
	time: string;
	/** 0-6; required and only meaningful for `weeks`. */
	weekdays: number[];
	day_of_month: number;
	start_date: string | null;
	max_pages: number | null;
}

// -------------------------------------------------------------------------
// Runs
// -------------------------------------------------------------------------

export type RunStatus = 'pending' | 'scraping' | 'completed' | 'failed';

/**
 * The only two statuses a wait-loop may stop on. Anything else — including a
 * status this package does not know about — is treated as still running and
 * bounded by the caller's timeout.
 */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed'];

/** Present only on completed runs whose handler and billing units are known. */
export interface RunBilling {
	listing_pages: number;
	detail_items: number;
	protection_level: ProtectionLevel | '';
	credits_settled: number;
}

export interface Run {
	id: string;
	job_id: string;
	status: RunStatus;
	protection_level?: ProtectionLevel;
	max_pages?: number;
	item_count?: number;
	page_count?: number;
	credits_used?: number;
	billing?: RunBilling;
	error?: string;
	created_at: string;
	completed_at?: string;
}

/** Body of `POST /v1/jobs/{id}/runs`. */
export interface StartRunBody extends IDataObject {
	max_pages?: number;
}

// -------------------------------------------------------------------------
// Items
// -------------------------------------------------------------------------

/** One extracted row. `data` keys are job-specific and not known ahead of time. */
export interface Item {
	data: IDataObject;
	page_number: number;
	item_index: number;
}

// -------------------------------------------------------------------------
// Webhooks
// -------------------------------------------------------------------------

export type WebhookEventType = 'job.ready' | 'job.failed' | 'run.completed' | 'run.failed';

export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = [
	'job.ready',
	'job.failed',
	'run.completed',
	'run.failed',
];

/** Delivery payloads add the synthetic `webhook.test` event. */
export type WebhookDeliveryEventType = WebhookEventType | 'webhook.test';

export interface WebhookPayloadData {
	job_id?: string;
	job_status?: JobStatus;
	run_id?: string;
	run_status?: RunStatus;
	error?: string;
}

/**
 * Inbound webhook body.
 *
 * Signed: `X-Gluecrawl-Signature: t=<unix>,v1=<hex hmac-sha256>` over
 * `{timestamp}.{raw body}`, keyed by the endpoint secret disclosed once at
 * registration. Verify against the RAW body before trusting any of this.
 */
export interface WebhookPayload {
	id: string;
	type: WebhookDeliveryEventType;
	api_version: string;
	created_at: string;
	data: WebhookPayloadData;
}

export interface WebhookDelivery extends WebhookPayload {
	delivery_status: string;
	attempted_at?: string;
	finished_at?: string;
	response_status?: number;
	delivery_error?: string;
}

export interface Webhook {
	id: string;
	url: string;
	events: WebhookEventType[];
	enabled: boolean;
	created_at: string;
	updated_at: string;
	last_delivery?: WebhookDelivery;
	/**
	 * Present ONLY on the `POST /v1/webhooks` response. The signing secret is
	 * disclosed once, at creation, and never returned by a read endpoint -- so
	 * an endpoint discovered via `GET /v1/webhooks` can never be verified
	 * against, only one this node registered itself.
	 */
	secret?: string;
}

/** Body of `POST /v1/webhooks`. */
export interface CreateWebhookBody extends IDataObject {
	url: string;
	events: WebhookEventType[];
}

/** Body of `PATCH /v1/webhooks/{id}`. */
export interface UpdateWebhookBody extends IDataObject {
	url?: string;
	events?: WebhookEventType[];
	enabled?: boolean;
}

// -------------------------------------------------------------------------
// Envelopes
// -------------------------------------------------------------------------

/** Envelope used by jobs, runs, webhooks and webhook deliveries. */
export interface DataEnvelope<T> {
	data: T[];
	total: number;
	limit: number;
	offset: number;
}

/** Envelope used by `GET /v1/runs/{id}/items` — note the `items` key. */
export interface ItemsEnvelope {
	items: Item[];
	total: number;
	limit: number;
	offset: number;
}

/** `GET /v1/webhooks` returns only `data` — no pagination fields. */
export interface WebhookListResponse {
	data: Webhook[];
}

// -------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------

export type GluecrawlErrorCode =
	| 'invalid_api_key'
	| 'email_not_verified'
	| 'plan_required'
	| 'insufficient_credits'
	| 'not_found'
	| 'job_not_ready'
	| 'job_limit_reached'
	| 'webhook_limit_reached'
	| 'page_limit_exceeded'
	| 'invalid_webhook_url'
	| 'rate_limited'
	| 'enqueue_failed';

/** Envelope A — every `HTTPException` path on the API. */
export interface GluecrawlErrorBody {
	error: {
		code: string;
		message: string;
		[key: string]: unknown;
	};
}

/**
 * Envelope B — FastAPI's default request-validation shape. Reachable because
 * the API registers no `RequestValidationError` handler (e.g. `max_pages` over
 * 100, or a malformed `input` union).
 */
export interface FastApiValidationErrorBody {
	detail: Array<{
		loc: Array<string | number>;
		msg: string;
		type: string;
	}>;
}

// -------------------------------------------------------------------------
// Credential
// -------------------------------------------------------------------------

export interface GluecrawlCredential {
	apiKey: string;
	baseUrl: string;
}

export const DEFAULT_BASE_URL = 'https://api.gluecrawl.ai';

// -------------------------------------------------------------------------
// Endpoint limits (API-enforced; mirrored so callers can clamp before sending)
// -------------------------------------------------------------------------

/** `limit` ceiling on `GET /v1/jobs` and the run list endpoints. */
export const MAX_PAGE_SIZE_RECORDS = 100;

/** `limit` ceiling on `GET /v1/runs/{id}/items`. */
export const MAX_PAGE_SIZE_ITEMS = 500;

/** `max_pages` bounds accepted by job create, run start and schedules. */
export const MIN_MAX_PAGES = 1;
export const MAX_MAX_PAGES = 100;
