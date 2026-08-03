/**
 * Run: Get and Run: Get Many.
 *
 * Both are plain reads, and reads are not rate limited at the v1 layer, which
 * is what makes Run: Get the operation to poll with after a Run: Start that did
 * not wait. The assertions therefore focus on passthrough fidelity — the
 * `billing` sub-object a workflow gates on, and the optional fields that are
 * absent rather than null while a run is still in flight.
 */

import nock from 'nock';
import type { IExecuteFunctions } from 'n8n-workflow';

import { execute as getRun } from '../../nodes/Gluecrawl/resources/run/get.operation';
import { execute as getManyRuns } from '../../nodes/Gluecrawl/resources/run/getMany.operation';
import {
	BASE_URL,
	createExecuteContext,
	rejectionOf,
	resourceLocatorValue,
	useNock,
	type ExecuteContext,
} from '../helpers';

function asExecute(context: ExecuteContext): IExecuteFunctions {
	return context as unknown as IExecuteFunctions;
}

function run(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		job_id: 'job-1',
		status: 'completed',
		created_at: '2026-01-01T00:00:00Z',
		...extra,
	};
}

describe('Run: Get', () => {
	useNock();

	it('passes the settled run through, billing included', async () => {
		const settled = run('run-1', {
			item_count: 42,
			page_count: 3,
			credits_used: 12,
			protection_level: 'moderate',
			billing: {
				listing_pages: 3,
				detail_items: 42,
				protection_level: 'moderate',
				credits_settled: 12,
			},
			completed_at: '2026-01-01T00:05:00Z',
		});
		const scope = nock(BASE_URL).get('/v1/runs/run-1').reply(200, settled);

		const context = createExecuteContext({ parameters: { runId: 'run-1' } });
		const items = await getRun.call(asExecute(context), 0);

		expect(items).toEqual([{ json: settled, pairedItem: { item: 0 } }]);
		scope.done();
	});

	it('leaves the unsettled fields absent on a run still in flight', async () => {
		const scraping = run('run-1', { status: 'scraping' });
		const scope = nock(BASE_URL).get('/v1/runs/run-1').reply(200, scraping);

		const context = createExecuteContext({ parameters: { runId: 'run-1' } });
		const [item] = await getRun.call(asExecute(context), 0);

		expect(item.json).not.toHaveProperty('billing');
		expect(item.json).not.toHaveProperty('completed_at');
		expect(item.json).not.toHaveProperty('error');
		scope.done();
	});

	it('trims the run ID before building the path', async () => {
		const scope = nock(BASE_URL).get('/v1/runs/run-1').reply(200, run('run-1'));

		const context = createExecuteContext({ parameters: { runId: ' run-1 ' } });
		await getRun.call(asExecute(context), 0);

		expect(context.calls[0].path).toBe('/v1/runs/run-1');
		scope.done();
	});

	it('resolves a run picked from the list, not just one typed as an ID', async () => {
		// The picker stores {__rl, mode, value}; the operation must see the bare
		// id. Both shapes have to reach the same path or the two modes of the
		// same field would behave differently.
		const scope = nock(BASE_URL).get('/v1/runs/run-1').reply(200, run('run-1'));

		const context = createExecuteContext({
			parameters: { runId: resourceLocatorValue('run-1') },
		});
		await getRun.call(asExecute(context), 0);

		expect(context.calls[0].path).toBe('/v1/runs/run-1');
		scope.done();
	});

	it('keys the request on the run alone, never sending the Job', async () => {
		// If the job ever leaked into the request path, a stale Job value would
		// start changing WHICH run is fetched rather than being caught below.
		const scope = nock(BASE_URL).get('/v1/runs/run-1').reply(200, run('run-1'));

		const context = createExecuteContext({
			parameters: {
				jobId: resourceLocatorValue('job-1'),
				runId: resourceLocatorValue('run-1'),
			},
		});
		await getRun.call(asExecute(context), 0);

		// One request, and the scope check rode along on it for free.
		expect(context.calls).toHaveLength(1);
		expect(context.calls[0].path).toBe('/v1/runs/run-1');
		scope.done();
	});

	it('rejects a run left over from a previously selected job', async () => {
		// n8n refreshes the run LIST when the Job changes but does not clear the
		// already-selected run (verified against n8n 2.32.7), so the two drift
		// apart in the panel. Silently returning another job's run is the one
		// outcome worth failing over: the result would look entirely legitimate.
		const scope = nock(BASE_URL).get('/v1/runs/run-1').reply(200, run('run-1'));

		const context = createExecuteContext({
			parameters: {
				jobId: resourceLocatorValue('job-99'),
				runId: resourceLocatorValue('run-1'),
			},
		});
		const error = await rejectionOf(getRun.call(asExecute(context), 0));

		expect(error.message).toBe(
			'The selected run belongs to job job-1, not to the selected job job-99',
		);
		expect(String(error.description)).toContain('Re-pick the run');
		scope.done();
	});

	it('does not fail when the job is left empty', async () => {
		// Nothing to compare against is not a mismatch. The field is required, so
		// n8n blocks the empty case first; failing here would only replace a clear
		// message with a confusing one.
		const scope = nock(BASE_URL).get('/v1/runs/run-1').reply(200, run('run-1'));

		const context = createExecuteContext({
			parameters: { jobId: resourceLocatorValue(''), runId: resourceLocatorValue('run-1') },
		});
		const result = await getRun.call(asExecute(context), 0);

		expect(result[0].json.id).toBe('run-1');
		scope.done();
	});

	it('maps a 404 with the operation context', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/runs/nope')
			.reply(404, { error: { code: 'not_found', message: 'Run not found.' } });

		const context = createExecuteContext({ parameters: { runId: 'nope' } });
		const error = await rejectionOf(getRun.call(asExecute(context), 0));

		expect(error.message).toBe('Gluecrawl has no record with that ID');
		expect(error.description).toContain('While fetching run nope.');
		scope.done();
	});

	it('emits an error item when continue on fail is set', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/runs/nope')
			.reply(403, {
				error: {
					code: 'plan_required',
					message: 'This endpoint requires a Starter plan or higher.',
				},
			});

		const context = createExecuteContext({
			parameters: { runId: 'nope' },
			continueOnFail: true,
		});
		const items = await getRun.call(asExecute(context), 0);

		expect(items[0].json.error).toBe('The Gluecrawl account is on a plan without API access');
		// The mapped wording has to survive into the error branch as well.
		expect(String(items[0].json.errorDescription)).toContain(
			'This endpoint requires a Starter plan or higher.',
		);
		expect(String(items[0].json.errorDescription)).toContain('https://www.gluecrawl.ai/pricing');
		scope.done();
	});
});

