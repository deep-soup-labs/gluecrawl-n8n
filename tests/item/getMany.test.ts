/**
 * Item: Get Many — `GET /v1/runs/{run_id}/items`.
 *
 * The behaviours worth pinning down are the output shape (Simplify decides
 * whether provenance survives) and the paging loop, which has to walk 500-row
 * pages without spinning on a run that produced nothing.
 */

import type { IExecuteFunctions } from 'n8n-workflow';
import nock from 'nock';

import { execute } from '../../nodes/Gluecrawl/resources/item/getMany.operation';
import { MAX_PAGE_SIZE_ITEMS } from '../../nodes/Gluecrawl/types';
import { BASE_URL, createExecuteContext, useNock } from '../helpers';

const RUN_ID = '8f14e45f-ceea-467a-9c1b-2a6b3f2b7c10';

function row(index: number) {
	return {
		data: { title: `Item ${index}`, price: index },
		page_number: Math.floor(index / 10) + 1,
		item_index: index,
	};
}

/** `count` rows starting at `offset`, as the items envelope returns them. */
function page(offset: number, count: number, total: number) {
	return {
		items: Array.from({ length: count }, (_, i) => row(offset + i)),
		total,
		limit: MAX_PAGE_SIZE_ITEMS,
		offset,
	};
}

