/**
 * Job: Create — `POST /v1/jobs`, optionally waiting out the whole pipeline.
 *
 * Creating a job is the expensive path. It charges the fixed job-creation cost
 * upfront and runs three LLM agents over the site to produce the scraper config,
 * which routinely takes tens of seconds. The job then persists on the account
 * until deleted, so a workflow that creates a job per execution accumulates both
 * jobs and charges. Scraping the same site again should go through Run: Start on
 * the existing job, which skips the mapper entirely.
 *
 * The wait is three stages against one shared budget: map the site, find the run
 * the API created alongside the job, then wait for that run to finish. Timing out
 * cancels nothing — `/v1` has no cancel endpoint — which is why every expiry goes
 * through `waitTimeoutError`.
 *
 * It defaults to OFF, and that is deliberate. The poll runs in-process, so it holds
 * the n8n execution — and on Cloud one of the account's concurrency slots — for the
 * mapper plus the whole first scrape. Defaulting it on put the longest, most
 * expensive path on the branch a user gets without touching anything, and the way
 * it failed there was the worst one available: a timeout that reads like an abort
 * but leaves the run executing and billable. n8n persists only parameters the user
 * edited, so this default IS the behaviour for every workflow that never opened the
 * toggle. `tests/node/waitDefaults.test.ts` pins it.
 */

import {
	NodeApiError,
	NodeOperationError,
	updateDisplayOptions,
	type IDataObject,
	type IExecuteFunctions,
	type INode,
	type INodeExecutionData,
	type INodeProperties,
	type JsonObject,
} from 'n8n-workflow';

import { gluecrawlApiRequest } from '../../transport';
import { markGluecrawlError } from '../../transport/errors';
import { gluecrawlApiRequestAllItems, gluecrawlApiRequestPage } from '../../transport/pagination';
import {
	pollUntil,
	waitForJobMapped,
	waitForRunTerminal,
	waitTimeoutError,
} from '../../transport/poll';
import {
	DEAD_JOB_STATUSES,
	MAX_MAX_PAGES,
	MIN_MAX_PAGES,
	type ColumnSpec,
	type ColumnType,
	type CreateJobBody,
	type Item,
	type Job,
	type JobInput,
	type Run,
} from '../../types';
import { itemRowJson } from '../shared';
import { asNodeError, jobErrorOutput, jobOperationDisplay } from './shared';

/**
 * The API creates the first run inside the same transaction as the job, so it is
 * there on the first look in practice. This interval only covers replica lag.
 */
const RUN_DISCOVERY_INTERVAL_MS = 2_000;

