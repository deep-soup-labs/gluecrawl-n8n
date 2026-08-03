/**
 * Job: Create.
 *
 * Two things carry real money here and are asserted hardest: the request body
 * (a wrong `input` union silently produces a job that extracts the wrong thing,
 * and the job is charged either way), and the timeout copy (a timeout that
 * reads like a cancellation invites a retry that pays twice).
 */

jest.mock('n8n-workflow', () => {
	const actual = jest.requireActual('n8n-workflow');
	const { virtualClock } = jest.requireActual('../helpers/clock');
	return {
		...actual,
		sleep: async (ms: number) => {
			virtualClock.now += ms;
		},
	};
});

import nock from 'nock';
import type { IExecuteFunctions } from 'n8n-workflow';

import { execute } from '../../nodes/Gluecrawl/resources/job/create.operation';
import {
	BASE_URL,
	createExecuteContext,
	rejectionOf,
	useNock,
	type ExecuteContext,
} from '../helpers';
import { installVirtualClock, uninstallVirtualClock } from '../helpers/clock';

function asExecute(context: ExecuteContext): IExecuteFunctions {
	return context as unknown as IExecuteFunctions;
}

const BASE_PARAMETERS = {
	url: 'https://example.com/products?category=shoes',
	inputMode: 'goal',
	goal: 'Extract the name and price of every product',
	maxPages: 2,
	waitForCompletion: false,
	outputItems: true,
	timeout: 300,
};

function context(overrides: Record<string, unknown> = {}, continueOnFail = false): ExecuteContext {
	return createExecuteContext({
		parameters: { ...BASE_PARAMETERS, ...overrides },
		continueOnFail,
	});
}

const CREATED_JOB = {
	id: 'job-1',
	url: BASE_PARAMETERS.url,
	status: 'in_progress',
	max_pages: 2,
	created_at: '2026-01-01T00:00:00Z',
	updated_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => installVirtualClock());
afterEach(() => uninstallVirtualClock());

describe('the request body', () => {
	useNock();

	it('sends the goal variant of the input union', async () => {
		let body: unknown;
		const scope = nock(BASE_URL)
			.post('/v1/jobs', (received) => {
				body = received;
				return true;
			})
			.reply(201, CREATED_JOB);

		const ctx = context();
		const items = await execute.call(asExecute(ctx), 0);

		expect(body).toEqual({
			url: 'https://example.com/products?category=shoes',
			input: { type: 'goal', value: 'Extract the name and price of every product' },
			max_pages: 2,
		});
		expect(items).toEqual([{ json: CREATED_JOB, pairedItem: { item: 0 } }]);
		scope.done();
	});

	it('keeps the URL query string verbatim', async () => {
		let body: { url?: string } = {};
		const scope = nock(BASE_URL)
			.post('/v1/jobs', (received) => {
				body = received;
				return true;
			})
			.reply(201, CREATED_JOB);

		// Filters, sort order and pagination live in the query string; stripping
		// any of it scrapes a different page than the user asked for.
		const url = 'https://example.com/p?category=shoes&sort=price_desc&utm_source=n8n';
		await execute.call(asExecute(context({ url })), 0);

		expect(body.url).toBe(url);
		scope.done();
	});

	it('sends columns as name/type pairs and nothing else', async () => {
		let body: { input?: { type: string; value: unknown[] } } = {};
		const scope = nock(BASE_URL)
			.post('/v1/jobs', (received) => {
				body = received;
				return true;
			})
			.reply(201, CREATED_JOB);

		await execute.call(
			asExecute(
				context({
					inputMode: 'columns',
					columns: {
						column: [
							// A stray key must not reach the API: it silently drops unknown
							// keys, so a "description" field would produce a wrong job with
							// no error at all.
							{ name: ' price ', type: 'number', description: 'the price' },
							{ name: 'product URL', type: 'url' },
							// Rows the user added and never filled in.
							{ name: '   ', type: 'text' },
							{ name: '', type: 'text' },
						],
					},
				}),
			),
			0,
		);

		expect(body.input).toEqual({
			type: 'columns',
			value: [
				{ name: 'price', type: 'number' },
				{ name: 'product URL', type: 'url' },
			],
		});
		for (const column of body.input?.value ?? []) {
			expect(Object.keys(column as object).sort()).toEqual(['name', 'type']);
		}
		scope.done();
	});

	it('defaults a column with no type to text', async () => {
		let body: { input?: { value: unknown[] } } = {};
		const scope = nock(BASE_URL)
			.post('/v1/jobs', (received) => {
				body = received;
				return true;
			})
			.reply(201, CREATED_JOB);

		await execute.call(
			asExecute(context({ inputMode: 'columns', columns: { column: [{ name: 'title' }] } })),
			0,
		);

		expect(body.input?.value).toEqual([{ name: 'title', type: 'text' }]);
		scope.done();
	});

	it('refuses an empty columns list before spending anything', async () => {
		const ctx = context({ inputMode: 'columns', columns: { column: [{ name: '  ' }] } });
		const error = await rejectionOf(execute.call(asExecute(ctx), 0));

		expect(error.message).toContain('at least one named column');
		// Creating a job is charged upfront, so a request must not leave the node.
		expect(ctx.calls).toHaveLength(0);
	});

	it('refuses an empty goal before spending anything', async () => {
		const ctx = context({ goal: '   ' });
		const error = await rejectionOf(execute.call(asExecute(ctx), 0));

		expect(error.message).toContain('Goal is empty');
		expect(ctx.calls).toHaveLength(0);
	});
});

