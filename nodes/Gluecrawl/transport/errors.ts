/**
 * Turns whatever `httpRequest` threw into a `NodeApiError` a user can act on.
 *
 * The Gluecrawl API emits two unrelated error shapes and we can be handed two
 * more by accident:
 *
 *   A. `{"error": {"code", "message", ...extras}}` — every HTTPException path.
 *   B. `{"detail": [{loc, msg, type}]}` — FastAPI's default request-validation
 *      body. The API registers no RequestValidationError handler, so this is
 *      genuinely reachable (max_pages > 100, a malformed `input` union, ...).
 *   C. Non-JSON — an ALB/CloudFront HTML page, an empty body, a timeout with no
 *      response at all.
 *   D. A flat `{code, message, status}` — what a `NodeApiError` carries once
 *      something has already normalised the failure. See below.
 *
 * Anything that only handles A shows users "undefined" for B and C, so all
 * four are parsed here and nowhere else.
 *
 * ## Why NodeApiError has to be parsed rather than passed through
 *
 * n8n-core does not hand nodes the raw HTTP failure: `httpRequestWithAuthentication`
 * catches it and re-throws `new NodeApiError(node, error)`. So in a real n8n
 * runtime the value this module receives is ALWAYS a `NodeApiError`, and a
 * blanket "already a NodeApiError, leave it alone" short-circuit would disable
 * this entire module — every code-specific message, including the corrected
 * `plan_required` copy, and both `isGluecrawlErrorCode` call sites in the
 * trigger. That wrapper keeps the parsed response body on `context.data` and
 * the status on `httpCode`, both of which are probed below.
 *
 * The errors this package produces are tagged instead (`GLUECRAWL_MAPPED`), so
 * a re-wrap by a caller is still a no-op while a foreign wrapper is unwrapped.
 */

import { NodeApiError, type IDataObject, type INode, type JsonObject } from 'n8n-workflow';

import type { FastApiValidationErrorBody, GluecrawlErrorBody } from '../types';

const UPGRADE_URL = 'https://www.gluecrawl.ai/pricing';
const DASHBOARD_URL = 'https://www.gluecrawl.ai/dashboard';

/** Longest raw-body excerpt embedded in a message when the body is not JSON. */
const RAW_BODY_EXCERPT_LENGTH = 300;

/**
 * Marks an error this package already gave actionable copy to.
 *
 * `Symbol.for` rather than a module-local symbol: n8n can end up with more than
 * one copy of a community package loaded (a version bump while workflows are
 * running), and a private symbol would make each copy fail to recognise the
 * other's errors and re-wrap them.
 */
const GLUECRAWL_MAPPED = Symbol.for('n8n-nodes-gluecrawl.mappedError');

/**
 * Tags an error as carrying Gluecrawl's own copy, so `toGluecrawlApiError` can
 * tell it apart from n8n-core's wrapper and leave it alone.
 */
export function markGluecrawlError<T extends object>(error: T): T {
	Object.defineProperty(error, GLUECRAWL_MAPPED, { value: true, enumerable: false });
	return error;
}

/** True for an error this package produced. */
export function isGluecrawlMappedError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as Record<symbol, unknown>)[GLUECRAWL_MAPPED] === true
	);
}

/** Normalised view of a failed Gluecrawl request. */
export interface GluecrawlApiErrorInfo {
	/** HTTP status, when the failure produced a response at all. */
	statusCode?: number;
	/** Envelope A `error.code`. Absent for envelope B and non-JSON bodies. */
	code?: string;
	/** The API's own message, or a best-effort reconstruction. */
	apiMessage: string;
	/** Extra envelope A keys beyond code/message, e.g. `limit`, `upgrade_url`. */
	extras: IDataObject;
	/** `Retry-After` response header, when present. */
	retryAfter?: string;
	/** Parsed response body, whatever shape it had. */
	body?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function firstNumber(...candidates: unknown[]): number | undefined {
	for (const candidate of candidates) {
		if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
		if (typeof candidate === 'string' && /^\d{3}$/.test(candidate)) return Number(candidate);
	}
	return undefined;
}

/** Header lookup that does not assume the casing the transport chose. */
function headerValue(headers: unknown, name: string): string | undefined {
	const record = asRecord(headers);
	if (!record) return undefined;
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(record)) {
		if (key.toLowerCase() !== wanted) continue;
		if (typeof value === 'string') return value;
		if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
		if (typeof value === 'number') return String(value);
	}
	return undefined;
}

