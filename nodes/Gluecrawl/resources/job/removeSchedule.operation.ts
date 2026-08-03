/**
 * Job: Remove Schedule — `DELETE /v1/jobs/{job_id}/schedule`.
 *
 * Answers 204 with no body, so the operation synthesises a confirmation item.
 * Unlike Set Schedule this does not require the job to be `ready`, and it is
 * idempotent from the caller's point of view: a job without a schedule still
 * answers 204.
 */

import {
	updateDisplayOptions,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeProperties,
} from 'n8n-workflow';

import { gluecrawlApiRequest } from '../../transport';
import { asNodeError, jobErrorOutput, jobOperationDisplay } from './shared';

const properties: INodeProperties[] = [
	{
		displayName: 'Job ID',
		name: 'jobId',
		type: 'string',
		required: true,
		default: '',
		placeholder: '8f4a2c1e-0b7d-4a19-9c3f-6d5e2a1b8c04',
		description:
			'ID of the job whose schedule should be removed. The job and its existing runs are left untouched; only the recurring trigger goes away.',
	},
];

export const description: INodeProperties[] = updateDisplayOptions(
	jobOperationDisplay('removeSchedule'),
	properties,
);

export async function execute(
	this: IExecuteFunctions,
	index: number,
): Promise<INodeExecutionData[]> {
	try {
		const jobId = this.getNodeParameter('jobId', index) as string;

		await gluecrawlApiRequest.call(
			this,
			'DELETE',
			`/v1/jobs/${jobId}/schedule`,
			undefined,
			undefined,
			{ context: 'While removing the job schedule', itemIndex: index },
		);

		return [{ json: { success: true, id: jobId }, pairedItem: { item: index } }];
	} catch (error) {
		if (!this.continueOnFail()) throw asNodeError(this.getNode(), error, index);
		return jobErrorOutput(error, index);
	}
}
