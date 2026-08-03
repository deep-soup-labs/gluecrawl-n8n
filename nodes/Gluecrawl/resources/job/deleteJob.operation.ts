/**
 * Job: Delete — `DELETE /v1/jobs/{job_id}`.
 *
 * Exported as `deleteJob` rather than `delete`, which is a reserved word; the
 * operation value in the UI is still `delete`.
 *
 * The API answers 204 with no body, so there is nothing to pass through and the
 * operation synthesises a confirmation item instead.
 */

import {
	updateDisplayOptions,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeProperties,
} from 'n8n-workflow';

import { gluecrawlApiRequest } from '../../transport';
import { jobLocator } from '../locators';
import { asNodeError, jobErrorOutput, jobOperationDisplay } from './shared';

const properties: INodeProperties[] = [
	jobLocator(
		'The job to delete. This also removes its runs, their extracted rows and any schedule attached to it, and cannot be undone.',
	),
];

export const description: INodeProperties[] = updateDisplayOptions(
	jobOperationDisplay('delete'),
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

		await gluecrawlApiRequest.call(this, 'DELETE', `/v1/jobs/${jobId}`, undefined, undefined, {
			context: 'While deleting the job',
			itemIndex: index,
		});

		return [{ json: { success: true, id: jobId }, pairedItem: { item: index } }];
	} catch (error) {
		if (!this.continueOnFail()) throw asNodeError(this.getNode(), error, index);
		return jobErrorOutput(error, index);
	}
}
