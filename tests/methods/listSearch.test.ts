/**
 * The Job and Run pickers.
 *
 * These run at edit time, and the two things that can go wrong there are
 * invisible at execution time: a request built from an id that has not been
 * filled in yet, and a list that silently truncates because pagination stopped
 * early. Both are covered here.
 *
 * The requests go through the real transport against nock, like every other
 * suite, so the credential's base-URL join and the `limit`/`offset` assembly
 * stay inside the code under test.
 */

import nock from 'nock';
import type { ILoadOptionsFunctions } from 'n8n-workflow';

import { searchJobs, searchRuns } from '../../nodes/Gluecrawl/methods/listSearch';
import {
	BASE_URL,
	callsOf,
	createLoadOptionsContext,
	rejectionOf,
	resourceLocatorValue,
	useNock,
	type LoadOptionsContext,
} from '../helpers';

const JOB_ID = '8f4a2c1e-0b7d-4a19-9c3f-6d5e2a1b8c04';
const OTHER_JOB_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

function asLoadOptions(context: LoadOptionsContext): ILoadOptionsFunctions {
	return context as unknown as ILoadOptionsFunctions;
}

function job(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		url: 'https://books.toscrape.com/catalogue/page-1.html',
		status: 'ready',
		created_at: '2026-07-28T14:03:22.981Z',
		updated_at: '2026-07-28T14:05:00.000Z',
		...extra,
	};
}

function run(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		job_id: JOB_ID,
		status: 'completed',
		created_at: '2026-07-28T14:03:22.981Z',
		...extra,
	};
}

