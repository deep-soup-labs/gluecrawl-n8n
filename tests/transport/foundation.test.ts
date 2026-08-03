/**
 * Scaffold-level checks for the shared transport layer. Operation-level tests
 * live in their own files; this one exists so the toolchain and the three
 * error-envelope shapes are covered from day one.
 */

import type { INode } from 'n8n-workflow';

import {
	gluecrawlErrorCode,
	isGluecrawlErrorCode,
	parseGluecrawlError,
	toGluecrawlApiError,
} from '../../nodes/Gluecrawl/transport/errors';
import { buildUrl } from '../../nodes/Gluecrawl/transport';
import { extractEnvelopeRows } from '../../nodes/Gluecrawl/transport/pagination';

const NODE: INode = {
	id: 'test-node',
	name: 'Gluecrawl',
	type: 'n8n-nodes-gluecrawl.gluecrawl',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** Shape n8n's axios-based httpRequest throws on an HTTP error. */
function httpError(status: number, data: unknown, headers: Record<string, string> = {}) {
	return {
		message: `Request failed with status code ${status}`,
		response: { status, data, headers },
	};
}

describe('buildUrl', () => {
	it.each([
		['https://api.gluecrawl.ai', '/v1/jobs', 'https://api.gluecrawl.ai/v1/jobs'],
		['https://api.gluecrawl.ai/', '/v1/jobs', 'https://api.gluecrawl.ai/v1/jobs'],
		['https://api.gluecrawl.ai///', '/v1/jobs', 'https://api.gluecrawl.ai/v1/jobs'],
		['  https://api.gluecrawl.ai  ', 'v1/jobs', 'https://api.gluecrawl.ai/v1/jobs'],
		// A base URL that already carries the version prefix must not double it.
		['https://api.gluecrawl.ai/v1', '/v1/jobs', 'https://api.gluecrawl.ai/v1/jobs'],
	])('joins %s + %s', (base, endpoint, expected) => {
		expect(buildUrl(base, endpoint)).toBe(expected);
	});

	it('falls back to the production host when the base URL is blank', () => {
		expect(buildUrl('', '/v1/jobs')).toBe('https://api.gluecrawl.ai/v1/jobs');
	});
});

describe('parseGluecrawlError', () => {
	it('reads envelope A including extra keys', () => {
		const info = parseGluecrawlError(
			httpError(422, {
				error: { code: 'page_limit_exceeded', message: 'Too many pages.', limit: 10 },
			}),
		);

		expect(info).toMatchObject({
			statusCode: 422,
			code: 'page_limit_exceeded',
			apiMessage: 'Too many pages.',
			extras: { limit: 10 },
		});
	});

	it('reads envelope B, FastAPI request validation', () => {
		const info = parseGluecrawlError(
			httpError(422, {
				detail: [
					{
						loc: ['body', 'max_pages'],
						msg: 'Input should be less than or equal to 100',
						type: 'less_than_equal',
					},
				],
			}),
		);

		expect(info.code).toBeUndefined();
		expect(info.apiMessage).toBe('max_pages: Input should be less than or equal to 100');
	});

	it('survives a non-JSON body', () => {
		const info = parseGluecrawlError(httpError(502, '<html><body>Bad Gateway</body></html>'));

		expect(info.statusCode).toBe(502);
		expect(info.apiMessage).toContain('Bad Gateway');
	});

	it('survives a failure with no response at all', () => {
		const info = parseGluecrawlError(new Error('socket hang up'));

		expect(info.statusCode).toBeUndefined();
		expect(info.apiMessage).toBe('socket hang up');
	});

	it('picks up Retry-After regardless of header casing', () => {
		const info = parseGluecrawlError(
			httpError(
				429,
				{ error: { code: 'rate_limited', message: 'Slow down.' } },
				{ 'Retry-After': '30' },
			),
		);

		expect(info.retryAfter).toBe('30');
	});
});

describe('toGluecrawlApiError', () => {
	it('corrects the plan_required wording instead of echoing the API', () => {
		const error = toGluecrawlApiError(
			NODE,
			httpError(403, {
				error: {
					code: 'plan_required',
					message: 'This endpoint requires a Starter plan or higher.',
				},
			}),
		);

		expect(error.message).toContain('Pro or Enterprise');
		expect(error.description).toContain('Pro or Enterprise');
		// The API's own message names Starter, which cannot call the API either.
		expect(error.message).not.toContain('Starter plan or higher');
	});

	it('spells out all three job_not_ready causes', () => {
		const error = toGluecrawlApiError(
			NODE,
			httpError(409, { error: { code: 'job_not_ready', message: 'Job is not ready.' } }),
		);

		expect(error.description).toContain('in_progress');
		expect(error.description).toContain('failed');
		expect(error.description).toContain('stale');
	});

	it('surfaces Retry-After on a rate limit', () => {
		const error = toGluecrawlApiError(
			NODE,
			httpError(
				429,
				{ error: { code: 'rate_limited', message: 'Slow down.' } },
				{ 'retry-after': '12' },
			),
		);

		expect(error.message).toContain('12');
	});

	it('does not re-wrap an already mapped error', () => {
		const first = toGluecrawlApiError(
			NODE,
			httpError(404, { error: { code: 'not_found', message: 'x' } }),
		);
		expect(toGluecrawlApiError(NODE, first)).toBe(first);
	});
});

describe('error code helpers', () => {
	it('identifies the code', () => {
		const error = httpError(409, {
			error: { code: 'webhook_limit_reached', message: 'Already exists.' },
		});

		expect(gluecrawlErrorCode(error)).toBe('webhook_limit_reached');
		expect(isGluecrawlErrorCode(error, 'webhook_limit_reached')).toBe(true);
		expect(isGluecrawlErrorCode(error, 'not_found')).toBe(false);
	});
});

describe('extractEnvelopeRows', () => {
	it('reads both envelope keys and tolerates junk', () => {
		expect(extractEnvelopeRows({ data: [1, 2] }, 'data')).toEqual([1, 2]);
		expect(extractEnvelopeRows({ items: [1] }, 'items')).toEqual([1]);
		expect(extractEnvelopeRows({ data: [1] }, 'items')).toEqual([]);
		expect(extractEnvelopeRows(undefined, 'data')).toEqual([]);
		expect(extractEnvelopeRows({ data: 'nope' }, 'data')).toEqual([]);
	});
});