const properties: INodeProperties[] = [
	{
		displayName: 'URL',
		name: 'url',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. https://example.com/products?category=shoes',
		description:
			'Page to scrape. Point it at the listing that actually shows the records you want, not the homepage. Keep the query string intact — filters, sort order and pagination parameters are part of what gets scraped.',
	},
	{
		displayName: 'Input Mode',
		name: 'inputMode',
		type: 'options',
		noDataExpression: true,
		default: 'goal',
		options: [
			{
				name: 'Columns',
				value: 'columns',
				description: 'Name the exact columns to extract and let Gluecrawl find them',
			},
			{
				name: 'Goal',
				value: 'goal',
				description: 'Describe the outcome in plain English and let Gluecrawl choose the columns',
			},
		],
		description:
			'How to tell Gluecrawl what to extract. The API accepts exactly one of the two, so switching mode replaces the other input.',
	},
	{
		displayName: 'Goal',
		name: 'goal',
		type: 'string',
		typeOptions: { rows: 3 },
		required: true,
		default: '',
		placeholder: 'e.g. Extract the name, price and product URL of every product',
		displayOptions: { show: { inputMode: ['goal'] } },
		description:
			'What to extract, in plain English. Naming the fields you expect ("name, price, product URL") produces steadier column names than a vague goal.',
	},
	{
		displayName: 'Columns',
		name: 'columns',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true, sortable: true },
		default: {},
		placeholder: 'Add Column',
		displayOptions: { show: { inputMode: ['columns'] } },
		description: 'Exact columns to extract. At least one is required.',
		options: [
			{
				name: 'column',
				displayName: 'Column',
				values: [
					{
						displayName: 'Name',
						name: 'name',
						type: 'string',
						required: true,
						default: '',
						placeholder: 'e.g. price',
						description: 'Column name, used as the field name on every extracted row',
					},
					{
						displayName: 'Type',
						name: 'type',
						type: 'options',
						default: 'text',
						options: [
							{ name: 'Array', value: 'array' },
							{ name: 'Date', value: 'date' },
							{ name: 'Number', value: 'number' },
							{ name: 'Text', value: 'text' },
							{ name: 'URL', value: 'url' },
						],
						description:
							'How the extracted value is interpreted. This is a hint to the mapper, not a guarantee about the value that comes back.',
					},
				],
			},
		],
	},
	{
		displayName: 'Max Pages',
		name: 'maxPages',
		type: 'number',
		typeOptions: { minValue: MIN_MAX_PAGES, maxValue: MAX_MAX_PAGES },
		default: 2,
		description:
			'How many listing pages to scrape. This is the main cost multiplier on a run, so start small and raise it once the columns look right.',
	},
	{
		displayName: 'Wait for Completion',
		name: 'waitForCompletion',
		type: 'boolean',
		default: false,
		description:
			'Whether to hold the workflow until the site has been mapped and the first run has finished. Off by default: mapping runs three LLM agents and the first scrape follows it, so this routinely blocks for minutes, and the whole time it occupies an n8n execution slot. Leave it off to get the job back immediately and collect the rows with the Gluecrawl Trigger on "run.completed" or a later Run: Get. Turn it on only for short interactive scrapes.',
	},
	{
		displayName: 'Output Scraped Rows',
		name: 'outputItems',
		type: 'boolean',
		default: true,
		displayOptions: { show: { waitForCompletion: [true] } },
		description:
			'Whether to output one n8n item per scraped row, carrying the extracted fields plus page_number and item_index. Turn this off to output the job with the finished run nested under "run" instead. A run that found nothing falls back to that same job-plus-run item, so the branch is never empty.',
	},
	{
		displayName: 'Timeout (Seconds)',
		name: 'timeout',
		type: 'number',
		typeOptions: { minValue: 10 },
		default: 300,
		displayOptions: { show: { waitForCompletion: [true] } },
		description:
			'Total budget for mapping plus the first run. On expiry this node fails but nothing is cancelled: Gluecrawl has no cancel endpoint, so the run keeps going and is still charged. The error names the run ID so it can be collected afterwards.',
	},
];

export const description: INodeProperties[] = updateDisplayOptions(
	jobOperationDisplay('create'),
	properties,
);

/** Builds the tagged union the API expects, failing loudly on an empty input. */
function buildJobInput(context: IExecuteFunctions, index: number): JobInput {
	const inputMode = context.getNodeParameter('inputMode', index) as string;

	if (inputMode === 'columns') {
		const entries = context.getNodeParameter('columns.column', index, []) as Array<{
			name?: string;
			type?: ColumnType;
		}>;

		const value: ColumnSpec[] = entries
			.map((entry) => ({ name: (entry.name ?? '').trim(), type: entry.type ?? 'text' }))
			.filter((column) => column.name !== '');

		if (value.length === 0) {
			throw new NodeOperationError(
				context.getNode(),
				'Columns mode needs at least one named column',
				{
					description:
						'Add a column and give it a name, or switch Input Mode to Goal and describe what to extract in plain English.',
					itemIndex: index,
				},
			);
		}

		return { type: 'columns', value };
	}

	const goal = (context.getNodeParameter('goal', index, '') as string).trim();

	if (goal === '') {
		throw new NodeOperationError(context.getNode(), 'Goal is empty', {
			description:
				'Describe what to extract, for example "the name, price and product URL of every product on the page".',
			itemIndex: index,
		});
	}

	return { type: 'goal', value: goal };
}

/** `failed` and `stale` are dead ends: the job can never be made to work. */
function mappingFailedError(node: INode, job: Job, index: number): NodeApiError {
	const stale = job.status === 'stale';
	const cause = job.error ? `${job.error} ` : '';
	const hint = stale
		? ' A "stale" job usually means the URL was a detail or landing page rather than a listing, or the records sit behind a filter the crawl never applied.'
		: '';

	const errorResponse: JsonObject = {
		message: job.error ?? 'Gluecrawl could not produce a scraper config for this site.',
		job_id: job.id,
		status: job.status ?? 'unknown',
	};

	return markGluecrawlError(
		new NodeApiError(node, errorResponse, {
			message: stale
				? 'Gluecrawl mapped the site but the scrape found no rows'
				: 'Gluecrawl could not map this site',
			description: `${cause}Job ${job.id} is now "${job.status}", which is terminal — re-running it will never succeed. Create a NEW job with a different URL, goal or columns instead.${hint}`,
			itemIndex: index,
		}),
	);
}

