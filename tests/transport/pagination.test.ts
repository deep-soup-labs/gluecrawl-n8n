/**
 * Offset pagination over the two envelope shapes.
 *
 * The endpoints reject an oversized `limit` with a 422 instead of clamping it,
 * so the ceiling has to be applied client-side; and `returnAll` is an unbounded
 * loop driven entirely by what the server says, so the termination conditions
 * are the interesting part rather than the happy path.
 */

import nock from 'nock';
import type { IExecuteFunctions } from 'n8n-workflow';

import {
	MAX_PAGE_SIZE,
	gluecrawlApiRequestAllItems,
	gluecrawlApiRequestPage,
} from '../../nodes/Gluecrawl/transport/pagination';
import { BASE_URL, createExecuteContext, useNock, type ExecuteContext } from '../helpers';

function asExecute(context: ExecuteContext): IExecuteFunctions {
	return context as unknown as IExecuteFunctions;
}

/** `count` rows carrying their absolute index, so duplicates are detectable. */
function rows(offset: number, count: number): Array<{ id: string }> {
	return Array.from({ length: count }, (_, i) => ({ id: `row-${offset + i}` }));
}

describe('gluecrawlApiRequestAllItems, "data" envelope', () => {
	useNock();

	it('walks every page and concatenates them', async () => {
		const scope = nock(BASE_URL);
		scope
			.get('/v1/jobs')
			.query({ limit: '100', offset: '0' })
			.reply(200, { data: rows(0, 100), total: 250, limit: 100, offset: 0 });
		scope
			.get('/v1/jobs')
			.query({ limit: '100', offset: '100' })
			.reply(200, { data: rows(100, 100), total: 250, limit: 100, offset: 100 });
		scope
			.get('/v1/jobs')
			.query({ limit: '100', offset: '200' })
			.reply(200, { data: rows(200, 50), total: 250, limit: 100, offset: 200 });

		const context = createExecuteContext();
		const result = await gluecrawlApiRequestAllItems.call(asExecute(context), 'GET', '/v1/jobs', {
			envelopeKey: 'data',
		});

		expect(result).toHaveLength(250);
		expect(result[0]).toEqual({ id: 'row-0' });
		expect(result[249]).toEqual({ id: 'row-249' });
		expect(context.calls.map((call) => call.query.offset)).toEqual(['0', '100', '200']);
		scope.done();
	});

	it('defaults to the endpoint ceiling and clamps anything above it', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/jobs')
			.query({ limit: String(MAX_PAGE_SIZE.data), offset: '0' })
			.reply(200, { data: rows(0, 3), total: 3 });

		const context = createExecuteContext();
		await gluecrawlApiRequestAllItems.call(asExecute(context), 'GET', '/v1/jobs', {
			envelopeKey: 'data',
			// The API answers 422 rather than clamping, so this must never reach it.
			pageSize: 5_000,
		});

		expect(context.calls[0].query.limit).toBe('100');
		scope.done();
	});

	it('stops on a short page even when the server reports a larger total', async () => {
		// A stale `total` (a job deleted mid-walk) must not drive an extra request.
		const scope = nock(BASE_URL)
			.get('/v1/jobs')
			.query({ limit: '100', offset: '0' })
			.reply(200, { data: rows(0, 40), total: 900 });

		const context = createExecuteContext();
		const result = await gluecrawlApiRequestAllItems.call(asExecute(context), 'GET', '/v1/jobs', {
			envelopeKey: 'data',
		});

		expect(result).toHaveLength(40);
		expect(context.calls).toHaveLength(1);
		scope.done();
	});

	it('stops on an empty first page', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/jobs')
			.query(true)
			.reply(200, { data: [], total: 0, limit: 100, offset: 0 });

		const context = createExecuteContext();
		const result = await gluecrawlApiRequestAllItems.call(asExecute(context), 'GET', '/v1/jobs', {
			envelopeKey: 'data',
		});

		expect(result).toEqual([]);
		expect(context.calls).toHaveLength(1);
		scope.done();
	});

	it('stops once the reported total is satisfied, without a probing request', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/jobs')
			.query({ limit: '2', offset: '0' })
			.reply(200, { data: rows(0, 2), total: 2 });

		const context = createExecuteContext();
		const result = await gluecrawlApiRequestAllItems.call(asExecute(context), 'GET', '/v1/jobs', {
			envelopeKey: 'data',
			pageSize: 2,
		});

		expect(result).toHaveLength(2);
		expect(context.calls).toHaveLength(1);
		scope.done();
	});

	it('truncates to maxResults across pages', async () => {
		const scope = nock(BASE_URL);
		scope
			.get('/v1/jobs')
			.query({ limit: '100', offset: '0' })
			.reply(200, { data: rows(0, 100), total: 400 });
		scope
			.get('/v1/jobs')
			.query({ limit: '100', offset: '100' })
			.reply(200, { data: rows(100, 100), total: 400 });

		const context = createExecuteContext();
		const result = await gluecrawlApiRequestAllItems.call(asExecute(context), 'GET', '/v1/jobs', {
			envelopeKey: 'data',
			// A Limit above the ceiling has to be assembled from several pages.
			maxResults: 150,
			pageSize: 150,
		});

		expect(result).toHaveLength(150);
		expect(result[149]).toEqual({ id: 'row-149' });
		expect(context.calls).toHaveLength(2);
		scope.done();
	});

	it('ignores a junk envelope instead of throwing', async () => {
		const scope = nock(BASE_URL).get('/v1/jobs').query(true).reply(200, { data: 'not-an-array' });

		const context = createExecuteContext();
		await expect(
			gluecrawlApiRequestAllItems.call(asExecute(context), 'GET', '/v1/jobs', {
				envelopeKey: 'data',
			}),
		).resolves.toEqual([]);

		scope.done();
	});
});

