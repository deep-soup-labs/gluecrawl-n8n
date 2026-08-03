/**
 * Run: Start.
 *
 * The cheap path — the job already holds a mapper config, so nothing is charged
 * upfront and the run settles afterwards. That is exactly why the timeout copy
 * matters: abandoning the wait abandons nothing, and the account is billed
 * either way.
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

import { execute } from '../../nodes/Gluecrawl/resources/run/start.operation';
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
	jobId: 'job-1',
	waitForCompletion: false,
	outputItems: true,
	timeout: 300,
	options: {},
};

function context(overrides: Record<string, unknown> = {}, continueOnFail = false): ExecuteContext {
	return createExecuteContext({
		parameters: { ...BASE_PARAMETERS, ...overrides },
		continueOnFail,
	});
}

const PENDING_RUN = {
	id: 'run-1',
	job_id: 'job-1',
	status: 'pending',
	created_at: '2026-01-01T00:00:00Z',
};

const COMPLETED_RUN = {
	...PENDING_RUN,
	status: 'completed',
	item_count: 2,
	page_count: 1,
	credits_used: 5,
	billing: {
		listing_pages: 1,
		detail_items: 0,
		protection_level: 'light',
		credits_settled: 5,
	},
	completed_at: '2026-01-01T00:02:00Z',
};

beforeEach(() => installVirtualClock());
afterEach(() => uninstallVirtualClock());

describe('starting without waiting', () => {
	useNock();

	it('posts an empty body and returns the run immediately', async () => {
		let body: unknown;
		const scope = nock(BASE_URL)
			.post('/v1/jobs/job-1/runs', (received) => {
				body = received;
				return true;
			})
			.reply(201, PENDING_RUN);

		const items = await execute.call(asExecute(context()), 0);

		// No max_pages key at all: the API then uses the limit stored on the job.
		expect(body).toEqual({});
		expect(items).toEqual([{ json: PENDING_RUN, pairedItem: { item: 0 } }]);
		scope.done();
	});

	it('sends the Max Pages override when one is set', async () => {
		let body: unknown;
		const scope = nock(BASE_URL)
			.post('/v1/jobs/job-1/runs', (received) => {
				body = received;
				return true;
			})
			.reply(201, PENDING_RUN);

		await execute.call(asExecute(context({ options: { maxPages: 5 } })), 0);

		expect(body).toEqual({ max_pages: 5 });
		scope.done();
	});

	it('trims the job ID before building the path', async () => {
		const scope = nock(BASE_URL).post('/v1/jobs/job-1/runs').reply(201, PENDING_RUN);

		const ctx = context({ jobId: '  job-1  ' });
		await execute.call(asExecute(ctx), 0);

		expect(ctx.calls[0].path).toBe('/v1/jobs/job-1/runs');
		scope.done();
	});

	it('never polls when waiting is off', async () => {
		const scope = nock(BASE_URL).post('/v1/jobs/job-1/runs').reply(201, PENDING_RUN);

		const ctx = context();
		await execute.call(asExecute(ctx), 0);

		expect(ctx.calls).toHaveLength(1);
		scope.done();
	});
});

describe('starting and waiting', () => {
	useNock();

	it('polls to completion and emits one item per row', async () => {
		const scope = nock(BASE_URL);
		scope.post('/v1/jobs/job-1/runs').reply(201, PENDING_RUN);
		scope.get('/v1/runs/run-1').reply(200, { ...PENDING_RUN, status: 'scraping' });
		scope.get('/v1/runs/run-1').reply(200, COMPLETED_RUN);
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

		const items = await execute.call(asExecute(context({ waitForCompletion: true })), 0);

		expect(items).toEqual([
			{
				json: {
					run_id: 'run-1',
					page_number: 1,
					item_index: 0,
					name: 'Widget',
					price: '9.99',
				},
				pairedItem: { item: 0 },
			},
			{
				json: {
					run_id: 'run-1',
					page_number: 1,
					item_index: 1,
					name: 'Gadget',
					price: '19.99',
				},
				pairedItem: { item: 0 },
			},
		]);
		scope.done();
	});

	it('keeps the provenance keys authoritative on a name clash', async () => {
		const scope = nock(BASE_URL);
		scope.post('/v1/jobs/job-1/runs').reply(201, PENDING_RUN);
		scope.get('/v1/runs/run-1').reply(200, COMPLETED_RUN);
		scope
			.get('/v1/runs/run-1/items')
			.query(true)
			.reply(200, {
				items: [{ data: { page_number: 'page 3 of 9' }, page_number: 1, item_index: 0 }],
				total: 1,
			});

		const items = await execute.call(asExecute(context({ waitForCompletion: true })), 0);

		// `run_id`, `page_number` and `item_index` are what a downstream node
		// branches and correlates on, so they must mean what this node says even
		// when a job happens to define a column with the same name. Item: Get Many
		// with Simplify on returns the un-merged row for the rare case that hurts.
		expect(items[0].json.page_number).toBe(1);
		expect(items[0].json.run_id).toBe('run-1');
		scope.done();
	});

	it('emits the run record when the run found nothing', async () => {
		const scope = nock(BASE_URL);
		scope.post('/v1/jobs/job-1/runs').reply(201, PENDING_RUN);
		scope.get('/v1/runs/run-1').reply(200, { ...COMPLETED_RUN, item_count: 0 });
		scope.get('/v1/runs/run-1/items').query(true).reply(200, { items: [], total: 0 });

		const items = await execute.call(asExecute(context({ waitForCompletion: true })), 0);

		// An empty branch would lose the run id and dead-end the workflow.
		expect(items).toHaveLength(1);
		expect(items[0].json).toMatchObject({ id: 'run-1', status: 'completed' });
		scope.done();
	});

	it('emits the run record, with billing, when rows are not wanted', async () => {
		const scope = nock(BASE_URL);
		scope.post('/v1/jobs/job-1/runs').reply(201, PENDING_RUN);
		scope.get('/v1/runs/run-1').reply(200, COMPLETED_RUN);

		const ctx = context({ waitForCompletion: true, outputItems: false });
		const items = await execute.call(asExecute(ctx), 0);

		expect(items[0].json).toMatchObject({ billing: { credits_settled: 5 } });
		expect(ctx.calls.some((call) => call.path.endsWith('/items'))).toBe(false);
		scope.done();
	});

	it('turns a failed run into an actionable error', async () => {
		const scope = nock(BASE_URL);
		scope.post('/v1/jobs/job-1/runs').reply(201, PENDING_RUN);
		scope
			.get('/v1/runs/run-1')
			.reply(200, { ...PENDING_RUN, status: 'failed', error: 'The site blocked the scrape.' });

		const error = await rejectionOf(
			execute.call(asExecute(context({ waitForCompletion: true })), 0),
		);

		expect(error.message).toBe('Gluecrawl run run-1 failed');
		expect(error.description).toContain('The site blocked the scrape.');
		expect(error.description).toContain('job job-1');
		scope.done();
	});

	it('reads sensibly when a failed run reported no reason', async () => {
		const scope = nock(BASE_URL);
		scope.post('/v1/jobs/job-1/runs').reply(201, PENDING_RUN);
		scope.get('/v1/runs/run-1').reply(200, { ...PENDING_RUN, status: 'failed' });

		const error = await rejectionOf(
			execute.call(asExecute(context({ waitForCompletion: true })), 0),
		);

		expect(error.description).toContain('failed without reporting a reason');
		scope.done();
	});

	it('times out naming the run and warning that it keeps billing', async () => {
		const scope = nock(BASE_URL);
		scope.post('/v1/jobs/job-1/runs').reply(201, PENDING_RUN);
		// 20s budget at the default 5s interval: t=0, 5, 10 and 15.
		scope
			.get('/v1/runs/run-1')
			.times(4)
			.reply(200, { ...PENDING_RUN, status: 'scraping' });

		const error = await rejectionOf(
			execute.call(asExecute(context({ waitForCompletion: true, timeout: 20 })), 0),
		);

		expect(error.message).toContain('Timed out after 20s waiting for Gluecrawl run run-1');
		expect(error.description).toContain('did NOT cancel');
		expect(error.description).toContain('still be charged');
		expect(error.description).toContain('run ID run-1');
		// Never phrased as if the run was stopped.
		expect(error.description).not.toMatch(/has been cancelled|was cancelled/i);
		scope.done();
	});

	it('does not fetch rows after a timeout', async () => {
		const scope = nock(BASE_URL);
		scope.post('/v1/jobs/job-1/runs').reply(201, PENDING_RUN);
		scope
			.get('/v1/runs/run-1')
			.times(2)
			.reply(200, { ...PENDING_RUN, status: 'scraping' });

		const ctx = context({ waitForCompletion: true, timeout: 10 });
		await rejectionOf(execute.call(asExecute(ctx), 0));

		expect(ctx.calls.some((call) => call.path.endsWith('/items'))).toBe(false);
		scope.done();
	});
});

describe('errors from the start call itself', () => {
	useNock();

	it('explains a job that is not ready', async () => {
		const scope = nock(BASE_URL)
			.post('/v1/jobs/job-1/runs')
			.reply(409, { error: { code: 'job_not_ready', message: 'Job is not ready.' } });

		const error = await rejectionOf(execute.call(asExecute(context()), 0));

		expect(error.message).toBe('The job is not ready to run');
		expect(error.description).toContain('While starting a run for job job-1.');
		expect(error.description).toContain('stale');
		scope.done();
	});

	it('surfaces Retry-After on the 10-per-minute limit', async () => {
		const scope = nock(BASE_URL)
			.post('/v1/jobs/job-1/runs')
			.reply(
				429,
				{ error: { code: 'rate_limited', message: 'Rate limit exceeded.' } },
				{ 'Retry-After': '42' },
			);

		const error = await rejectionOf(execute.call(asExecute(context()), 0));

		expect(error.message).toContain('retry in 42s');
		expect(error.description).toContain('10 run starts');
		scope.done();
	});

	it('says an enqueue failure is retryable', async () => {
		const scope = nock(BASE_URL)
			.post('/v1/jobs/job-1/runs')
			.reply(502, { error: { code: 'enqueue_failed', message: 'Could not enqueue.' } });

		const error = await rejectionOf(execute.call(asExecute(context()), 0));

		expect(error.message).toContain('could not queue');
		expect(error.description).toMatch(/safe to retry/i);
		scope.done();
	});

	it('emits an error item, description included, when continue on fail is set', async () => {
		const scope = nock(BASE_URL)
			.post('/v1/jobs/job-1/runs')
			.reply(402, { error: { code: 'insufficient_credits', message: 'Balance is 0.' } });

		const items = await execute.call(asExecute(context({}, true)), 0);

		expect(items).toEqual([
			{
				json: {
					error: 'Not enough Gluecrawl credits to run this',
					errorDescription: expect.stringContaining('Balance is 0.'),
				},
				pairedItem: { item: 0 },
			},
		]);
		scope.done();
	});

	it('emits a failed run as an item when continue on fail is set', async () => {
		const scope = nock(BASE_URL);
		scope.post('/v1/jobs/job-1/runs').reply(201, PENDING_RUN);
		scope.get('/v1/runs/run-1').reply(200, { ...PENDING_RUN, status: 'failed', error: 'blocked' });

		const items = await execute.call(asExecute(context({ waitForCompletion: true }, true)), 0);

		expect(items[0].json.error).toBe('Gluecrawl run run-1 failed');
		scope.done();
	});
});