describe('searchJobs', () => {
	useNock();

	it('labels a job "host - status", with the goal deliberately absent', async () => {
		nock(BASE_URL)
			.get('/v1/jobs')
			.query({ limit: 100, offset: 0 })
			.reply(200, {
				data: [job(JOB_ID, { input: { type: 'goal', value: 'product title, price and rating' } })],
				total: 1,
				limit: 100,
				offset: 0,
			});

		const result = await searchJobs.call(asLoadOptions(createLoadOptionsContext()));

		expect(result.results).toEqual([
			{
				name: 'books.toscrape.com - ready',
				value: JOB_ID,
				description: 'created 2026-07-28 14:03 UTC',
			},
		]);
	});

	it('labels a columns job the same way — input never reaches the label', async () => {
		nock(BASE_URL)
			.get('/v1/jobs')
			.query(true)
			.reply(200, {
				data: [
					job(JOB_ID, {
						input: {
							type: 'columns',
							value: [
								{ name: 'title', type: 'text' },
								{ name: 'price', type: 'number' },
							],
						},
					}),
				],
				total: 1,
			});

		const result = await searchJobs.call(asLoadOptions(createLoadOptionsContext()));

		expect(result.results[0].name).toBe('books.toscrape.com - ready');
	});

	it('strips a leading www. but no other subdomain', async () => {
		// `shop.` / `en.` / `m.` can be different sites entirely, so only `www.`
		// is safe to drop.
		nock(BASE_URL)
			.get('/v1/jobs')
			.query(true)
			.reply(200, {
				data: [
					job(JOB_ID, { url: 'https://www.ikea.com/gb/en/cat/sofas-fu003/' }),
					job(OTHER_JOB_ID, { url: 'https://shop.example.com/all', status: 'failed' }),
				],
				total: 2,
			});

		const result = await searchJobs.call(asLoadOptions(createLoadOptionsContext()));

		expect(result.results.map((item) => item.name)).toEqual([
			'ikea.com - ready',
			'shop.example.com - failed',
		]);
	});

	it('reports a missing status rather than rendering "undefined"', async () => {
		nock(BASE_URL)
			.get('/v1/jobs')
			.query(true)
			.reply(200, { data: [job(JOB_ID, { status: undefined })], total: 1 });

		const result = await searchJobs.call(asLoadOptions(createLoadOptionsContext()));

		expect(result.results[0].name).toBe('books.toscrape.com - unknown');
	});

	it('keeps an unparseable URL readable instead of throwing inside the dropdown', async () => {
		nock(BASE_URL)
			.get('/v1/jobs')
			.query(true)
			.reply(200, { data: [job(JOB_ID, { url: 'not a url' })], total: 1 });

		const result = await searchJobs.call(asLoadOptions(createLoadOptionsContext()));

		expect(result.results[0].name).toBe('not a url - ready');
	});

	it('filters on the label, case-insensitively', async () => {
		nock(BASE_URL)
			.get('/v1/jobs')
			.query(true)
			.reply(200, {
				data: [
					job(JOB_ID, { url: 'https://books.toscrape.com/' }),
					job(OTHER_JOB_ID, { url: 'https://quotes.toscrape.com/' }),
				],
				total: 2,
			});

		const result = await searchJobs.call(asLoadOptions(createLoadOptionsContext()), 'QUOTES');

		expect(result.results).toHaveLength(1);
		expect(result.results[0].value).toBe(OTHER_JOB_ID);
	});

	it('matches an exact id, so pasting one into the search box finds it', async () => {
		nock(BASE_URL)
			.get('/v1/jobs')
			.query(true)
			.reply(200, { data: [job(JOB_ID), job(OTHER_JOB_ID)], total: 2 });

		const result = await searchJobs.call(asLoadOptions(createLoadOptionsContext()), OTHER_JOB_ID);

		expect(result.results.map((item) => item.value)).toEqual([OTHER_JOB_ID]);
	});

	it('asks for the endpoint ceiling on a browse', async () => {
		const context = createLoadOptionsContext();
		nock(BASE_URL).get('/v1/jobs').query(true).reply(200, { data: [], total: 0 });

		await searchJobs.call(asLoadOptions(context));

		expect(callsOf(context.calls, 'GET')[0].query).toEqual({ limit: '100', offset: '0' });
	});

	it('offers a next page only while the envelope total is unmet', async () => {
		const page = Array.from({ length: 100 }, (_, index) =>
			job(`${index}`.padStart(8, '0') + '-0b7d-4a19-9c3f-6d5e2a1b8c04'),
		);
		nock(BASE_URL)
			.get('/v1/jobs')
			.query({ limit: 100, offset: 0 })
			.reply(200, { data: page, total: 150 });

		const first = await searchJobs.call(asLoadOptions(createLoadOptionsContext()));
		expect(first.paginationToken).toBe('100');

		nock(BASE_URL)
			.get('/v1/jobs')
			.query({ limit: 100, offset: 100 })
			.reply(200, { data: page.slice(0, 50), total: 150 });

		const second = await searchJobs.call(
			asLoadOptions(createLoadOptionsContext()),
			undefined,
			first.paginationToken as string,
		);
		expect(second.paginationToken).toBeUndefined();
	});

	it('stops paginating on an empty page even if total lies', async () => {
		nock(BASE_URL).get('/v1/jobs').query(true).reply(200, { data: [], total: 999 });

		const result = await searchJobs.call(asLoadOptions(createLoadOptionsContext()));

		expect(result.results).toEqual([]);
		expect(result.paginationToken).toBeUndefined();
	});

	it('surfaces a bad credential instead of reporting an empty account', async () => {
		nock(BASE_URL)
			.get('/v1/jobs')
			.query(true)
			.reply(401, { error: { code: 'invalid_api_key', message: 'Invalid API key' } });

		const error = await rejectionOf(searchJobs.call(asLoadOptions(createLoadOptionsContext())));

		expect(error.message).toMatch(/API key/i);
	});
});

/**
 * Searching across pages.
 *
 * This is a regression suite, not a hypothetical: filtering only the page the
 * editor asked for was shipped, then caught against a real account of 122 jobs
 * where searching for one at offset 104 returned "no results" for a job that
 * plainly existed.
 */