describe('gluecrawlApiRequestAllItems, "items" envelope', () => {
	useNock();

	it('reads rows from the items key with the higher ceiling', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/runs/run-1/items')
			.query({ limit: String(MAX_PAGE_SIZE.items), offset: '0' })
			.reply(200, { items: rows(0, 12), total: 12, limit: 500, offset: 0 });

		const context = createExecuteContext();
		const result = await gluecrawlApiRequestAllItems.call(
			asExecute(context),
			'GET',
			'/v1/runs/run-1/items',
			{ envelopeKey: 'items' },
		);

		expect(MAX_PAGE_SIZE.items).toBe(500);
		expect(result).toHaveLength(12);
		scope.done();
	});

	it('does not read the data key when told to read items', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/runs/run-1/items')
			.query(true)
			.reply(200, { data: rows(0, 5), total: 5 });

		const context = createExecuteContext();
		await expect(
			gluecrawlApiRequestAllItems.call(asExecute(context), 'GET', '/v1/runs/run-1/items', {
				envelopeKey: 'items',
			}),
		).resolves.toEqual([]);

		scope.done();
	});
});

describe('runaway protection', () => {
	useNock();

	// A server that ignores `offset` answers every request with a full page, so
	// none of the content-based termination conditions ever fire. Without the
	// request ceiling this is an infinite loop inside a workflow execution.
	it('stops on the second identical page when a server ignores offset', async () => {
		// A proxy that drops the query string, or a misconfigured endpoint. The
		// short-page and `total` guards cannot see it: every reply is a full page
		// with no `total`. Without the repeated-page check this ran to the 1000
		// request ceiling and handed the workflow 1000 copies of one row.
		const scope = nock(BASE_URL)
			.get('/v1/jobs')
			.query(true)
			.times(2)
			.reply(200, { data: [{ id: 'always-the-same' }] });

		const context = createExecuteContext();
		const result = await gluecrawlApiRequestAllItems.call(asExecute(context), 'GET', '/v1/jobs', {
			envelopeKey: 'data',
			pageSize: 1,
		});

		expect(context.calls).toHaveLength(2);
		expect(result).toEqual([{ id: 'always-the-same' }]);
		scope.done();
	});

	it('does not mistake two genuinely equal rows on different pages for a repeat', async () => {
		// The guard fingerprints the page, not the row, so duplicate CONTENT on
		// consecutive pages must not truncate a legitimate result set.
		const scope = nock(BASE_URL)
			.get('/v1/jobs')
			.query({ limit: '2', offset: '0' })
			.reply(200, { data: [{ id: 'a' }, { id: 'b' }] })
			.get('/v1/jobs')
			.query({ limit: '2', offset: '2' })
			.reply(200, { data: [{ id: 'a' }, { id: 'c' }] })
			.get('/v1/jobs')
			.query({ limit: '2', offset: '4' })
			.reply(200, { data: [] });

		const context = createExecuteContext();
		const result = await gluecrawlApiRequestAllItems.call(asExecute(context), 'GET', '/v1/jobs', {
			envelopeKey: 'data',
			pageSize: 2,
		});

		expect(result).toHaveLength(4);
		scope.done();
	});
});

describe('gluecrawlApiRequestPage', () => {
	useNock();

	it('requests one page with the caller limit and offset', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/jobs/job-1/runs')
			.query({ limit: '5', offset: '10' })
			.reply(200, { data: rows(10, 5), total: 40 });

		const context = createExecuteContext();
		const result = await gluecrawlApiRequestPage.call(
			asExecute(context),
			'GET',
			'/v1/jobs/job-1/runs',
			{ envelopeKey: 'data', limit: 5, offset: 10 },
		);

		expect(result).toHaveLength(5);
		scope.done();
	});

	it('clamps the limit to the ceiling and never sends a negative offset', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/runs/run-1/items')
			.query({ limit: '500', offset: '0' })
			.reply(200, { items: rows(0, 1), total: 1 });

		const context = createExecuteContext();
		await gluecrawlApiRequestPage.call(asExecute(context), 'GET', '/v1/runs/run-1/items', {
			envelopeKey: 'items',
			limit: 10_000,
			offset: -5,
		});

		expect(context.calls[0].query).toEqual({ limit: '500', offset: '0' });
		scope.done();
	});

	it('defaults to the ceiling when no limit is given', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/jobs')
			.query({ limit: '100', offset: '0' })
			.reply(200, { data: [] });

		const context = createExecuteContext();
		await gluecrawlApiRequestPage.call(asExecute(context), 'GET', '/v1/jobs', {
			envelopeKey: 'data',
		});

		scope.done();
	});
});
