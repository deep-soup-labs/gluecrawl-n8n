/**
 * Job: Get Many — `GET /v1/jobs`, newest first.
 *
 * Both branches go through the pagination helper: the endpoint caps `limit` at
 * 100 and rejects anything larger outright rather than clamping, so a Limit above
 * 100 has to be assembled from several pages instead of being passed straight
 * through.
 */

import {
	updateDisplayOptions,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeProperties,
} from 'n8n-workflow';

import { gluecrawlApiRequestAllItems } from '../../transport/pagination';
import type { Job } from '../../types';
import { asNodeError, jobErrorOutput, jobOperationDisplay } from './shared';

const properties: INodeProperties[] = [
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		displayOptions: { show: { returnAll: [false] } },
		description: 'Max number of results to return',
	},
];

export const description: INodeProperties[] = updateDisplayOptions(
	jobOperationDisplay('getMany'),
	properties,
);

export async function execute(
	this: IExecuteFunctions,
	index: number,
): Promise<INodeExecutionData[]> {
	try {
		const returnAll = this.getNodeParameter('returnAll', index) as boolean;
		const limit = returnAll ? undefined : (this.getNodeParameter('limit', index) as number);

		const jobs = (await gluecrawlApiRequestAllItems.call(this, 'GET', '/v1/jobs', {
			envelopeKey: 'data',
			// Asking for exactly the Limit keeps a small request small; the helper
			// clamps it back to the endpoint ceiling when the Limit is larger.
			...(limit !== undefined ? { maxResults: limit, pageSize: limit } : {}),
			context: 'While listing jobs',
			itemIndex: index,
		})) as Job[];

		return jobs.map((job) => ({
			json: job as unknown as IDataObject,
			pairedItem: { item: index },
		}));
	} catch (error) {
		if (!this.continueOnFail()) throw asNodeError(this.getNode(), error, index);
		return jobErrorOutput(error, index);
	}
}
