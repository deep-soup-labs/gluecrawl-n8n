/**
 * Job: Get, Get Many and Delete.
 *
 * The recurring trap in all three is the `/v1` habit of OMITTING null-valued
 * fields rather than sending them as null, so the passthrough must not
 * normalise anything into existence: a downstream expression testing
 * `columns === null` would never match, and one testing `columns` has to see
 * the key genuinely absent.
 */

import nock from 'nock';
import type { IExecuteFunctions } from 'n8n-workflow';

import { execute as deleteJob } from '../../nodes/Gluecrawl/resources/job/deleteJob.operation';
import { execute as getJob } from '../../nodes/Gluecrawl/resources/job/get.operation';
import { execute as getManyJobs } from '../../nodes/Gluecrawl/resources/job/getMany.operation';
import {
	BASE_URL,
	createExecuteContext,
	rejectionOf,
	useNock,
	type ExecuteContext,
} from '../helpers';

function asExecute(context: ExecuteContext): IExecuteFunctions {
	return context as unknown as IExecuteFunctions;
}

function job(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		url: `https://example.com/${id}`,
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
		...extra,
	};
}

describe('Job: Get', () => {
	useNock();

	it('passes the job through untouched', async () => {
		const ready = job('job-1', {
			status: 'ready',
			input: { type: 'goal', value: 'every product' },
			columns: { listing: [{ name: 'name', type: 'text' }], detail: [] },
			max_pages: 3,
			protection_level: 'light',
		});
		const scope = nock(BASE_URL).get('/v1/jobs/job-1').reply(200, ready);

		const context = createExecuteContext({ parameters: { jobId: 'job-1' } });
		const items = await getJob.call(asExecute(context), 0);

		expect(items).toEqual([{ json: ready, pairedItem: { item: 0 } }]);
		scope.done();
	});

	it('flattens the nested fields when Simplify is on', async () => {
		const ready = job('job-1', {
			status: 'ready',
			input: { type: 'goal', value: 'every product' },
			columns: {
				listing: [{ name: 'name', type: 'text' }],
				detail: [{ name: 'sku', type: 'text' }],
			},
			max_pages: 3,
			protection_level: 'light',
		});
		const scope = nock(BASE_URL).get('/v1/jobs/job-1').reply(200, ready);

		const context = createExecuteContext({ parameters: { jobId: 'job-1', simplify: true } });
		const [item] = await getJob.call(asExecute(context), 0);

		// `input` and `columns` collapse to the parts an expression addresses, and
		// `protection_level` drops out entirely.
		expect(item.json).toEqual({
			id: 'job-1',
			url: 'https://example.com/job-1',
			status: 'ready',
			goal: 'every product',
			listing_columns: ['name'],
			detail_columns: ['sku'],
			max_pages: 3,
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
		});
		scope.done();
	});

	it('names the requested columns when the job was created from a column list', async () => {
		const mapping = job('job-1', {
			status: 'mapping',
			input: { type: 'columns', value: [{ name: 'price', type: 'number' }] },
		});
		const scope = nock(BASE_URL).get('/v1/jobs/job-1').reply(200, mapping);

		const context = createExecuteContext({ parameters: { jobId: 'job-1', simplify: true } });
		const [item] = await getJob.call(asExecute(context), 0);

		expect(item.json).toMatchObject({ requested_columns: ['price'] });
		// Still mapping, so the mapper has resolved no columns yet. Simplifying must
		// not invent the keys the raw shape leaves absent.
		expect(item.json).not.toHaveProperty('listing_columns');
		expect(item.json).not.toHaveProperty('goal');
		expect(item.json).not.toHaveProperty('error');
		scope.done();
	});

	it('leaves absent optional fields absent rather than filling in nulls', async () => {
		// A job that is still mapping: no columns yet, and no error, schedule or
		// input echoed back. All four keys are missing, not null.
		const inProgress = job('job-1', { status: 'in_progress' });
		const scope = nock(BASE_URL).get('/v1/jobs/job-1').reply(200, inProgress);

		const context = createExecuteContext({ parameters: { jobId: 'job-1' } });
		const [item] = await getJob.call(asExecute(context), 0);

		expect(item.json).not.toHaveProperty('columns');
		expect(item.json).not.toHaveProperty('error');
		expect(item.json).not.toHaveProperty('schedule');
		expect(item.json).not.toHaveProperty('input');
		expect(Object.keys(item.json).sort()).toEqual([
			'created_at',
			'id',
			'status',
			'updated_at',
			'url',
		]);
		scope.done();
	});

	it('maps a 404 to the not-found explanation', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/jobs/nope')
			.reply(404, { error: { code: 'not_found', message: 'Job not found.' } });

		const context = createExecuteContext({ parameters: { jobId: 'nope' } });
		const error = await rejectionOf(getJob.call(asExecute(context), 0));

		expect(error.message).toBe('Gluecrawl has no record with that ID');
		expect(error.description).toContain('While retrieving the job.');
		scope.done();
	});

	it('emits an error item when continue on fail is set', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/jobs/nope')
			.reply(404, { error: { code: 'not_found', message: 'Job not found.' } });

		const context = createExecuteContext({
			parameters: { jobId: 'nope' },
			continueOnFail: true,
		});
		const items = await getJob.call(asExecute(context), 0);

		// `error` + `errorDescription` is the one error-item shape every resource
		// emits, so a Switch node wired to the error branch needs one expression.
		expect(items).toEqual([
			{
				json: {
					error: 'Gluecrawl has no record with that ID',
					errorDescription: expect.stringContaining('same account'),
				},
				pairedItem: { item: 0 },
			},
		]);
		scope.done();
	});
});

