/**
 * Run: Get — `GET /v1/runs/{runId}`.
 *
 * Emits the run record verbatim, including the `billing` sub-object once the run
 * has settled, so a workflow can gate on `billing.credits_settled` without a
 * second call. Reads are not rate limited, which makes this the operation to
 * poll with when Run: Start ran without waiting.
 */

import type { IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';

import { gluecrawlApiRequest } from '../../transport';
import { toGluecrawlApiError } from '../../transport/errors';
import type { Run } from '../../types';
import { errorItem, toJson } from './shared';

const showFor = { resource: ['run'], operation: ['get'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Run ID',
		name: 'runId',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. 4d2b9a10-73e6-49c1-8f5a-0b1c2d3e4f50',
		description:
			'ID of the run to retrieve. Run: Start returns the run record it created, and the Gluecrawl Trigger emits one on every run event.',
		displayOptions: { show: showFor },
	},
];

export async function execute(
	this: IExecuteFunctions,
	index: number,
): Promise<INodeExecutionData[]> {
	const runId = (this.getNodeParameter('runId', index) as string).trim();

	try {
		const run = (await gluecrawlApiRequest.call(
			this,
			'GET',
			`/v1/runs/${runId}`,
			undefined,
			undefined,
			{ context: `While fetching run ${runId}`, itemIndex: index },
		)) as Run;

		return [{ json: toJson(run), pairedItem: { item: index } }];
	} catch (error) {
		// Idempotent: the transport already mapped anything it threw, so this only
		// wraps failures that escaped it.
		const apiError = toGluecrawlApiError(this.getNode(), error, { itemIndex: index });
		if (!this.continueOnFail()) throw apiError;
		return [errorItem(apiError, index)];
	}
}