describe('waiting for the first run', () => {
	useNock();

	const READY_JOB = { ...CREATED_JOB, status: 'ready', columns: { listing: [], detail: [] } };

	function mockHappyPath() {
		const scope = nock(BASE_URL);
		scope.post('/v1/jobs').reply(201, CREATED_JOB);
		scope.get('/v1/jobs/job-1').reply(200, CREATED_JOB);
		scope.get('/v1/jobs/job-1').reply(200, READY_JOB);
		scope
			.get('/v1/jobs/job-1/runs')
			.query({ limit: '1', offset: '0' })
			.reply(200, { data: [{ id: 'run-1', job_id: 'job-1', status: 'pending' }], total: 1 });
		scope.get('/v1/runs/run-1').reply(200, { id: 'run-1', job_id: 'job-1', status: 'scraping' });
		scope.get('/v1/runs/run-1').reply(200, {
			id: 'run-1',
			job_id: 'job-1',
			status: 'completed',
			item_count: 2,
			billing: { listing_pages: 1, detail_items: 0, protection_level: 'light', credits_settled: 5 },
		});
		return scope;
	}

	it('maps, runs and emits one item per scraped row', async () => {
		const scope = mockHappyPath();
		scope
			.get('/v1/runs/run-1/items')
			.query({ limit: '500', offset: '0' })
			.reply(200, {
				items: [
					{ data: { name: 'Widget', price: '9.99' }, page_number: 1, item_index: 0 },
					{ data: { name: 'Gadget', price: '19.99' }, page_number: 1, item_index: 1 },
				],
				total: 2,
			});

		const ctx = context({ waitForCompletion: true });
		const items = await execute.call(asExecute(ctx), 0);

		// Identical key set to Run: Start, `run_id` included — switching a workflow
		// between create-and-wait and rerun must not re-map the downstream nodes.
		expect(items).toEqual([
			{
				json: { name: 'Widget', price: '9.99', run_id: 'run-1', page_number: 1, item_index: 0 },
				pairedItem: { item: 0 },
			},
			{
				json: { name: 'Gadget', price: '19.99', run_id: 'run-1', page_number: 1, item_index: 1 },
				pairedItem: { item: 0 },
			},
		]);
		scope.done();
	});

	it('falls back to the job plus the run when the scrape found nothing', async () => {
		// The job-creation cost is already charged and the run has settled, so
		// emitting nothing would dead-end the branch and lose both ids. Run: Start
		// emits the run in exactly this situation; the two must not diverge.
		const scope = mockHappyPath();
		scope
			.get('/v1/runs/run-1/items')
			.query({ limit: '500', offset: '0' })
			.reply(200, { items: [], total: 0 });

		const ctx = context({ waitForCompletion: true });
		const items = await execute.call(asExecute(ctx), 0);

		expect(items).toHaveLength(1);
		expect(items[0].json).toMatchObject({
			id: 'job-1',
			status: 'ready',
			run: { id: 'run-1', status: 'completed' },
		});
		expect(items[0].pairedItem).toEqual({ item: 0 });
		scope.done();
	});

	it('emits the job with the run nested when rows are not wanted', async () => {
		const scope = mockHappyPath();

		const ctx = context({ waitForCompletion: true, outputItems: false });
		const items = await execute.call(asExecute(ctx), 0);

		expect(items).toHaveLength(1);
		expect(items[0].json).toMatchObject({
			id: 'job-1',
			status: 'ready',
			run: { id: 'run-1', status: 'completed' },
		});
		// The rows endpoint must not be touched when the rows are not wanted.
		expect(ctx.calls.some((call) => call.path.endsWith('/items'))).toBe(false);
		scope.done();
	});

	it('treats a failed mapping as terminal and says a new job is needed', async () => {
		const scope = nock(BASE_URL);
		scope.post('/v1/jobs').reply(201, CREATED_JOB);
		scope
			.get('/v1/jobs/job-1')
			.reply(200, { ...CREATED_JOB, status: 'failed', error: 'No listing found on the page.' });

		const error = await rejectionOf(
			execute.call(asExecute(context({ waitForCompletion: true })), 0),
		);

		expect(error.message).toBe('Gluecrawl could not map this site');
		expect(error.description).toContain('No listing found on the page.');
		expect(error.description).toContain('terminal');
		expect(error.description).toContain('NEW job');
		scope.done();
	});

	it('explains a stale job differently from a failed one', async () => {
		const scope = nock(BASE_URL);
		scope.post('/v1/jobs').reply(201, CREATED_JOB);
		scope.get('/v1/jobs/job-1').reply(200, { ...CREATED_JOB, status: 'stale' });

		const error = await rejectionOf(
			execute.call(asExecute(context({ waitForCompletion: true })), 0),
		);

		expect(error.message).toContain('found no rows');
		expect(error.description).toMatch(/detail or landing page/);
		scope.done();
	});

	it('reports a failed run without claiming the job is unusable', async () => {
		const scope = nock(BASE_URL);
		scope.post('/v1/jobs').reply(201, CREATED_JOB);
		scope.get('/v1/jobs/job-1').reply(200, READY_JOB);
		scope
			.get('/v1/jobs/job-1/runs')
			.query(true)
			.reply(200, { data: [{ id: 'run-1', job_id: 'job-1', status: 'pending' }], total: 1 });
		scope
			.get('/v1/runs/run-1')
			.reply(200, { id: 'run-1', job_id: 'job-1', status: 'failed', error: 'Site timed out.' });

		const error = await rejectionOf(
			execute.call(asExecute(context({ waitForCompletion: true })), 0),
		);

		expect(error.message).toBe('The Gluecrawl run failed');
		expect(error.description).toContain('Site timed out.');
		// The job survives a failed run, so the fix is a retry, not a new job.
		expect(error.description).toContain('Run: Start');
		scope.done();
	});

	it('times out naming the run and warning that it keeps billing', async () => {
		const scope = nock(BASE_URL);
		scope.post('/v1/jobs').reply(201, CREATED_JOB);
		scope.get('/v1/jobs/job-1').reply(200, READY_JOB);
		scope
			.get('/v1/jobs/job-1/runs')
			.query(true)
			.reply(200, { data: [{ id: 'run-1', job_id: 'job-1', status: 'pending' }], total: 1 });
		// 20s budget at the default 5s interval: t=0, 5, 10 and 15, then the next
		// sleep would overrun the deadline.
		scope
			.get('/v1/runs/run-1')
			.times(4)
			.reply(200, { id: 'run-1', job_id: 'job-1', status: 'scraping' });

		const ctx = context({ waitForCompletion: true, timeout: 20 });
		const error = await rejectionOf(execute.call(asExecute(ctx), 0));

		expect(error.message).toContain('run run-1');
		expect(error.description).toContain('did NOT cancel');
		expect(error.description).toContain('still be charged');
		expect(error.description).toContain('run ID run-1');
		scope.done();
	});

	it('shares one budget across mapping and the run', async () => {
		const scope = nock(BASE_URL);
		scope.post('/v1/jobs').reply(201, CREATED_JOB);
		// The mapper eats the whole 10s budget, so the run wait gets none of it
		// and fails on its first look rather than doubling the configured wait.
		scope.get('/v1/jobs/job-1').times(2).reply(200, CREATED_JOB);

		const ctx = context({ waitForCompletion: true, timeout: 10 });
		const error = await rejectionOf(execute.call(asExecute(ctx), 0));

		expect(error.message).toContain('job job-1');
		scope.done();
	});
});

describe('continue on fail', () => {
	useNock();

	it('emits the mapped error as an item instead of throwing', async () => {
		const scope = nock(BASE_URL)
			.post('/v1/jobs')
			.reply(402, {
				error: { code: 'insufficient_credits', message: 'Balance is 0 credits, 25 required.' },
			});

		const items = await execute.call(asExecute(context({}, true)), 0);

		expect(items).toHaveLength(1);
		expect(items[0].json.error).toBe('Not enough Gluecrawl credits to run this');
		// The description is the half that says what to do about it.
		expect(String(items[0].json.errorDescription)).toContain('Balance is 0 credits, 25 required.');
		expect(items[0].pairedItem).toEqual({ item: 0 });
		scope.done();
	});

	it('emits a validation failure as an item too', async () => {
		const items = await execute.call(asExecute(context({ goal: '' }, true)), 0);

		expect(items[0].json.error).toContain('Goal is empty');
	});
});
