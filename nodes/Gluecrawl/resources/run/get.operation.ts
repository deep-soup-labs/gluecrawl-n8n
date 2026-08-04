/**
 * Run: Get — `GET /v1/runs/{runId}`.
 *
 * Emits the run record verbatim, including the `billing` sub-object once the run
 * has settled, so a workflow can gate on `billing.credits_settled` without a
 * second call. Reads are not rate limited, which makes this the operation to
 * poll with when Run: Start ran without waiting.
 */

import type { IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';

import { toGluecrawlApiError } from '../../transport/errors';
import type { Run } from '../../types';
import { jobScopeLocator, runLocator } from '../locators';
import { fetchRunInJob } from '../runScope';
import { simplifyProperty, simplifyRun } from '../shared';
import { errorItem, toJson } from './shared';

const showFor = { resource: ['run'], operation: ['get'] };

export const description: INodeProperties[] = [
	{ ...jobScopeLocator(), displayOptions: { show: showFor } },
	{
		...runLocator(
			'The run to retrieve. Run: Start returns the run record it created, and the Gluecrawl Trigger emits one on every run event.',
		),
		displayOptions: { show: showFor },
	},
	simplifyProperty({ show: showFor }),
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

	try {
		// Free scope check: this operation needs the run record anyway, and the
		// response carries `job_id`.
		const run: Run = await fetchRunInJob.call(
			this,
			runId,
			jobId,
			index,
			`While fetching run ${runId}`,
		);

		const simplify = this.getNodeParameter('simplify', index, false) as boolean;

		return [{ json: simplify ? simplifyRun(run) : toJson(run), pairedItem: { item: index } }];
	} catch (error) {
		// Idempotent: the transport already mapped anything it threw, so this only
		// wraps failures that escaped it.
		const apiError = toGluecrawlApiError(this.getNode(), error, { itemIndex: index });
		if (!this.continueOnFail()) throw apiError;
		return [errorItem(apiError, index)];
	}
}
