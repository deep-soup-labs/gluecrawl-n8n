/**
 * The full error-mapping matrix: every documented `/v1` error code, both
 * envelope shapes, and the bodies that are not JSON at all.
 *
 * `foundation.test.ts` covers the parser's happy paths; this file is about the
 * copy a user actually reads, because that copy is the only thing standing
 * between a 403 and an hour of confusion. Each case asserts on the message and
 * description rather than snapshotting them, so rewording stays cheap but the
 * facts (which plan, whether a retry helps, whether the job is dead) are
 * locked.
 */

import { NodeApiError, type INode, type JsonObject } from 'n8n-workflow';

import {
	gluecrawlStatusCode,
	isGluecrawlErrorCode,
	parseGluecrawlError,
	toGluecrawlApiError,
} from '../../nodes/Gluecrawl/transport/errors';

const NODE: INode = {
	id: 'test-node',
	name: 'Gluecrawl',
	type: 'n8n-nodes-gluecrawl.gluecrawl',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** Envelope A failure, shaped the way n8n's axios transport throws it. */
function apiError(
	status: number,
	code: string,
	message: string,
	extras: Record<string, unknown> = {},
	headers: Record<string, string> = {},
) {
	return {
		message: `Request failed with status code ${status}`,
		response: { status, data: { error: { code, message, ...extras } }, headers },
	};
}

function mapped(
	status: number,
	code: string,
	message: string,
	extras: Record<string, unknown> = {},
	headers: Record<string, string> = {},
): NodeApiError {
	return toGluecrawlApiError(NODE, apiError(status, code, message, extras, headers));
}

describe('every documented error code is mapped', () => {
	it('401 invalid_api_key points at the key and the base URL', () => {
		const error = mapped(401, 'invalid_api_key', 'Invalid API key.');

		expect(error.message).toContain('API key');
		expect(error.description).toContain('Base URL');
		expect(error.httpCode).toBe('401');
	});

	it('403 email_not_verified blames the account, not the key', () => {
		const error = mapped(403, 'email_not_verified', 'Email address is not verified.');

		expect(error.message).toContain('email');
		expect(error.description).toMatch(/verification email/i);
		// Nothing about plans: telling a user to upgrade here wastes money.
		expect(error.description).not.toMatch(/upgrade/i);
	});

	it('403 plan_required echoes the API message and adds the upgrade URL', () => {
		// API access starts at Starter, so the API's own wording is correct and is
		// passed through — naming a plan here would be a second place to keep in
		// sync with `gluecrawl_schemas.plans`.
		const upstream = 'This endpoint requires a Starter plan or higher.';
		const error = mapped(403, 'plan_required', upstream);

		expect(error.message).toBe('The Gluecrawl account is on a plan without API access');
		expect(error.description).toContain(upstream);
		expect(error.description).toContain('https://www.gluecrawl.ai/#pricing');
	});

	it('402 insufficient_credits keeps the API message and explains when charging happens', () => {
		const error = mapped(402, 'insufficient_credits', 'Balance is 3 credits, 25 required.');

		expect(error.message).toContain('credits');
		expect(error.description).toContain('Balance is 3 credits, 25 required.');
		expect(error.description).toMatch(/upfront/);
	});

	it('404 not_found mentions the account scoping', () => {
		const error = mapped(404, 'not_found', 'Job not found.');

		expect(error.message).toContain('no record');
		expect(error.description).toMatch(/same account/i);
	});

	it('409 job_not_ready separates the retryable cause from the two terminal ones', () => {
		const error = mapped(409, 'job_not_ready', 'Job is not ready.');

		expect(error.description).toContain('in_progress');
		expect(error.description).toContain('failed');
		expect(error.description).toContain('stale');
		expect(error.description).toMatch(/NEW job/);
	});

	it('409 job_limit_reached tells the user how to free a slot', () => {
		const error = mapped(409, 'job_limit_reached', 'Active job limit reached.');

		expect(error.message).toContain('limit');
		expect(error.description).toContain('Active job limit reached.');
	});

	it('409 webhook_limit_reached points at freeing a slot, not at a conflict', () => {
		const error = mapped(409, 'webhook_limit_reached', 'Endpoint limit reached.');

		expect(error.message).toContain('limit');
		expect(error.description).toMatch(/delete one you no longer need/i);
		// Evicting someone else's endpoint is never the remedy; say so here too.
		expect(error.description).toMatch(/never deletes an endpoint it did not create/i);
	});

	it('422 page_limit_exceeded surfaces the plan limit and the upgrade URL it was given', () => {
		const error = mapped(422, 'page_limit_exceeded', 'Max pages above plan limit.', {
			limit: 10,
			upgrade_url: 'https://www.gluecrawl.ai/pricing?from=api',
		});

		expect(error.message).toContain('Max Pages');
		expect(error.description).toContain('10 pages');
		// The API's own upgrade URL wins over the hardcoded one.
		expect(error.description).toContain('https://www.gluecrawl.ai/pricing?from=api');
	});

	it('422 invalid_webhook_url names the https and public-IP requirements', () => {
		const error = mapped(422, 'invalid_webhook_url', 'Webhook URL is not reachable.');

		expect(error.description).toContain('https');
		expect(error.description).toMatch(/public IP/i);
		expect(error.description).toMatch(/localhost/i);
	});

	it('429 rate_limited surfaces Retry-After in the message', () => {
		const error = mapped(429, 'rate_limited', 'Too many requests.', {}, { 'Retry-After': '30' });

		expect(error.message).toContain('30');
		expect(error.description).toContain('30s pause');
	});

	it('429 rate_limited still reads sensibly without a Retry-After header', () => {
		const error = mapped(429, 'rate_limited', 'Too many requests.');

		expect(error.message).toBe('Gluecrawl rate limit hit');
		expect(error.description).toMatch(/per minute/);
	});

	it('502 enqueue_failed says it is retryable', () => {
		const error = mapped(502, 'enqueue_failed', 'Could not enqueue the job.');

		expect(error.message).toContain('could not queue');
		expect(error.description).toMatch(/transient and safe to retry/i);
	});
});

describe('envelope B: FastAPI request validation', () => {
	// Reachable because the API registers no RequestValidationError handler, so
	// there is no `error.code` to switch on and the status has to carry the copy.
	const body = {
		detail: [
			{
				loc: ['body', 'max_pages'],
				msg: 'Input should be less than or equal to 100',
				type: 'less_than_equal',
			},
			{
				loc: ['body', 'input', 'value'],
				msg: 'List should have at least 1 item after validation, not 0',
				type: 'too_short',
			},
		],
	};

	it('renders every field error and keeps the 422 status', () => {
		const info = parseGluecrawlError({
			message: 'Request failed with status code 422',
			response: { status: 422, data: body, headers: {} },
		});

		expect(info.code).toBeUndefined();
		expect(info.statusCode).toBe(422);
		expect(info.apiMessage).toBe(
			'max_pages: Input should be less than or equal to 100; ' +
				'input.value: List should have at least 1 item after validation, not 0',
		);
	});

	it('falls back to the 422 explanation rather than showing "undefined"', () => {
		const error = toGluecrawlApiError(NODE, {
			message: 'Request failed with status code 422',
			response: { status: 422, data: body, headers: {} },
		});

		expect(error.message).toBe('Gluecrawl rejected the request parameters');
		expect(error.description).toContain('max_pages: Input should be less than or equal to 100');
		expect(error.description).toContain('1-100');
		expect(`${error.message}${error.description}`).not.toContain('undefined');
	});

	it('assumes 422 when the transport lost the status code', () => {
		expect(parseGluecrawlError({ body }).statusCode).toBe(422);
	});
});

describe('bodies that are not the contract', () => {
	it('quotes an HTML error page instead of showing "undefined"', () => {
		const error = toGluecrawlApiError(NODE, {
			message: 'Request failed with status code 503',
			response: {
				status: 503,
				data: '<html><head><title>503 Service Unavailable</title></head><body>upstream</body></html>',
				headers: { 'content-type': 'text/html' },
			},
		});

		expect(error.message).toBe('Gluecrawl returned 503');
		expect(error.description).toContain('503 Service Unavailable');
		expect(error.description).not.toContain('undefined');
	});

	it('truncates a very long non-JSON body', () => {
		const info = parseGluecrawlError({
			response: { status: 500, data: 'x'.repeat(5_000), headers: {} },
		});

		expect(info.apiMessage.length).toBeLessThanOrEqual(303);
		expect(info.apiMessage.endsWith('...')).toBe(true);
	});

	it('handles an empty body', () => {
		const error = toGluecrawlApiError(NODE, {
			message: 'Request failed with status code 500',
			response: { status: 500, data: '', headers: {} },
		});

		expect(error.message).toBe('Gluecrawl returned 500');
		expect(error.description).toContain('Request failed with status code 500');
	});

	it('handles a transport failure with no response at all', () => {
		const error = toGluecrawlApiError(NODE, new Error('connect ETIMEDOUT'));

		expect(error.message).toBe('Gluecrawl request failed');
		expect(error.description).toContain('connect ETIMEDOUT');
		expect(gluecrawlStatusCode(new Error('connect ETIMEDOUT'))).toBeUndefined();
	});

	it('handles an unknown error code by falling back to the status', () => {
		const error = mapped(418, 'teapot', 'I am a teapot.');

		expect(error.message).toContain('418');
		expect(error.description).toContain('I am a teapot.');
	});

	it('handles a status-only failure with no recognisable body', () => {
		const error = toGluecrawlApiError(NODE, { response: { status: 400, headers: {} } });

		expect(error.message).toBe('Gluecrawl request failed (HTTP 400)');
	});
});

/**
 * Run: Download CSV is the only operation that asks for `encoding:
 * 'arraybuffer'`, and axios decodes a FAILURE body with the same `responseType`
 * as a success body. So on that endpoint — and only there — the error envelope
 * arrives as bytes. Unparsed, every code-specific message on the CSV export
 * silently degrades to the generic status fallback.
 */
describe('binary error bodies', () => {
	function binaryFailure(status: number, body: string, view: 'buffer' | 'arraybuffer' = 'buffer') {
		const buffer = Buffer.from(body, 'utf8');
		return {
			message: `Request failed with status code ${status}`,
			response: {
				status,
				data:
					view === 'buffer'
						? buffer
						: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
				headers: { 'content-type': 'application/json' },
			},
		};
	}

	it('parses envelope A out of a Buffer body', () => {
		const error = toGluecrawlApiError(
			NODE,
			binaryFailure(
				404,
				JSON.stringify({ error: { code: 'not_found', message: 'Run not found.' } }),
			),
		);

		expect(error.message).toBe('Gluecrawl has no record with that ID');
		expect(gluecrawlStatusCode(error)).toBe(404);
	});

	it('parses envelope A out of a raw ArrayBuffer body', () => {
		const error = toGluecrawlApiError(
			NODE,
			binaryFailure(
				403,
				JSON.stringify({
					error: {
						code: 'plan_required',
						message: 'This endpoint requires a Starter plan or higher.',
					},
				}),
				'arraybuffer',
			),
		);

		// The mapped copy users need most, on the one endpoint that lost it.
		expect(error.message).toBe('The Gluecrawl account is on a plan without API access');
		expect(error.description).toContain('This endpoint requires a Starter plan or higher.');
	});

	it('keeps the error code reachable through a binary body', () => {
		const raw = binaryFailure(
			409,
			JSON.stringify({ error: { code: 'webhook_already_exists', message: 'Taken.' } }),
		);

		expect(isGluecrawlErrorCode(raw, 'webhook_already_exists')).toBe(true);
	});

	it('quotes a non-JSON binary body rather than showing an object', () => {
		const error = toGluecrawlApiError(
			NODE,
			binaryFailure(500, '<html><body>Bad gateway</body></html>'),
		);

		expect(error.message).toBe('Gluecrawl returned 500');
		expect(error.description).toContain('Bad gateway');
	});

	it('falls back to the transport message when the binary body is empty', () => {
		const error = toGluecrawlApiError(NODE, binaryFailure(500, ''));

		expect(error.message).toBe('Gluecrawl returned 500');
		expect(error.description).toContain('Request failed with status code 500');
	});
});

describe('error decoration', () => {
	it('prefixes the operation context onto the description', () => {
		const error = toGluecrawlApiError(NODE, apiError(404, 'not_found', 'Run not found.'), {
			context: 'While fetching run abc',
			itemIndex: 3,
		});

		expect(error.description?.startsWith('While fetching run abc. ')).toBe(true);
	});

	it('keeps envelope A extras on the error payload', () => {
		const error = mapped(422, 'page_limit_exceeded', 'Too many pages.', {
			limit: 10,
			upgrade_url: 'https://www.gluecrawl.ai/pricing',
		});

		// `errorResponse` is the machine-readable half n8n shows in the error
		// output branch, so the code and the extras have to survive into it —
		// the rendered description alone cannot be branched on.
		expect((error as unknown as { errorResponse: Record<string, unknown> }).errorResponse).toEqual({
			message: 'Too many pages.',
			code: 'page_limit_exceeded',
			status: 422,
			limit: 10,
			upgrade_url: 'https://www.gluecrawl.ai/pricing',
		});
		expect(error.httpCode).toBe('422');
	});

	it('is idempotent, so an operation-level re-wrap cannot flatten the description', () => {
		const first = mapped(403, 'plan_required', 'This endpoint requires a Starter plan or higher.');
		const second = toGluecrawlApiError(NODE, first, { context: 'While starting a run' });

		expect(second).toBe(first);
		expect(second.description).toContain('This endpoint requires a Starter plan or higher.');
	});

	it('produces a NodeApiError for every input shape', () => {
		const inputs: unknown[] = [
			apiError(401, 'invalid_api_key', 'nope'),
			{ response: { status: 500, data: '<html></html>', headers: {} } },
			new Error('boom'),
			'a bare string',
			undefined,
		];

		for (const input of inputs) {
			expect(toGluecrawlApiError(NODE, input)).toBeInstanceOf(NodeApiError);
		}
	});
});

/**
 * n8n-core never hands a node the raw axios failure: `httpRequestWithAuthentication`
 * catches it and re-throws `new NodeApiError(this.getNode(), error)`. So in a
 * real n8n runtime EVERY failure reaching this module is already a
 * `NodeApiError`, and a blanket "leave NodeApiErrors alone" rule would silently
 * disable the whole mapper in production while every test above still passed.
 *
 * These cases reproduce that wrapper against the real `NodeApiError` from
 * `n8n-workflow` — the same class n8n-core constructs — so the mapping is
 * proven through the shape users actually get.
 */
describe('failures already wrapped by n8n-core', () => {
	/** Minimal stand-in for the axios error: the class NAME is load-bearing. */
	class AxiosError extends Error {
		response: { status: number; data: unknown; headers: Record<string, string> };

		constructor(status: number, data: unknown) {
			super(`Request failed with status code ${status}`);
			this.response = { status, data, headers: {} };
		}
	}

	/** What `httpRequestWithAuthentication` throws after a non-2xx response. */
	function coreWrapped(status: number, data: unknown): NodeApiError {
		return new NodeApiError(NODE, new AxiosError(status, data) as unknown as JsonObject);
	}

	it('still emits the mapped plan_required copy', () => {
		const error = toGluecrawlApiError(
			NODE,
			coreWrapped(403, {
				error: {
					code: 'plan_required',
					message: 'This endpoint requires a Starter plan or higher.',
				},
			}),
		);

		expect(error.message).toBe('The Gluecrawl account is on a plan without API access');
		expect(error.description).toContain('This endpoint requires a Starter plan or higher.');
		expect(error.description).toContain('https://www.gluecrawl.ai/#pricing');
		expect(error.httpCode).toBe('403');
	});

	it('still exposes the code to isGluecrawlErrorCode', () => {
		const wrapped = coreWrapped(404, {
			error: { code: 'not_found', message: 'Webhook not found.' },
		});

		expect(isGluecrawlErrorCode(wrapped, 'not_found')).toBe(true);
		expect(gluecrawlStatusCode(wrapped)).toBe(404);
	});

	it('still renders envelope B validation detail', () => {
		const error = toGluecrawlApiError(
			NODE,
			coreWrapped(422, {
				detail: [{ loc: ['body', 'max_pages'], msg: 'Input should be less than or equal to 100' }],
			}),
		);

		expect(error.description).toContain('max_pages: Input should be less than or equal to 100');
	});

	it('keeps a code round-tripping through a second wrap', () => {
		// An operation catching a transport failure and re-mapping it must not
		// lose the code the trigger branches on.
		const once = toGluecrawlApiError(NODE, apiError(409, 'webhook_already_exists', 'Taken.'));

		expect(isGluecrawlErrorCode(once, 'webhook_already_exists')).toBe(true);
		expect(gluecrawlStatusCode(once)).toBe(409);
	});
});
