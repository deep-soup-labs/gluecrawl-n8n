/**
 * Item: Download CSV — `GET /v1/runs/{run_id}/items/csv`.
 *
 * The same rows Get Many returns, flattened server-side into a CSV document.
 * The response is a stream of bytes rather than JSON, so it goes through the
 * transport's binary path and is attached as a binary property instead of
 * being parsed.
 */

import type { IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';

import { toGluecrawlApiError } from '../../transport/errors';
import { gluecrawlApiRequestBinary } from '../../transport';
import { jobScopeLocator, runLocator } from '../locators';
import { assertRunInJob } from '../runScope';
import { errorOutputItem } from '../shared';

const showFor = { resource: ['item'], operation: ['downloadCsv'] };

export const description: INodeProperties[] = [
	{ ...jobScopeLocator(), displayOptions: { show: showFor } },
	{
		...runLocator(
			'The run to export. The export covers the rows extracted so far, so run it after the run has completed unless a partial export is what you want.',
		),
		displayOptions: { show: showFor },
	},
	{
		displayName: 'Put Output File in Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		placeholder: 'e.g. data',
		displayOptions: { show: showFor },
		description:
			'Name of the binary field the CSV file is written to. Downstream nodes such as Extract From File, Convert to File or an email attachment read the file from this field.',
	},
];

export async function execute(
	this: IExecuteFunctions,
	index: number,
): Promise<INodeExecutionData[]> {
	const runId = (
		this.getNodeParameter('runId', index, '', { extractValue: true }) as string
	).trim();
	const binaryPropertyName = (
		this.getNodeParameter('binaryPropertyName', index, 'data') as string
	).trim();

	const jobId = (
		this.getNodeParameter('jobId', index, '', { extractValue: true }) as string
	).trim();

	const fileName = `gluecrawl-run-${runId}.csv`;

	try {
		// One extra unmetered read so a run left over from a previously selected
		// job fails loudly instead of exporting another job's rows.
		await assertRunInJob.call(
			this,
			runId,
			jobId,
			index,
			`While exporting items for run ${runId} as CSV`,
		);

		const csv = await gluecrawlApiRequestBinary.call(
			this,
			'GET',
			`/v1/runs/${runId}/items/csv`,
			undefined,
			{
				context: `While exporting items for run ${runId} as CSV`,
				itemIndex: index,
			},
		);

		const binary = await this.helpers.prepareBinaryData(csv, fileName, 'text/csv');

		return [
			{
				json: { run_id: runId, file_name: fileName, mime_type: 'text/csv', file_size: csv.length },
				binary: { [binaryPropertyName || 'data']: binary },
				pairedItem: { item: index },
			},
		];
	} catch (error) {
		// Mapped first either way: the description is the actionable half, and the
		// continue-on-fail item has to carry it too.
		const apiError = toGluecrawlApiError(this.getNode(), error, {
			itemIndex: index,
			context: `While exporting items for run ${runId} as CSV`,
		});
		if (!this.continueOnFail()) throw apiError;
		return [errorOutputItem(apiError, index, { run_id: runId })];
	}
}
