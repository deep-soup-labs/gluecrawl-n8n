/**
 * Run: Get Items — `GET /v1/runs/{run_id}/items`.
 *
 * The rows a scrape produced. Keys inside `data` are job-specific, so the
 * default output shape is the row itself: that is what lets Google Sheets,
 * Airtable and the Loop nodes map fields without a Set node in between.
 * Turning Simplify off keeps the page/index provenance alongside the row.
 */

import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { toGluecrawlApiError } from '../../transport/errors';
import { gluecrawlApiRequestAllItems } from '../../transport/pagination';
import { MAX_PAGE_SIZE_ITEMS, type Item } from '../../types';
import { jobScopeLocator, runLocator } from '../locators';
import { assertRunInJob } from '../runScope';
import { errorItem } from './shared';

const showFor = { resource: ['run'], operation: ['getItems'] };

export const description: INodeProperties[] = [
	{ ...jobScopeLocator(), displayOptions: { show: showFor } },
	{
		...runLocator(
			'The run to read rows from. Returned by Job: Create and Run: Start, and by the Gluecrawl Trigger on a run event. Rows appear progressively while a run is still scraping, so a run that has not completed yet returns the pages extracted so far.',
		),
		displayOptions: { show: showFor },
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: true,
		displayOptions: { show: showFor },
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 1 },
		displayOptions: { show: { ...showFor, returnAll: [false] } },
		description: 'Max number of results to return',
	},
	{
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: true,
		displayOptions: { show: showFor },
		description:
			"Whether each output item should be the extracted row itself, with the job's columns as top-level fields. Turn this off to wrap the row as {data, page_number, item_index} and keep the page it came from and its position on that page.",
	},
];

export async function execute(
	this: IExecuteFunctions,
	index: number,
): Promise<INodeExecutionData[]> {
	const runId = (
		this.getNodeParameter('runId', index, '', { extractValue: true }) as string
	).trim();
	const jobId = (
		this.getNodeParameter('jobId', index, '', { extractValue: true }) as string
	).trim();
	const returnAll = this.getNodeParameter('returnAll', index, true) as boolean;
	const simplify = this.getNodeParameter('simplify', index, true) as boolean;

	try {
		// One extra unmetered read so a run left over from a previously selected
		// job fails loudly instead of returning another job's rows.
		await assertRunInJob.call(this, runId, jobId, index, `While reading items for run ${runId}`);

		// A capped read still paginates: the user's Limit is independent of the
		// endpoint's 500-row page ceiling, so it may span several requests.
		const limit = returnAll ? undefined : (this.getNodeParameter('limit', index, 50) as number);

		const rows = (await gluecrawlApiRequestAllItems.call(this, 'GET', `/v1/runs/${runId}/items`, {
			envelopeKey: 'items',
			pageSize: limit ?? MAX_PAGE_SIZE_ITEMS,
			...(limit !== undefined ? { maxResults: limit } : {}),
			context: `While reading items for run ${runId}`,
			itemIndex: index,
		})) as Item[];

		// Zero rows is a legitimate answer, not a failure: it means the run
		// extracted nothing, which is also what flips the job to "stale".
		return rows.map((row) => ({
			json: simplify ? (row?.data ?? {}) : (row as unknown as IDataObject),
			pairedItem: { item: index },
		}));
	} catch (error) {
		// Mapped first either way: the description is the actionable half, and the
		// continue-on-fail item has to carry it too.
		const apiError = toGluecrawlApiError(this.getNode(), error, {
			itemIndex: index,
			context: `While reading items for run ${runId}`,
		});
		if (!this.continueOnFail()) throw apiError;
		return [errorItem(apiError, index, { run_id: runId })];
	}
}
