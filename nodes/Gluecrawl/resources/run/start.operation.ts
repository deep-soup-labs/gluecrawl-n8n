/**
 * Run: Start — `POST /v1/jobs/{jobId}/runs`.
 *
 * The cheap path. The job already holds a mapper config, so no LLM work runs and
 * nothing is charged upfront; the run settles against the account after it
 * finishes. Use this, not Job: Create, whenever a job for the site already
 * exists.
 *
 * Two things shape the design here:
 *
 * 1. The endpoint is rate limited to 10 requests per minute, so the operation
 *    description says so — a loop over more than 10 job IDs needs a Wait node.
 * 2. `/v1` has no cancel endpoint. Giving up on the wait does not stop the run
 *    and does not stop the charge, which is why the timeout path goes through
 *    `waitForRunTerminal` and its shared wording instead of a local throw.
 */

import {
	NodeApiError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeProperties,
} from 'n8n-workflow';

import { gluecrawlApiRequest } from '../../transport';
import { markGluecrawlError, toGluecrawlApiError } from '../../transport/errors';
import { gluecrawlApiRequestAllItems } from '../../transport/pagination';
import { waitForRunTerminal } from '../../transport/poll';
import { MAX_MAX_PAGES, MIN_MAX_PAGES, type Item, type Run, type StartRunBody } from '../../types';
import { jobLocator } from '../locators';
import { itemRowJson } from '../shared';
import { errorItem, toJson } from './shared';

const showFor = { resource: ['run'], operation: ['start'] };

export const description: INodeProperties[] = [
	{
		...jobLocator(
			'An existing job whose status is "ready". A job that is still mapping, or that ended up failed or stale, cannot be run.',
		),
		displayOptions: { show: showFor },
	},
	{
		displayName: 'Wait for Completion',
		name: 'waitForCompletion',
		type: 'boolean',
		default: true,
		description:
			'Whether to poll the run until it finishes before continuing the workflow. Turn this off to start the run and continue immediately, then pick up the result with the Gluecrawl Trigger or a later Run: Get.',
		displayOptions: { show: showFor },
	},
	{
		displayName: 'Output Items',
		name: 'outputItems',
		type: 'boolean',
		default: true,
		description:
			'Whether to output the extracted rows, one n8n item per row, instead of the run record. Runs that finished with zero rows still output the run record so the branch is never empty.',
		displayOptions: { show: { ...showFor, waitForCompletion: [true] } },
	},
	{
		displayName: 'Timeout',
		name: 'timeout',
		type: 'number',
		default: 300,
		typeOptions: { minValue: 1 },
		description:
			'How long to wait for the run to finish, in seconds. When it elapses the node stops waiting, but the run keeps going and is still charged — Gluecrawl has no cancel endpoint.',
		displayOptions: { show: { ...showFor, waitForCompletion: [true] } },
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: { show: showFor },
		options: [
			{
				displayName: 'Max Pages',
				name: 'maxPages',
				type: 'number',
				default: 10,
				typeOptions: { minValue: MIN_MAX_PAGES, maxValue: MAX_MAX_PAGES },
				description:
					'Override the number of listing pages this run scrapes. Leave unset to use the limit stored on the job. Every extra page costs credits.',
			},
		],
	},
];

export async function execute(
	this: IExecuteFunctions,
	index: number,
): Promise<INodeExecutionData[]> {
	const jobId = (
		this.getNodeParameter('jobId', index, '', { extractValue: true }) as string
	).trim();
	const waitForCompletion = this.getNodeParameter('waitForCompletion', index) as boolean;
	const options = this.getNodeParameter('options', index, {}) as IDataObject;

	try {
		const body: StartRunBody = {};
		if (typeof options.maxPages === 'number') body.max_pages = options.maxPages;

		const started = (await gluecrawlApiRequest.call(
			this,
			'POST',
			`/v1/jobs/${jobId}/runs`,
			body,
			undefined,
			{ context: `While starting a run for job ${jobId}`, itemIndex: index },
		)) as Run;

		if (!waitForCompletion) {
			return [{ json: toJson(started), pairedItem: { item: index } }];
		}

		const timeoutMs = (this.getNodeParameter('timeout', index) as number) * 1000;
		// Throws the shared "not cancelled, still billed" error on timeout; returns
		// failed runs rather than throwing, so the check below is ours to make.
		const run = await waitForRunTerminal.call(this, started.id, { timeoutMs, itemIndex: index });

		if (run.status === 'failed') {
			// Marked, so the catch below recognises it as already carrying our copy
			// instead of re-mapping it into a generic transport failure.
			throw markGluecrawlError(
				new NodeApiError(
					this.getNode(),
					{
						message: run.error ?? 'The run failed without reporting a reason.',
						run_id: run.id,
						job_id: run.job_id,
						status: run.status,
					},
					{
						message: `Gluecrawl run ${run.id} failed`,
						description: `${run.error ?? 'The run failed without reporting a reason.'} The site may have blocked the scrape, or the selectors cached on job ${jobId} may no longer match the page. Retry the run; if it keeps failing, the page layout has changed and the job needs to be recreated.`,
						itemIndex: index,
					},
				),
			);
		}

		const outputItems = this.getNodeParameter('outputItems', index) as boolean;
		if (!outputItems) {
			return [{ json: toJson(run), pairedItem: { item: index } }];
		}

		const rows = (await gluecrawlApiRequestAllItems.call(this, 'GET', `/v1/runs/${run.id}/items`, {
			envelopeKey: 'items',
			context: `While fetching the items of run ${run.id}`,
			itemIndex: index,
		})) as Item[];

		// A completed run with nothing in it still has to emit something, or the
		// branch silently dead-ends and the run ID is lost.
		if (rows.length === 0) {
			return [{ json: toJson(run), pairedItem: { item: index } }];
		}

		// Same row shape as Job: Create — a workflow that switches from
		// create-and-wait to rerun must not have to re-map its downstream nodes.
		return rows.map((row) => ({
			json: itemRowJson(row, run.id),
			pairedItem: { item: index },
		}));
	} catch (error) {
		// Idempotent: the transport, the wait timeout and the failed-run throw above
		// all produce NodeApiErrors already, so this only wraps what escaped them.
		const apiError = toGluecrawlApiError(this.getNode(), error, { itemIndex: index });
		if (!this.continueOnFail()) throw apiError;
		return [errorItem(apiError, index)];
	}
}