describe('searchJobs across pages', () => {
	useNock();

	/** `count` filler jobs, all on a host that no test searches for. */
	function filler(count: number, startIndex = 0) {
		return Array.from({ length: count }, (_, i) =>
			job(`${startIndex + i}`.padStart(8, '0') + '-0b7d-4a19-9c3f-6d5e2a1b8c04', {
				url: 'https://filler.example.com/',
			}),
		);
	}

	it('finds a match that sits beyond the first page', async () => {
		// The exact shape of the real-account failure: 122 records, the wanted one
		// at offset 104. Filtering page one alone answers "no such job".
		nock(BASE_URL)
			.get('/v1/jobs')
			.query({ limit: 100, offset: 0 })
			.reply(200, { data: filler(100), total: 122 });
		nock(BASE_URL)
			.get('/v1/jobs')
			.query({ limit: 100, offset: 100 })
			.reply(200, {
				data: [
					...filler(4, 100),
					job(OTHER_JOB_ID, { url: 'https://www.wildfox.com/collections/all' }),
					...filler(17, 105),
				],
				total: 122,
			});

		const result = await searchJobs.call(asLoadOptions(createLoadOptionsContext()), 'wildfox');

		expect(result.results).toHaveLength(1);
		expect(result.results[0].value).toBe(OTHER_JOB_ID);
	});

	it('returns no pagination token for a search', async () => {
		// The token is an offset into the UNFILTERED list. Handing it back would
		// make "load more" append arbitrary non-matching rows under the matches.
		nock(BASE_URL)
			.get('/v1/jobs')
			.query({ limit: 100, offset: 0 })
			.reply(200, { data: filler(100), total: 122 });
		nock(BASE_URL)
			.get('/v1/jobs')
			.query({ limit: 100, offset: 100 })
			.reply(200, {
				data: [job(OTHER_JOB_ID, { url: 'https://www.wildfox.com/' }), ...filler(21, 100)],
				total: 122,
			});

		const result = await searchJobs.call(asLoadOptions(createLoadOptionsContext()), 'wildfox');

		expect(result.results).toHaveLength(1);
		expect(result.paginationToken).toBeUndefined();
	});

	it('stops scanning once the match limit is reached', async () => {
		// Every row matches, so the scan must stop on the match cap rather than
		// walking the account. One page of 100 already exceeds the 50-match cap.
		const context = createLoadOptionsContext();
		nock(BASE_URL)
			.get('/v1/jobs')
			.query({ limit: 100, offset: 0 })
			.reply(200, { data: filler(100), total: 100_000 });

		const result = await searchJobs.call(asLoadOptions(context), 'filler');

		expect(result.results).toHaveLength(50);
		expect(context.calls).toHaveLength(1);
	});

	it('stops on a short page rather than asking for empty ones', async () => {
		const context = createLoadOptionsContext();
		nock(BASE_URL)
			.get('/v1/jobs')
			.query({ limit: 100, offset: 0 })
			.reply(200, { data: filler(40), total: 40 });

		const result = await searchJobs.call(asLoadOptions(context), 'nothing-matches-this');

		expect(result.results).toEqual([]);
		expect(context.calls).toHaveLength(1);
	});

	it('does not scan when there is no filter', async () => {
		// A browse must stay one request, or opening the dropdown on a large
		// account would walk the whole list before showing anything.
		const context = createLoadOptionsContext();
		nock(BASE_URL)
			.get('/v1/jobs')
			.query({ limit: 100, offset: 0 })
			.reply(200, { data: filler(100), total: 122 });

		const result = await searchJobs.call(asLoadOptions(context));

		expect(context.calls).toHaveLength(1);
		expect(result.paginationToken).toBe('100');
	});

	it('treats a whitespace-only filter as a browse', async () => {
		const context = createLoadOptionsContext();
		nock(BASE_URL)
			.get('/v1/jobs')
			.query({ limit: 100, offset: 0 })
			.reply(200, { data: filler(100), total: 122 });

		const result = await searchJobs.call(asLoadOptions(context), '   ');

		expect(context.calls).toHaveLength(1);
		expect(result.paginationToken).toBe('100');
	});
});

describe('searchRuns across pages', () => {
	useNock();

	it('scans a scheduled job whose runs outgrew one page', async () => {
		const context = createLoadOptionsContext({ parameters: { jobId: JOB_ID } });
		const page = Array.from({ length: 100 }, (_, i) =>
			run(`${i}`.padStart(8, '0') + '-73e6-49c1-8f5a-0b1c2d3e4f50', { status: 'completed' }),
		);
		nock(BASE_URL)
			.get(`/v1/jobs/${JOB_ID}/runs`)
			.query({ limit: 100, offset: 0 })
			.reply(200, { data: page, total: 130 });
		nock(BASE_URL)
			.get(`/v1/jobs/${JOB_ID}/runs`)
			.query({ limit: 100, offset: 100 })
			.reply(200, {
				data: [run('ffffffff-73e6-49c1-8f5a-0b1c2d3e4f50', { status: 'failed' })],
				total: 130,
			});

		const result = await searchRuns.call(asLoadOptions(context), 'failed');

		expect(result.results).toHaveLength(1);
		expect(result.results[0].value).toBe('ffffffff-73e6-49c1-8f5a-0b1c2d3e4f50');
		expect(context.calls).toHaveLength(2);
	});
});