/**
 * Renders a binary body as text, or `undefined` when it is not binary.
 *
 * Item: Download CSV asks the transport for `encoding: 'arraybuffer'`, and axios
 * decodes the FAILURE body with the same `responseType` as a success body. So on
 * that one operation `response.data` is a Buffer holding the JSON error envelope
 * rather than the parsed object, and without this every mapped message — the
 * corrected `plan_required` copy included — degrades to the generic fallback.
 */
function decodeBinaryBody(value: unknown): string | undefined {
	if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
	if (ArrayBuffer.isView(value)) {
		return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
	}
	return undefined;
}

/**
 * Digs the response body out of an error. n8n has wrapped HTTP failures
 * differently across versions (axios `response.data`, request-promise
 * `response.body`, its own `NodeApiError` re-throw), so probe all of them
 * rather than betting on one.
 *
 * The two `NodeApiError` locations are not interchangeable: constructing one
 * from a plain object stores it on `errorResponse`, while constructing one from
 * an Error (what n8n-core does with the axios failure) discards the cause and
 * copies the parsed response body onto `context.data`.
 */
function extractBody(error: Record<string, unknown>): unknown {
	const response = asRecord(error.response);
	const candidates: unknown[] = [
		response?.data,
		response?.body,
		error.body,
		asRecord(error.context)?.data,
		error.errorResponse,
		error.error,
		error.cause,
	];
	for (const candidate of candidates) {
		if (candidate === undefined || candidate === null || candidate === '') continue;
		// Decoded before the string/object checks below: bytes are a body that has
		// not been parsed yet, not an opaque object.
		const value = decodeBinaryBody(candidate) ?? candidate;
		if (value === '') continue;
		if (typeof value === 'string') {
			try {
				return JSON.parse(value);
			} catch {
				return value;
			}
		}
		// A nested Error is a wrapper, not a body — keep looking.
		if (value instanceof Error) continue;
		return value;
	}
	return undefined;
}

function isEnvelopeA(body: unknown): body is GluecrawlErrorBody {
	const error = asRecord(asRecord(body)?.error);
	return typeof error?.code === 'string';
}

function isEnvelopeB(body: unknown): body is FastApiValidationErrorBody {
	const detail = asRecord(body)?.detail;
	return Array.isArray(detail) && detail.every((entry) => typeof asRecord(entry)?.msg === 'string');
}

/**
 * Envelope D: `{code, message, status, ...extras}` with the code sitting flat
 * rather than under `error`. This is what a `NodeApiError` built from a plain
 * object carries on `errorResponse` — including the ones this module builds, so
 * `gluecrawlErrorCode` keeps working after a value has been round-tripped.
 */
function isFlatEnvelope(body: unknown): body is Record<string, unknown> & { code: string } {
	const record = asRecord(body);
	return typeof record?.code === 'string' && !isEnvelopeA(body) && !isEnvelopeB(body);
}

/** Renders FastAPI's validation list as "field: message" lines. */
function describeValidationErrors(body: FastApiValidationErrorBody): string {
	return body.detail
		.map((entry) => {
			// loc[0] is the request part ("body", "query"); the rest is the field path.
			const field = (entry.loc ?? []).slice(1).join('.');
			return field ? `${field}: ${entry.msg}` : entry.msg;
		})
		.join('; ');
}

function truncate(value: string): string {
	const collapsed = value.replace(/\s+/g, ' ').trim();
	return collapsed.length > RAW_BODY_EXCERPT_LENGTH
		? `${collapsed.slice(0, RAW_BODY_EXCERPT_LENGTH)}...`
		: collapsed;
}

/**
 * Normalises an unknown thrown value. Never throws — this runs on the failure
 * path and must not mask the original problem.
 */
