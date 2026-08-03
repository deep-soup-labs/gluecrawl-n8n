/**
 * The wait helpers.
 *
 * Real waiting is replaced by the virtual clock in `tests/helpers/clock.ts`:
 * `sleep` advances a counter that `Date.now` reads, so the elapsed time these
 * tests assert on is exactly the time the code asked for, and the suite runs in
 * milliseconds.
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

import {
	DEFAULT_POLL_INTERVAL_MS,
	MIN_POLL_INTERVAL_MS,
	isRunTerminal,
	pollUntil,
	waitForJobMapped,
	waitForRunTerminal,
	waitTimeoutError,
} from '../../nodes/Gluecrawl/transport/poll';
import {
	BASE_URL,
	NODE,
	createExecuteContext,
	rejectionOf,
	useNock,
	type ExecuteContext,
} from '../helpers';
import { installVirtualClock, uninstallVirtualClock, virtualElapsedMs } from '../helpers/clock';

function asExecute(context: ExecuteContext): IExecuteFunctions {
	return context as unknown as IExecuteFunctions;
}

beforeEach(() => installVirtualClock());
afterEach(() => uninstallVirtualClock());

describe('pollUntil', () => {
	it('makes at least one attempt even with a zero budget', async () => {
		const fetch = jest.fn().mockResolvedValue('done');

		await expect(
			pollUntil(fetch, (value) => value === 'done', {
				timeoutMs: 0,
				onTimeout: () => {
					throw new Error('should not time out');
				},
			}),
		).resolves.toBe('done');

		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('hands the last seen value to onTimeout', async () => {
		const fetch = jest.fn().mockResolvedValue({ status: 'scraping' });

		await expect(
			pollUntil(fetch, () => false, {
				intervalMs: 1_000,
				timeoutMs: 2_500,
				onTimeout: (last) => {
					throw new Error(`gave up on ${JSON.stringify(last)}`);
				},
			}),
		).rejects.toThrow('gave up on {"status":"scraping"}');

		// 0ms and 1000ms attempts fit the budget; the 2000ms one would overrun it.
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(virtualElapsedMs()).toBe(2_000);
	});

	it('floors the interval so a misconfigured node cannot hammer the API', async () => {
		const fetch = jest.fn().mockResolvedValue('pending');

		await expect(
			pollUntil(fetch, (value) => value === 'done', {
				intervalMs: 5,
				timeoutMs: 2_500,
				onTimeout: () => {
					throw new Error('timeout');
				},
			}),
		).rejects.toThrow('timeout');

		expect(virtualElapsedMs()).toBe(MIN_POLL_INTERVAL_MS * 2);
	});
});

describe('isRunTerminal', () => {
	it('accepts only completed and failed', () => {
		expect(isRunTerminal('completed')).toBe(true);
		expect(isRunTerminal('failed')).toBe(true);
		expect(isRunTerminal('pending')).toBe(false);
		expect(isRunTerminal('scraping')).toBe(false);
		expect(isRunTerminal(undefined)).toBe(false);
		// An unknown status is treated as still running and left to the timeout,
		// so a new API status cannot make a wait return half-finished data.
		expect(isRunTerminal('cancelling')).toBe(false);
	});
});

describe('waitForRunTerminal', () => {
	useNock();

	it('polls at the default interval until the run completes', async () => {
		const scope = nock(BASE_URL);
		scope.get('/v1/runs/run-1').reply(200, { id: 'run-1', status: 'pending' });
		scope.get('/v1/runs/run-1').reply(200, { id: 'run-1', status: 'scraping' });
		scope.get('/v1/runs/run-1').reply(200, { id: 'run-1', status: 'completed', item_count: 7 });

		const context = createExecuteContext();
		const run = await waitForRunTerminal.call(asExecute(context), 'run-1', { timeoutMs: 300_000 });

		expect(run).toMatchObject({ status: 'completed', item_count: 7 });
		expect(context.calls).toHaveLength(3);
		expect(virtualElapsedMs()).toBe(DEFAULT_POLL_INTERVAL_MS * 2);
		scope.done();
	});

	it('returns a failed run rather than throwing', async () => {
		// Whether a failed run is fatal depends on the operation's continue-on-fail
		// setting, so the decision belongs to the caller, not the wait helper.
		const scope = nock(BASE_URL)
			.get('/v1/runs/run-1')
			.reply(200, { id: 'run-1', status: 'failed', error: 'blocked by the site' });

		const context = createExecuteContext();
		const run = await waitForRunTerminal.call(asExecute(context), 'run-1', { timeoutMs: 10_000 });

		expect(run.status).toBe('failed');
		scope.done();
	});

	it('times out with a message that names the run and warns it is still billing', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/runs/run-1')
			.times(3)
			.reply(200, { id: 'run-1', status: 'scraping' });

		const context = createExecuteContext();
		const error = await rejectionOf(
			waitForRunTerminal.call(asExecute(context), 'run-1', { intervalMs: 1_000, timeoutMs: 3_000 }),
		);

		expect(error.message).toContain('run-1');
		expect(error.message).toContain('Timed out after 3s');

		const description = error.description ?? '';
		expect(description).toContain('did NOT cancel');
		expect(description).toContain('still be charged');
		expect(description).toContain('run ID run-1');
		expect(description).toContain('"scraping"');
		scope.done();
	});

	it('maps an API failure during the wait instead of leaking a raw error', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/runs/run-1')
			.reply(404, { error: { code: 'not_found', message: 'Run not found.' } });

		const context = createExecuteContext();
		await expect(
			waitForRunTerminal.call(asExecute(context), 'run-1', { timeoutMs: 10_000 }),
		).rejects.toMatchObject({
			message: 'Gluecrawl has no record with that ID',
			description: expect.stringContaining('While waiting for the run to finish.'),
		});

		scope.done();
	});
});

describe('waitForJobMapped', () => {
	useNock();

	it('waits out in_progress and returns the mapped job', async () => {
		const scope = nock(BASE_URL);
		scope.get('/v1/jobs/job-1').reply(200, { id: 'job-1', status: 'in_progress' });
		scope
			.get('/v1/jobs/job-1')
			.reply(200, { id: 'job-1', status: 'ready', columns: { listing: [], detail: [] } });

		const context = createExecuteContext();
		const job = await waitForJobMapped.call(asExecute(context), 'job-1', { timeoutMs: 300_000 });

		expect(job.status).toBe('ready');
		expect(context.calls).toHaveLength(2);
		scope.done();
	});

	it.each(['failed', 'stale'])('returns a %s job so the caller can explain it', async (status) => {
		const scope = nock(BASE_URL).get('/v1/jobs/job-1').reply(200, { id: 'job-1', status });

		const context = createExecuteContext();
		const job = await waitForJobMapped.call(asExecute(context), 'job-1', { timeoutMs: 10_000 });

		expect(job.status).toBe(status);
		scope.done();
	});

	it('times out naming the job, since no run exists yet', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/jobs/job-1')
			.times(2)
			.reply(200, { id: 'job-1', status: 'in_progress' });

		const context = createExecuteContext();
		const error = await rejectionOf(
			waitForJobMapped.call(asExecute(context), 'job-1', { intervalMs: 1_000, timeoutMs: 2_000 }),
		);

		expect(error.message).toContain('job job-1');
		expect(error.description).toContain('Job: Get');
		scope.done();
	});
});

describe('waitTimeoutError', () => {
	it('rounds the budget to whole seconds and points at the run', () => {
		const error = waitTimeoutError(NODE, { timeoutMs: 90_400, runId: 'run-9' });

		expect(error.message).toContain('Timed out after 90s');
		expect(error.description).toContain('Run: Get or Item: Get Many operation using run ID run-9');
		// Never worded as if something was aborted: /v1 has no cancel endpoint.
		expect(error.description).not.toMatch(/cancelled the|aborted the/i);
	});

	it('falls back to the job when there is no run yet', () => {
		const error = waitTimeoutError(NODE, { timeoutMs: 10_000, jobId: 'job-9' });

		expect(error.message).toContain('job job-9');
		expect(error.description).toContain('Job: Get operation using job ID job-9');
	});
});
