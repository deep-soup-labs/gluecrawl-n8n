/**
 * Run: Download CSV — `GET /v1/runs/{run_id}/items/csv`.
 *
 * This is the one operation whose response must NOT be parsed as JSON: the
 * bytes have to survive intact into a binary property, and the file name has to
 * carry the run id so a workflow exporting several runs does not overwrite
 * itself.
 */

import type { IExecuteFunctions } from 'n8n-workflow';
import nock from 'nock';

import { execute } from '../../nodes/Gluecrawl/resources/run/downloadCsv.operation';
import { BASE_URL, createExecuteContext, useNock } from '../helpers';

const RUN_ID = '8f14e45f-ceea-467a-9c1b-2a6b3f2b7c10';
const CSV = 'title,price\nWidget,9.99\nGadget,19.99\n';

describe('run: downloadCsv', () => {
	useNock();

	it('attaches the CSV as binary data with the run id in the file name', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items/csv`)
			.reply(200, Buffer.from(CSV, 'utf8'), { 'content-type': 'text/csv' });

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, binaryPropertyName: 'data' },
		});

		const result = await execute.call(ctx as unknown as IExecuteFunctions, 0);

		expect(result).toHaveLength(1);
		const binary = result[0].binary?.data;
		expect(binary).toBeDefined();
		expect(binary?.mimeType).toBe('text/csv');
		expect(binary?.fileName).toBe(`gluecrawl-run-${RUN_ID}.csv`);
		// Round-trips byte for byte: the transport must not have parsed it.
		expect(Buffer.from(binary?.data ?? '', 'base64').toString('utf8')).toBe(CSV);
		expect(result[0].pairedItem).toEqual({ item: 0 });
	});

	it('summarises the export in the json half of the item', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items/csv`)
			.reply(200, Buffer.from(CSV, 'utf8'), { 'content-type': 'text/csv' });

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, binaryPropertyName: 'data' },
		});

		const result = await execute.call(ctx as unknown as IExecuteFunctions, 0);

		expect(result[0].json).toEqual({
			run_id: RUN_ID,
			file_name: `gluecrawl-run-${RUN_ID}.csv`,
			mime_type: 'text/csv',
			file_size: Buffer.byteLength(CSV, 'utf8'),
		});
	});

	it('writes to the binary field the user named', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items/csv`)
			.reply(200, Buffer.from(CSV, 'utf8'), { 'content-type': 'text/csv' });

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, binaryPropertyName: 'export' },
		});

		const result = await execute.call(ctx as unknown as IExecuteFunctions, 0);

		expect(Object.keys(result[0].binary ?? {})).toEqual(['export']);
	});

	it('falls back to "data" when the field name is blank', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items/csv`)
			.reply(200, Buffer.from(CSV, 'utf8'), { 'content-type': 'text/csv' });

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, binaryPropertyName: '   ' },
		});

		const result = await execute.call(ctx as unknown as IExecuteFunctions, 0);

		expect(Object.keys(result[0].binary ?? {})).toEqual(['data']);
	});

	it('exports an empty CSV without throwing', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items/csv`)
			.reply(200, Buffer.alloc(0), { 'content-type': 'text/csv' });

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, binaryPropertyName: 'data' },
		});

		const result = await execute.call(ctx as unknown as IExecuteFunctions, 0);

		expect(result[0].json.file_size).toBe(0);
		expect(result[0].binary?.data.data).toBe('');
	});

	it('does not send an Accept: application/json header for the binary path', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items/csv`)
			.matchHeader('accept', '*/*')
			.reply(200, Buffer.from(CSV, 'utf8'), { 'content-type': 'text/csv' });

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, binaryPropertyName: 'data' },
		});

		await expect(execute.call(ctx as unknown as IExecuteFunctions, 0)).resolves.toHaveLength(1);
	});

	it('maps a 404 into an actionable NodeApiError', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items/csv`)
			.reply(404, { error: { code: 'not_found', message: 'Run not found.' } });

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, binaryPropertyName: 'data' },
		});

		await expect(execute.call(ctx as unknown as IExecuteFunctions, 0)).rejects.toMatchObject({
			message: 'Gluecrawl has no record with that ID',
			description: expect.stringContaining(`While exporting items for run ${RUN_ID} as CSV`),
		});
	});

	it('returns the failure as an item when Continue On Fail is set', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items/csv`)
			.reply(500, '<html><body>Internal Server Error</body></html>', {
				'content-type': 'text/html',
			});

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, binaryPropertyName: 'data' },
			continueOnFail: true,
		});

		const result = await execute.call(ctx as unknown as IExecuteFunctions, 0);

		expect(result[0].json.run_id).toBe(RUN_ID);
		expect(result[0].json.error).toBe('Gluecrawl returned 500');
		expect(String(result[0].json.errorDescription)).toContain('retrying');
		expect(result[0].binary).toBeUndefined();
	});
});
