/**
 * Run: Get Many — `GET /v1/jobs/{jobId}/runs`.
 *
 * The run history of one job, one n8n item per run. Both branches go through
 * `gluecrawlApiRequestAllItems`: the endpoint caps `limit` at 100 and answers a
 * larger value with a 422, so a "Limit" above 100 has to be paged rather than
 * passed straight through.
 */

import type { IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';

import { toGluecrawlApiError } from '../../transport/errors';
import { gluecrawlApiRequestAllItems } from '../../transport/pagination';
import type { Run } from '../../types';
import { errorItem, toJson } from './shared';

const showFor = { resource: ['run'], operation: ['getMany'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Job ID',
		name: 'jobId',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. 8f1c0d2e-5a44-4b7e-9a1f-2c3d4e5f6a7b',
		description: 'ID of the job whose runs to list',
		displayOptions: { show: showFor },
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: { show: showFor },
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 1 },
		description: 'Max number of results to return',
		displayOptions: { show: { ...showFor, returnAll: [false] } },
	},
];

export async function execute(
	this: IExecuteFunctions,
	index: number,
): Promise<INodeExecutionData[]> {
	const jobId = (this.getNodeParameter('jobId', index) as string).trim();
	const returnAll = this.getNodeParameter('returnAll', index) as boolean;

	try {
		const maxResults = returnAll ? undefined : (this.getNodeParameter('limit', index) as number);

		const runs = (await gluecrawlApiRequestAllItems.call(this, 'GET', `/v1/jobs/${jobId}/runs`, {
			envelopeKey: 'data',
			...(maxResults !== undefined ? { maxResults, pageSize: maxResults } : {}),
			context: `While listing the runs of job ${jobId}`,
			itemIndex: index,
		})) as Run[];

		return runs.map((run) => ({ json: toJson(run), pairedItem: { item: index } }));
	} catch (error) {
		// Idempotent: the transport already mapped anything it threw, so this only
		// wraps failures that escaped it.
		const apiError = toGluecrawlApiError(this.getNode(), error, { itemIndex: index });
		if (!this.continueOnFail()) throw apiError;
		return [errorItem(apiError, index)];
	}
}