describe('Job: Get Many', () => {
	useNock();

	it('asks for exactly the limit when Return All is off', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/jobs')
			.query({ limit: '2', offset: '0' })
			.reply(200, { data: [job('a'), job('b')], total: 40, limit: 2, offset: 0 });

		const context = createExecuteContext({ parameters: { returnAll: false, limit: 2 } });
		const items = await getManyJobs.call(asExecute(context), 0);

		expect(items).toHaveLength(2);
		expect(items[0].json).toMatchObject({ id: 'a' });
		expect(items[1].pairedItem).toEqual({ item: 0 });
		scope.done();
	});

	it('pages a limit above the endpoint ceiling instead of sending it', async () => {
		const page = (start: number, count: number) =>
			Array.from({ length: count }, (_, i) => job(`job-${start + i}`));
		const scope = nock(BASE_URL);
		scope
			.get('/v1/jobs')
			.query({ limit: '100', offset: '0' })
			.reply(200, { data: page(0, 100), total: 300 });
		scope
			.get('/v1/jobs')
			.query({ limit: '100', offset: '100' })
			.reply(200, { data: page(100, 100), total: 300 });

		const context = createExecuteContext({ parameters: { returnAll: false, limit: 120 } });
		const items = await getManyJobs.call(asExecute(context), 0);

		// A limit of 120 would be a 422 if it were sent verbatim.
		expect(context.calls.every((call) => call.query.limit === '100')).toBe(true);
		expect(items).toHaveLength(120);
		scope.done();
	});

	it('walks every page when Return All is on', async () => {
		const scope = nock(BASE_URL);
		scope
			.get('/v1/jobs')
			.query({ limit: '100', offset: '0' })
			.reply(200, { data: Array.from({ length: 100 }, (_, i) => job(`job-${i}`)), total: 101 });
		scope
			.get('/v1/jobs')
			.query({ limit: '100', offset: '100' })
			.reply(200, { data: [job('job-100')], total: 101 });

		const context = createExecuteContext({ parameters: { returnAll: true } });
		const items = await getManyJobs.call(asExecute(context), 0);

		expect(items).toHaveLength(101);
		scope.done();
	});

	it('emits nothing on an empty account', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/jobs')
			.query(true)
			.reply(200, { data: [], total: 0, limit: 100, offset: 0 });

		const context = createExecuteContext({ parameters: { returnAll: true } });
		await expect(getManyJobs.call(asExecute(context), 0)).resolves.toEqual([]);

		scope.done();
	});

	it('emits an error item when continue on fail is set', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/jobs')
			.query(true)
			.reply(401, { error: { code: 'invalid_api_key', message: 'Invalid API key.' } });

		const context = createExecuteContext({
			parameters: { returnAll: true },
			continueOnFail: true,
		});
		const items = await getManyJobs.call(asExecute(context), 0);

		expect(items[0].json.error).toBe('Gluecrawl rejected the API key');
		scope.done();
	});
});

describe('Job: Delete', () => {
	useNock();

	it('confirms the deletion the 204 gave no body for', async () => {
		const scope = nock(BASE_URL).delete('/v1/jobs/job-1').reply(204);

		const context = createExecuteContext({ parameters: { jobId: 'job-1' } });
		const items = await deleteJob.call(asExecute(context), 0);

		// `deleted` is the key the n8n UX guidelines mandate for a delete, and the
		// one a downstream node branches on.
		expect(items).toEqual([{ json: { deleted: true, id: 'job-1' }, pairedItem: { item: 0 } }]);
		scope.done();
	});

	it('reports a job that was already gone', async () => {
		const scope = nock(BASE_URL)
			.delete('/v1/jobs/job-1')
			.reply(404, { error: { code: 'not_found', message: 'Job not found.' } });

		const context = createExecuteContext({ parameters: { jobId: 'job-1' } });
		const error = await rejectionOf(deleteJob.call(asExecute(context), 0));

		expect(error.description).toContain('While deleting the job.');
		scope.done();
	});
});
