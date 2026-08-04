/**
 * The Gluecrawl action node.
 *
 * Programmatic style: this file owns only the node description and the router.
 * Every operation lives in `resources/<resource>/<operation>.operation.ts` and
 * exports the same pair — `description` (its properties, already scoped by
 * `displayOptions`) and `execute(index)`. Adding an operation means adding a
 * module and one line in the dispatch table below; nothing else in this file
 * knows what the operations do.
 *
 * Each operation returns the items for ONE input item and sets `pairedItem`
 * itself, including when it fans a single input into many extracted rows. The
 * router only flattens.
 */

import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

import { searchJobs, searchRuns } from './methods';
import * as job from './resources/job';
import * as run from './resources/run';
import { errorOutputItem } from './resources/shared';
import { rethrowIfCancelled } from './transport/cancellation';

/** The signature every `*.operation.ts` module's `execute` conforms to. */
type OperationExecute = (this: IExecuteFunctions, index: number) => Promise<INodeExecutionData[]>;

/**
 * resource -> operation value -> handler.
 *
 * The keys are the option VALUES from each resource's selector, which is why
 * Job's delete entry is `delete` while the module it points at is `deleteJob`
 * (`delete` cannot be an export name).
 */
const OPERATIONS: Record<string, Record<string, OperationExecute>> = {
	job: {
		create: job.create.execute,
		delete: job.deleteJob.execute,
		get: job.get.execute,
		getMany: job.getMany.execute,
	},
	run: {
		downloadCsv: run.downloadCsv.execute,
		get: run.get.execute,
		getItems: run.getItems.execute,
		getMany: run.getMany.execute,
		start: run.start.execute,
	},
};

export class Gluecrawl implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Gluecrawl',
		name: 'gluecrawl',
		icon: {
			light: 'file:gluecrawl.light.svg',
			dark: 'file:gluecrawl.dark.svg',
		},
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Scrape websites with Gluecrawl and get structured rows back',
		documentationUrl: 'https://www.gluecrawl.ai/docs/api',
		defaults: {
			name: 'Gluecrawl',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'gluecrawlApi',
				required: true,
			},
		],
		// n8n runs a node once per input item, so the two billed operations fan
		// out silently: ten rows arriving from an upstream Gluecrawl read start
		// ten runs against the same job. That is standard n8n semantics and must
		// not be "fixed" by collapsing items — a jobId driven by an expression is
		// a legitimate fan-out — but it costs money and blows through the 10/min
		// run-start limit mid-execution, which loses the runs already started.
		// The hints make the count visible before the click, and name the setting
		// that stops it. Same shape as the Google Sheets per-item hints.
		hints: [
			{
				type: 'warning',
				message:
					'This node starts <strong>one run per input item</strong>, and every run is billed. Turn on <em>Execute Once</em> in this node&apos;s settings to start a single run, or reduce the items reaching it. Run starts are also rate limited to 10 per minute.',
				displayCondition:
					'={{ $parameter["resource"] === "run" && $parameter["operation"] === "start" && $input.all().length > 1 }}',
				whenToDisplay: 'always',
				location: 'inputPane',
			},
			{
				type: 'warning',
				message:
					'This node creates <strong>one job per input item</strong>, and each one is charged upfront and stays on the account until deleted. Turn on <em>Execute Once</em> in this node&apos;s settings to create a single job, or reduce the items reaching it.',
				displayCondition:
					'={{ $parameter["resource"] === "job" && $parameter["operation"] === "create" && $input.all().length > 1 }}',
				whenToDisplay: 'always',
				location: 'inputPane',
			},
		],
		// The agent-facing copy is deliberately different from the human-facing
		// one above. An agent cannot see the pricing note in the operation
		// descriptions until after it has picked an operation, and by then the
		// job is already created and charged, so the warning has to be here.
		usableAsTool: {
			replacements: {
				description:
					'Scrape a website and get structured rows back. Job: Create is the expensive path — it charges the job-creation cost upfront, runs an LLM over the site to work out how to scrape it, and mints a job that stays on the account until deleted, so calling it in a loop accumulates both jobs and charges. Before creating a job, check Job: Get Many for an existing job on the same URL and re-scrape it with Run: Start, which reuses the cached config and skips the mapping cost. Keep Max Pages small (1 or 2) and raise it only if the rows come back incomplete. Run: Get Items reads the rows of a finished run and costs nothing. The run-scoped operations take both a Job and a Run: every Gluecrawl output carrying a run ID carries its job ID beside it, so read both from the same record rather than looking one up.',
			},
		},
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'job',
				options: [
					{
						name: 'Job',
						value: 'job',
						description: 'A saved URL plus what to extract from it, and its schedule',
					},
					{
						name: 'Run',
						value: 'run',
						description: 'One execution of a job against the site, and the rows it extracted',
					},
				],
			},
			...job.jobDescription,
			...run.description,
		],
	};

	/**
	 * Edit-time methods backing the Job and Run pickers. Not part of the router:
	 * these never run during an execution.
	 */
	methods = {
		listSearch: {
			searchJobs,
			searchRuns,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		// Both selectors are `noDataExpression`, so they cannot vary per item.
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		const handler = OPERATIONS[resource]?.[operation];
		if (handler === undefined) {
			// Not a data problem, so `continueOnFail` does not apply: no input item
			// would make this combination valid.
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operation}" is not supported on the "${resource}" resource`,
				{
					description:
						'Re-select the Resource and Operation on this node. If it was pasted from a workflow built against a newer version of the Gluecrawl node, update the package.',
				},
			);
		}

		const returnData: INodeExecutionData[] = [];

		for (let index = 0; index < items.length; index++) {
			try {
				returnData.push(...(await handler.call(this, index)));
			} catch (error) {
				// Cancellation is not a data problem, so `continueOnFail` must not
				// swallow it: the execution is being torn down and the remaining input
				// items must not be processed. Checked here as well as inside the
				// operations because this net also covers throws from outside their
				// try blocks.
				rethrowIfCancelled(error);

				// Safety net. Operations handle `continueOnFail` themselves, but a
				// throw from outside their own try block (a failing parameter
				// expression, say) would otherwise abort the whole execution despite
				// the setting being on.
				if (!this.continueOnFail()) {
					// Re-wrapping an already-mapped error would flatten its
					// `description`, which is the half that says what to do next.
					throw error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeOperationError(this.getNode(), error as Error, { itemIndex: index });
				}

				// Built by the same helper every operation uses, so the fallback item
				// carries the package-wide `{error, errorDescription}` keys. This branch
				// is genuinely reachable — several operations read their first parameter
				// outside their own try block — and a Switch node keyed on
				// `errorDescription` would silently read undefined otherwise.
				returnData.push(errorOutputItem(error, index));
			}
		}

		return [returnData];
	}
}