describe('item: getMany', () => {
	useNock();

	it('emits the row itself when Simplify is on', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items`)
			.query({ limit: MAX_PAGE_SIZE_ITEMS, offset: 0 })
			.reply(200, page(0, 2, 2));

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, returnAll: true, simplify: true },
		});

		const result = await execute.call(ctx as unknown as IExecuteFunctions, 0);

		expect(result).toHaveLength(2);
		// The row IS the item: downstream nodes map columns without a Set node.
		expect(result[0].json).toEqual({ title: 'Item 0', price: 0 });
		expect(result[0].json).not.toHaveProperty('data');
		expect(result[0].json).not.toHaveProperty('page_number');
		expect(result[0].pairedItem).toEqual({ item: 0 });
	});

	it('keeps page and index provenance when Simplify is off', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items`)
			.query({ limit: MAX_PAGE_SIZE_ITEMS, offset: 0 })
			.reply(200, page(0, 1, 1));

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, returnAll: true, simplify: false },
		});

		const result = await execute.call(ctx as unknown as IExecuteFunctions, 0);

		expect(result[0].json).toEqual({
			data: { title: 'Item 0', price: 0 },
			page_number: 1,
			item_index: 0,
		});
	});

	it('trims whitespace around the run ID before building the path', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items`)
			.query({ limit: MAX_PAGE_SIZE_ITEMS, offset: 0 })
			.reply(200, page(0, 1, 1));

		const ctx = createExecuteContext({
			parameters: { runId: `  ${RUN_ID}  `, returnAll: true, simplify: true },
		});

		await execute.call(ctx as unknown as IExecuteFunctions, 0);

		expect(ctx.calls[0].path).toBe(`/v1/runs/${RUN_ID}/items`);
	});

	it('pages through 500-row pages until a short page ends it', async () => {
		const total = 1100;
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items`)
			.query({ limit: 500, offset: 0 })
			.reply(200, page(0, 500, total))
			.get(`/v1/runs/${RUN_ID}/items`)
			.query({ limit: 500, offset: 500 })
			.reply(200, page(500, 500, total))
			.get(`/v1/runs/${RUN_ID}/items`)
			.query({ limit: 500, offset: 1000 })
			.reply(200, page(1000, 100, total));

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, returnAll: true, simplify: true },
		});

		const result = await execute.call(ctx as unknown as IExecuteFunctions, 0);

		expect(result).toHaveLength(total);
		expect(result[0].json).toEqual({ title: 'Item 0', price: 0 });
		expect(result[total - 1].json).toEqual({ title: 'Item 1099', price: 1099 });
		expect(ctx.calls.map((call) => call.query.offset)).toEqual(['0', '500', '1000']);
	});

	it('stops once `total` is satisfied even when the last page is full', async () => {
		// A page that is exactly the page size and exactly exhausts `total` must
		// not trigger a fourth request against an offset the server would 200 with
		// an empty body.
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items`)
			.query({ limit: 500, offset: 0 })
			.reply(200, page(0, 500, 1000))
			.get(`/v1/runs/${RUN_ID}/items`)
			.query({ limit: 500, offset: 500 })
			.reply(200, page(500, 500, 1000));

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, returnAll: true, simplify: true },
		});

		const result = await execute.call(ctx as unknown as IExecuteFunctions, 0);

		expect(result).toHaveLength(1000);
		expect(ctx.calls).toHaveLength(2);
	});

	it('emits zero items for an empty run without throwing', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items`)
			.query({ limit: MAX_PAGE_SIZE_ITEMS, offset: 0 })
			.reply(200, { items: [], total: 0, limit: MAX_PAGE_SIZE_ITEMS, offset: 0 });

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, returnAll: true, simplify: true },
		});

		const result = await execute.call(ctx as unknown as IExecuteFunctions, 0);

		// Zero rows is the answer that flips a job to "stale" — a legitimate
		// outcome, not an error.
		expect(result).toEqual([]);
		expect(ctx.calls).toHaveLength(1);
	});

	it('requests the user Limit as the page size and truncates to it', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items`)
			.query({ limit: 3, offset: 0 })
			.reply(200, page(0, 3, 50));

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, returnAll: false, limit: 3, simplify: true },
		});

		const result = await execute.call(ctx as unknown as IExecuteFunctions, 0);

		expect(result).toHaveLength(3);
		expect(ctx.calls).toHaveLength(1);
	});

	it('clamps a Limit above the 500-row ceiling and spans several requests', async () => {
		// The user's Limit is independent of the endpoint ceiling, so a capped read
		// still paginates rather than sending limit=600 and getting a 422.
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items`)
			.query({ limit: 500, offset: 0 })
			.reply(200, page(0, 500, 900))
			.get(`/v1/runs/${RUN_ID}/items`)
			.query({ limit: 500, offset: 500 })
			.reply(200, page(500, 400, 900));

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, returnAll: false, limit: 600, simplify: true },
		});

		const result = await execute.call(ctx as unknown as IExecuteFunctions, 0);

		expect(result).toHaveLength(600);
		expect(ctx.calls.map((call) => call.query.limit)).toEqual(['500', '500']);
	});

	it('tolerates a row whose data key is missing when simplifying', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items`)
			.query({ limit: MAX_PAGE_SIZE_ITEMS, offset: 0 })
			.reply(200, { items: [{ page_number: 1, item_index: 0 }], total: 1 });

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, returnAll: true, simplify: true },
		});

		const result = await execute.call(ctx as unknown as IExecuteFunctions, 0);

		expect(result[0].json).toEqual({});
	});

	it('maps a 404 into an actionable NodeApiError', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items`)
			.query(true)
			.reply(404, { error: { code: 'not_found', message: 'Run not found.' } });

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, returnAll: true, simplify: true },
		});

		await expect(execute.call(ctx as unknown as IExecuteFunctions, 0)).rejects.toMatchObject({
			message: 'Gluecrawl has no record with that ID',
			description: expect.stringContaining(`While reading items for run ${RUN_ID}`),
		});
	});

	it('returns the failure as an item when Continue On Fail is set', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}/items`)
			.query(true)
			.reply(403, { error: { code: 'plan_required', message: 'Requires a Starter plan.' } });

		const ctx = createExecuteContext({
			parameters: { runId: RUN_ID, returnAll: true, simplify: true },
			continueOnFail: true,
		});

		const result = await execute.call(ctx as unknown as IExecuteFunctions, 0);

		expect(result).toHaveLength(1);
		expect(result[0].json.error).toBe('The Gluecrawl account is on a plan without API access');
		// The actionable half has to survive continue-on-fail, in the same
		// `errorDescription` key every other resource uses.
		expect(String(result[0].json.errorDescription)).toContain('Requires a Starter plan.');
		expect(result[0].json.run_id).toBe(RUN_ID);
		expect(result[0].pairedItem).toEqual({ item: 0 });
	});
});