export function parseGluecrawlError(error: unknown): GluecrawlApiErrorInfo {
	const record = asRecord(error) ?? {};
	const response = asRecord(record.response);

	const statusCode = firstNumber(
		record.statusCode,
		record.status,
		record.httpCode,
		response?.status,
		response?.statusCode,
	);
	const retryAfter = headerValue(response?.headers ?? record.headers, 'retry-after');
	const body = extractBody(record);

	if (isEnvelopeA(body)) {
		const { code, message, ...extras } = body.error;
		return {
			statusCode,
			code,
			apiMessage: typeof message === 'string' && message ? message : 'Gluecrawl returned an error.',
			extras: extras as IDataObject,
			retryAfter,
			body,
		};
	}

	if (isEnvelopeB(body)) {
		return {
			statusCode: statusCode ?? 422,
			apiMessage: describeValidationErrors(body),
			extras: {},
			retryAfter,
			body,
		};
	}

	if (isFlatEnvelope(body)) {
		const { code, message, status, ...extras } = body;
		return {
			statusCode: statusCode ?? firstNumber(status),
			code,
			apiMessage: typeof message === 'string' && message ? message : 'Gluecrawl returned an error.',
			extras: extras as IDataObject,
			retryAfter,
			body,
		};
	}

	const fallback =
		typeof body === 'string' && body.trim()
			? truncate(body)
			: typeof record.message === 'string' && record.message
				? record.message
				: 'The request to Gluecrawl failed.';

	return { statusCode, apiMessage: fallback, extras: {}, retryAfter, body };
}

/** Envelope A error code of a failure, if it carried one. */
export function gluecrawlErrorCode(error: unknown): string | undefined {
	return parseGluecrawlError(error).code;
}

/** True when the failure is the given Gluecrawl error code. */
export function isGluecrawlErrorCode(error: unknown, code: string): boolean {
	return gluecrawlErrorCode(error) === code;
}

/** HTTP status of a failure, if it produced a response. */
export function gluecrawlStatusCode(error: unknown): number | undefined {
	return parseGluecrawlError(error).statusCode;
}

interface Explanation {
	message: string;
	description: string;
}

/**
 * Actionable copy per error code.
 *
 * `plan_required` deliberately does NOT echo the API's message: the API says
 * "requires a Starter plan or higher", but Starter has `allows_api = false`, so
 * repeating it sends users to buy a plan that still cannot call the API.
 */