describe('searchRuns', () => {
	useNock();

	it('lists the runs of the job selected in the sibling field', async () => {
		const context = createLoadOptionsContext({
			parameters: { jobId: resourceLocatorValue(JOB_ID) },
		});
		nock(BASE_URL)
			.get(`/v1/jobs/${JOB_ID}/runs`)
			.query({ limit: 100, offset: 0 })
			.reply(200, {
				data: [run('4d2b9a10-73e6-49c1-8f5a-0b1c2d3e4f50', { item_count: 42, page_count: 3 })],
				total: 1,
			});

		const result = await searchRuns.call(asLoadOptions(context));

		expect(result.results).toEqual([
			{
				name: '2026-07-28 14:03 UTC - completed',
				value: '4d2b9a10-73e6-49c1-8f5a-0b1c2d3e4f50',
				description: '4d2b9a10-73e6-49c1-8f5a-0b1c2d3e4f50',
			},
		]);
	});

	it('keeps counts out of the label even when the run reports them', async () => {
		const context = createLoadOptionsContext({ parameters: { jobId: JOB_ID } });
		nock(BASE_URL)
			.get(`/v1/jobs/${JOB_ID}/runs`)
			.query(true)
			.reply(200, {
				data: [run('4d2b9a10-73e6-49c1-8f5a-0b1c2d3e4f50', { item_count: 42, page_count: 3 })],
				total: 1,
			});

		const result = await searchRuns.call(asLoadOptions(context));

		expect(result.results[0].name).toBe('2026-07-28 14:03 UTC - completed');
	});

	it('renders a run that has reported no counts identically', async () => {
		const context = createLoadOptionsContext({ parameters: { jobId: JOB_ID } });
		nock(BASE_URL)
			.get(`/v1/jobs/${JOB_ID}/runs`)
			.query(true)
			.reply(200, {
				data: [run('4d2b9a10-73e6-49c1-8f5a-0b1c2d3e4f50', { status: 'scraping' })],
				total: 1,
			});

		const result = await searchRuns.call(asLoadOptions(context));

		expect(result.results[0].name).toBe('2026-07-28 14:03 UTC - scraping');
	});

	it('reads the job through extractValue, so a plain id works like a picked one', async () => {
		const context = createLoadOptionsContext({ parameters: { jobId: JOB_ID } });
		nock(BASE_URL).get(`/v1/jobs/${JOB_ID}/runs`).query(true).reply(200, { data: [], total: 0 });

		await searchRuns.call(asLoadOptions(context));

		expect(callsOf(context.calls, 'GET')[0].path).toBe(`/v1/jobs/${JOB_ID}/runs`);
	});

	it('returns nothing, and calls nothing, before a job is chosen', async () => {
		const context = createLoadOptionsContext({ parameters: {} });

		const result = await searchRuns.call(asLoadOptions(context));

		expect(result).toEqual({ results: [] });
		expect(context.calls).toHaveLength(0);
	});

	it('does not build a request from an unresolved expression', async () => {
		// At edit time a job wired from an upstream node reads back as the raw
		// expression. Putting that in the path would 404 and surface as a broken
		// picker rather than an unfilled field.
		const context = createLoadOptionsContext({
			parameters: { jobId: resourceLocatorValue('={{ $json.job_id }}', 'id') },
		});

		const result = await searchRuns.call(asLoadOptions(context));

		expect(result).toEqual({ results: [] });
		expect(context.calls).toHaveLength(0);
	});

	it('filters runs on the label', async () => {
		const context = createLoadOptionsContext({ parameters: { jobId: JOB_ID } });
		nock(BASE_URL)
			.get(`/v1/jobs/${JOB_ID}/runs`)
			.query(true)
			.reply(200, {
				data: [
					run('4d2b9a10-73e6-49c1-8f5a-0b1c2d3e4f50', { status: 'completed' }),
					run('5e3c0b21-84f7-4ad2-9061-1c2d3e4f5a61', { status: 'failed' }),
				],
				total: 2,
			});

		const result = await searchRuns.call(asLoadOptions(context), 'failed');

		expect(result.results.map((item) => item.value)).toEqual([
			'5e3c0b21-84f7-4ad2-9061-1c2d3e4f5a61',
		]);
	});

	it('surfaces a deleted job rather than showing it as having no runs', async () => {
		const context = createLoadOptionsContext({ parameters: { jobId: JOB_ID } });
		nock(BASE_URL)
			.get(`/v1/jobs/${JOB_ID}/runs`)
			.query(true)
			.reply(404, { error: { code: 'not_found', message: 'Job not found' } });

		const error = await rejectionOf(searchRuns.call(asLoadOptions(context)));

		expect(error.message).toBeTruthy();
	});
});