function runFailedError(node: INode, run: Run, index: number): NodeApiError {
	const cause = run.error ? `${run.error} ` : '';

	const errorResponse: JsonObject = {
		message: run.error ?? 'The run failed.',
		run_id: run.id,
		job_id: run.job_id,
		status: run.status,
	};

	return markGluecrawlError(
		new NodeApiError(node, errorResponse, {
			message: 'The Gluecrawl run failed',
			description: `${cause}Run ${run.id} finished with status "failed". A transient cause (a site timeout, a blocked request) clears on a retry with Run: Start — the job itself is still usable. Repeated failures usually mean the site changed and the job needs re-creating.`,
			itemIndex: index,
		}),
	);
}

/**
 * Returns the run the API created alongside the job. The list is newest-first
 * and a fresh job has exactly one run, so the first row is the right one.
 */
async function findFirstRun(
	this: IExecuteFunctions,
	jobId: string,
	timeoutMs: number,
	index: number,
): Promise<Run> {
	const node = this.getNode();

	const runs = await pollUntil<Run[]>(
		async () =>
			(await gluecrawlApiRequestPage.call(this, 'GET', `/v1/jobs/${jobId}/runs`, {
				envelopeKey: 'data',
				limit: 1,
				context: 'While looking up the run created with the job',
				itemIndex: index,
			})) as Run[],
		(rows) => rows.length > 0,
		{
			intervalMs: RUN_DISCOVERY_INTERVAL_MS,
			timeoutMs,
			onTimeout: () => {
				throw waitTimeoutError(node, { timeoutMs, jobId, itemIndex: index });
			},
		},
	);

	return runs[0];
}

export async function execute(
	this: IExecuteFunctions,
	index: number,
): Promise<INodeExecutionData[]> {
	try {
		const body: CreateJobBody = {
			url: this.getNodeParameter('url', index) as string,
			input: buildJobInput(this, index),
			max_pages: this.getNodeParameter('maxPages', index) as number,
		};

		const job = (await gluecrawlApiRequest.call(this, 'POST', '/v1/jobs', body, undefined, {
			context: 'While creating the Gluecrawl job',
			itemIndex: index,
		})) as Job;

		if (!(this.getNodeParameter('waitForCompletion', index) as boolean)) {
			return [{ json: job as unknown as IDataObject, pairedItem: { item: index } }];
		}

		// One budget across all three stages, so a slow mapper eats into the run
		// wait rather than silently doubling the timeout the user configured.
		const timeoutMs = (this.getNodeParameter('timeout', index) as number) * 1000;
		const deadline = Date.now() + timeoutMs;
		const remaining = (): number => Math.max(deadline - Date.now(), 0);

		const mappedJob = await waitForJobMapped.call(this, job.id, {
			timeoutMs: remaining(),
			itemIndex: index,
		});

		if (mappedJob.status !== undefined && DEAD_JOB_STATUSES.includes(mappedJob.status)) {
			throw mappingFailedError(this.getNode(), mappedJob, index);
		}

		const run = await findFirstRun.call(this, job.id, remaining(), index);
		const finishedRun = await waitForRunTerminal.call(this, run.id, {
			timeoutMs: remaining(),
			itemIndex: index,
		});

		if (finishedRun.status === 'failed') {
			throw runFailedError(this.getNode(), finishedRun, index);
		}

		if (!(this.getNodeParameter('outputItems', index) as boolean)) {
			return [
				{
					json: { ...mappedJob, run: finishedRun } as unknown as IDataObject,
					pairedItem: { item: index },
				},
			];
		}

		const rows = (await gluecrawlApiRequestAllItems.call(
			this,
			'GET',
			`/v1/runs/${finishedRun.id}/items`,
			{
				envelopeKey: 'items',
				context: 'While reading the scraped rows',
				itemIndex: index,
			},
		)) as Item[];

		// A completed run with nothing in it still has to emit something, or the
		// branch dead-ends and the job id, the run id and the fact that the (already
		// charged) scrape happened are all lost. Same fallback Run: Start makes, so
		// the two operations stay interchangeable on the case that loses the most.
		if (rows.length === 0) {
			return [
				{
					json: { ...mappedJob, run: finishedRun } as unknown as IDataObject,
					pairedItem: { item: index },
				},
			];
		}

		// Same row shape as Run: Start, provenance keys last. See `itemRowJson`.
		return rows.map((row) => ({
			json: itemRowJson(row, finishedRun.id),
			pairedItem: { item: index },
		}));
	} catch (error) {
		if (!this.continueOnFail()) throw asNodeError(this.getNode(), error, index);
		return jobErrorOutput(error, index);
	}
}