function explain(info: GluecrawlApiErrorInfo): Explanation {
	const { code, apiMessage, extras, statusCode, retryAfter } = info;

	switch (code) {
		case 'invalid_api_key':
			return {
				message: 'Gluecrawl rejected the API key',
				description: `Check the API Key field on the Gluecrawl credential. An account has exactly one active key; mint or rotate it in the Gluecrawl dashboard (${DASHBOARD_URL}). Also confirm the Base URL points at the environment the key belongs to.`,
			};

		case 'email_not_verified':
			return {
				message: 'The Gluecrawl account has not verified its email address',
				description:
					'Open the verification email Gluecrawl sent when the account was created and confirm the address, then retry. Until then the API rejects every request from this key.',
			};

		case 'plan_required':
			return {
				message: 'The Gluecrawl API requires a Pro or Enterprise plan',
				description: `This account's plan does not include API access. Starter does not either, despite what the API response says — upgrade to Pro or Enterprise at ${UPGRADE_URL}.`,
			};

		case 'insufficient_credits':
			return {
				message: 'Not enough Gluecrawl credits to run this',
				description: `${apiMessage} Top up the account balance in the Gluecrawl dashboard (${DASHBOARD_URL}), then re-run this node. Creating a job charges upfront; starting a run on an already-mapped job is charged after it completes.`,
			};

		case 'not_found':
			return {
				message: 'Gluecrawl has no record with that ID',
				description:
					'Check the ID for typos, and that it belongs to the same account as the API key in the credential. Deleting a job also deletes its runs and their items.',
			};

		case 'job_not_ready':
			return {
				message: 'The job is not ready to run',
				description: `${apiMessage} This has three causes, and they need different responses. If the job status is "in_progress" the mapper is still analysing the site — wait and retry, or enable the wait-for-completion option. If it is "failed" the mapper could not map the site, and if it is "stale" a scrape found zero items; both are terminal, so create a NEW job (possibly with a different URL or goal) — re-running this one will never succeed.`,
			};

		case 'job_limit_reached':
			return {
				message: 'The account has reached its concurrent job limit',
				description: `${apiMessage} Wait for an active job to finish, or delete jobs you no longer need.`,
			};

		case 'webhook_limit_reached':
			return {
				message: 'The Gluecrawl account has reached its webhook endpoint limit',
				description:
					'This Gluecrawl account has reached its webhook endpoint limit, so no further endpoint could be registered. Delete one you no longer need in the Gluecrawl dashboard, or deactivate a workflow that owns one, then try again. This node never deletes an endpoint it did not create.',
			};

		case 'page_limit_exceeded': {
			const limit =
				extras.limit !== undefined ? ` The plan limit is ${String(extras.limit)} pages.` : '';
			const upgrade = typeof extras.upgrade_url === 'string' ? extras.upgrade_url : UPGRADE_URL;
			return {
				message: 'Max Pages is above what this plan allows',
				description: `${apiMessage}${limit} Lower Max Pages, or upgrade at ${upgrade}.`,
			};
		}

		case 'invalid_webhook_url':
			return {
				message: 'Gluecrawl rejected the webhook URL',
				description:
					'Webhook URLs must use https and resolve to a public IP address — localhost, 127.0.0.1 and private ranges are refused. Testing against a local n8n needs a public tunnel URL, or use an n8n instance that is reachable from the internet.',
			};

		case 'rate_limited':
			return {
				message: retryAfter
					? `Gluecrawl rate limit hit — retry in ${retryAfter}s`
					: 'Gluecrawl rate limit hit',
				description: `${apiMessage} Limits are per minute: 60 job creations, 10 run starts, 10 webhook changes. Reads are not limited. Add a Wait node or lower the batch size upstream.${retryAfter ? ` The API asked for a ${retryAfter}s pause.` : ''}`,
			};

		case 'enqueue_failed':
			return {
				message: 'Gluecrawl could not queue the work',
				description: `${apiMessage} This is transient and safe to retry — the credits for the failed attempt are refunded automatically. Enable "Retry On Fail" on this node if it recurs.`,
			};

		default:
			break;
	}

	if (statusCode === 422) {
		return {
			message: 'Gluecrawl rejected the request parameters',
			description: `${apiMessage} Check the node's parameters against the allowed ranges — Max Pages must be 1-100, a columns-mode job needs at least one column, and a weekly schedule needs Every = 1 with at least one weekday selected.`,
		};
	}

	if (statusCode !== undefined && statusCode >= 500) {
		return {
			message: `Gluecrawl returned ${statusCode}`,
			description: `${apiMessage} This is a server-side failure; retrying usually resolves it.`,
		};
	}

	return {
		message: statusCode
			? `Gluecrawl request failed (HTTP ${statusCode})`
			: 'Gluecrawl request failed',
		description: apiMessage,
	};
}

export interface GluecrawlErrorContext {
	itemIndex?: number;
	/** Prepended to the description, e.g. "While starting a run for job abc". */
	context?: string;
}

/**
 * Converts a thrown `httpRequest` failure into a `NodeApiError` carrying an
 * actionable message. Every operation should funnel failures through this so
 * error copy stays consistent.
 */
export function toGluecrawlApiError(
	node: INode,
	error: unknown,
	options: GluecrawlErrorContext = {},
): NodeApiError {
	// Already carries our copy (a poll helper re-throwing, an operation wrapping
	// a transport failure a second time) — do not re-wrap. Note the deliberate
	// narrowness: an unmarked NodeApiError is n8n-core's wrapper around the raw
	// HTTP failure and still needs mapping.
	if (error instanceof NodeApiError && isGluecrawlMappedError(error)) return error;

	const info = parseGluecrawlError(error);
	const { message, description } = explain(info);
	const prefix = options.context ? `${options.context}. ` : '';

	const errorResponse: JsonObject = {
		message: info.apiMessage,
		...(info.code ? { code: info.code } : {}),
		...(info.statusCode ? { status: info.statusCode } : {}),
		...info.extras,
	};

	return markGluecrawlError(
		new NodeApiError(node, errorResponse, {
			message,
			description: `${prefix}${description}`,
			...(info.statusCode ? { httpCode: String(info.statusCode) } : {}),
			...(options.itemIndex !== undefined ? { itemIndex: options.itemIndex } : {}),
		}),
	);
}
