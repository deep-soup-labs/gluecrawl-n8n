/**
 * Job: Get — `GET /v1/jobs/{job_id}`.
 *
 * The response is passed through untouched, which means the optional fields are
 * genuinely ABSENT rather than null when they have no value: `columns` only
 * appears once the mapper has produced a config (status "ready"), and `error`,
 * `schedule` and `input` are dropped when unset. Downstream expressions must
 * tolerate a missing key, not test for null.
 */

import {
	updateDisplayOptions,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeProperties,
} from 'n8n-workflow';

import { gluecrawlApiRequest } from '../../transport';
import type { Job } from '../../types';
import { jobLocator } from '../locators';
import { asNodeError, jobErrorOutput, jobOperationDisplay } from './shared';

const properties: INodeProperties[] = [
	jobLocator(
		'The job to retrieve. Jobs are scoped to the account the API key belongs to; an ID from another account reads as not found.',
	),
];

export const description: INodeProperties[] = updateDisplayOptions(
	jobOperationDisplay('get'),
	properties,
);

export async function execute(
	this: IExecuteFunctions,
	index: number,
): Promise<INodeExecutionData[]> {
	try {
		const jobId = (
			this.getNodeParameter('jobId', index, '', { extractValue: true }) as string
		).trim();

		const job = (await gluecrawlApiRequest.call(
			this,
			'GET',
			`/v1/jobs/${jobId}`,
			undefined,
			undefined,
			{ context: 'While retrieving the job', itemIndex: index },
		)) as Job;

		return [{ json: job as unknown as IDataObject, pairedItem: { item: index } }];
	} catch (error) {
		if (!this.continueOnFail()) throw asNodeError(this.getNode(), error, index);
		return jobErrorOutput(error, index);
	}
}