describe('Run: Get Many', () => {
	useNock();

	it('lists the run history of one job, newest first', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/jobs/job-1/runs')
			.query({ limit: '2', offset: '0' })
			.reply(200, { data: [run('run-2'), run('run-1')], total: 2, limit: 2, offset: 0 });

		const context = createExecuteContext({
			parameters: { jobId: 'job-1', returnAll: false, limit: 2 },
		});
		const items = await getManyRuns.call(asExecute(context), 0);

		expect(items.map((item) => item.json.id)).toEqual(['run-2', 'run-1']);
		expect(items[0].pairedItem).toEqual({ item: 0 });
		scope.done();
	});

	it('pages a limit above the endpoint ceiling instead of sending it', async () => {
		const page = (start: number, count: number) =>
			Array.from({ length: count }, (_, i) => run(`run-${start + i}`));
		const scope = nock(BASE_URL);
		scope
			.get('/v1/jobs/job-1/runs')
			.query({ limit: '100', offset: '0' })
			.reply(200, { data: page(0, 100), total: 250 });
		scope
			.get('/v1/jobs/job-1/runs')
			.query({ limit: '100', offset: '100' })
			.reply(200, { data: page(100, 100), total: 250 });

		const context = createExecuteContext({
			parameters: { jobId: 'job-1', returnAll: false, limit: 150 },
		});
		const items = await getManyRuns.call(asExecute(context), 0);

		expect(items).toHaveLength(150);
		expect(context.calls.every((call) => call.query.limit === '100')).toBe(true);
		scope.done();
	});

	it('walks every page when Return All is on', async () => {
		const scope = nock(BASE_URL);
		scope
			.get('/v1/jobs/job-1/runs')
			.query({ limit: '100', offset: '0' })
			.reply(200, {
				data: Array.from({ length: 100 }, (_, i) => run(`run-${i}`)),
				total: 102,
			});
		scope
			.get('/v1/jobs/job-1/runs')
			.query({ limit: '100', offset: '100' })
			.reply(200, { data: [run('run-100'), run('run-101')], total: 102 });

		const context = createExecuteContext({ parameters: { jobId: 'job-1', returnAll: true } });
		const items = await getManyRuns.call(asExecute(context), 0);

		expect(items).toHaveLength(102);
		scope.done();
	});

	it('emits nothing for a job that has never run', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/jobs/job-1/runs')
			.query(true)
			.reply(200, { data: [], total: 0, limit: 100, offset: 0 });

		const context = createExecuteContext({ parameters: { jobId: 'job-1', returnAll: true } });
		await expect(getManyRuns.call(asExecute(context), 0)).resolves.toEqual([]);

		scope.done();
	});

	it('maps a failure with the operation context', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/jobs/job-1/runs')
			.query(true)
			.reply(404, { error: { code: 'not_found', message: 'Job not found.' } });

		const context = createExecuteContext({ parameters: { jobId: ' job-1 ', returnAll: true } });
		const error = await rejectionOf(getManyRuns.call(asExecute(context), 0));

		expect(error.description).toContain('While listing the runs of job job-1.');
		scope.done();
	});

	it('emits an error item when continue on fail is set', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/jobs/job-1/runs')
			.query(true)
			.reply(401, { error: { code: 'invalid_api_key', message: 'Invalid API key.' } });

		const context = createExecuteContext({
			parameters: { jobId: 'job-1', returnAll: true },
			continueOnFail: true,
		});
		const items = await getManyRuns.call(asExecute(context), 0);

		expect(items[0].json.error).toBe('Gluecrawl rejected the API key');
		scope.done();
	});
});
