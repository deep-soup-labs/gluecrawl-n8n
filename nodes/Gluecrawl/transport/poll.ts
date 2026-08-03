/**
 * Bounded polling for the wait-for-completion paths.
 *
 * The important part is what happens on timeout. `/v1` has no cancel endpoint,
 * so giving up on the wait does NOT stop the run and does NOT stop the charge —
 * the work keeps going on Gluecrawl's side and settles against the account.
 * Every timeout error therefore has to say so and hand back the run id, or
 * users assume the node aborted something.
 */

import { NodeApiError, sleep, type INode } from 'n8n-workflow';

import { TERMINAL_RUN_STATUSES, type Job, type Run, type RunStatus } from '../types';
import { markGluecrawlError } from './errors';
import { gluecrawlApiRequest, type GluecrawlRequestContext } from './index';

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_POLL_TIMEOUT_MS = 300_000;
/** Floor on the interval so a misconfigured node cannot hammer the API. */
export const MIN_POLL_INTERVAL_MS = 1_000;

/**
 * Promise-based sleep, re-exported from `n8n-workflow`.
 *
 * Deliberately not hand-rolled on `setTimeout`: the community-node lint rules
 * that gate n8n Cloud verification ban the timer globals outright and only
 * whitelist a short list of imports, `node:timers/promises` not among them.
 * `n8n-workflow` is a peer dependency, so this costs nothing at runtime.
 */
export { sleep };

export interface PollUntilOptions<T> {
	/** Delay between attempts. Floored at `MIN_POLL_INTERVAL_MS`. */
	intervalMs?: number;
	/** Total budget across all attempts. */
	timeoutMs?: number;
	/**
	 * Called when the budget is exhausted, with the last value seen (undefined
	 * if the first fetch had not returned yet). Must throw.
	 */
	onTimeout: (lastValue: T | undefined) => never;
}

/**
 * Calls `fetch` until `isDone` accepts the result or the budget runs out.
 *
 * Always makes at least one attempt, so a zero timeout still performs a single
 * check rather than failing without touching the API.
 */
export async function pollUntil<T>(
	fetch: () => Promise<T>,
	isDone: (value: T) => boolean,
	options: PollUntilOptions<T>,
): Promise<T> {
	const intervalMs = Math.max(options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS);
	const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;

	let lastValue: T | undefined;

	for (;;) {
		lastValue = await fetch();
		if (isDone(lastValue)) return lastValue;

		// Skip a sleep we already know outlasts the budget.
		if (Date.now() + intervalMs >= deadline) options.onTimeout(lastValue);

		await sleep(intervalMs);
	}
}

export interface WaitTimeoutParams {
	timeoutMs: number;
	runId?: string;
	jobId?: string;
	/** Status observed on the final poll, for the error description. */
	lastStatus?: string;
	itemIndex?: number;
}

/**
 * The timeout error for every wait path. Says plainly that nothing was
 * cancelled and the work is still billable, and names the id to pick up later.
 */
export function waitTimeoutError(node: INode, params: WaitTimeoutParams): NodeApiError {
	const seconds = Math.round(params.timeoutMs / 1000);
	const subject = params.runId ? `run ${params.runId}` : `job ${params.jobId ?? 'unknown'}`;
	const lastStatus = params.lastStatus ? ` Last observed status: "${params.lastStatus}".` : '';
	const pickup = params.runId
		? `Retrieve it later with the Run: Get or Item: Get Many operation using run ID ${params.runId}`
		: `Retrieve it later with the Job: Get operation using job ID ${params.jobId ?? 'unknown'}`;

	// Marked so an operation that funnels its failures through
	// `toGluecrawlApiError` cannot flatten this copy into a generic HTTP message.
	return markGluecrawlError(
		new NodeApiError(
			node,
			{
				message: `Timed out after ${seconds}s waiting for Gluecrawl ${subject}`,
				...(params.runId ? { run_id: params.runId } : {}),
				...(params.jobId ? { job_id: params.jobId } : {}),
			},
			{
				message: `Timed out after ${seconds}s waiting for Gluecrawl ${subject} to finish`,
				description: `This node stopped waiting; it did NOT cancel anything. The Gluecrawl API has no cancel endpoint, so the ${subject} is still executing and its credits will still be charged.${lastStatus} ${pickup}, or use the Gluecrawl Trigger on "run.completed" instead of waiting inline. Raising the timeout also helps for slow sites or high Max Pages.`,
				...(params.itemIndex !== undefined ? { itemIndex: params.itemIndex } : {}),
			},
		),
	);
}

export interface WaitOptions {
	intervalMs?: number;
	timeoutMs?: number;
	itemIndex?: number;
}

/** True for a status a run will never move out of. Unknown statuses count as running. */
export function isRunTerminal(status: string | undefined): boolean {
	return TERMINAL_RUN_STATUSES.includes(status as RunStatus);
}

/**
 * Polls `GET /v1/runs/{id}` until the run is `completed` or `failed`.
 *
 * Returns the failed run rather than throwing — whether a failure is an error
 * for the workflow depends on the operation's "continue on fail" setting, which
 * is the caller's business.
 */
export async function waitForRunTerminal(
	this: GluecrawlRequestContext,
	runId: string,
	options: WaitOptions = {},
): Promise<Run> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
	const node = this.getNode();

	return await pollUntil<Run>(
		async () =>
			(await gluecrawlApiRequest.call(this, 'GET', `/v1/runs/${runId}`, undefined, undefined, {
				context: 'While waiting for the run to finish',
			})) as Run,
		(run) => isRunTerminal(run?.status),
		{
			...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
			timeoutMs,
			onTimeout: (run) => {
				throw waitTimeoutError(node, {
					timeoutMs,
					runId,
					...(run?.status ? { lastStatus: run.status } : {}),
					...(options.itemIndex !== undefined ? { itemIndex: options.itemIndex } : {}),
				});
			},
		},
	);
}

/**
 * Polls `GET /v1/jobs/{id}` until the mapper settles on `ready`, `failed` or
 * `stale`. Returns the job in all three cases; `failed` and `stale` are dead
 * ends that need a new job, not a retry.
 */
export async function waitForJobMapped(
	this: GluecrawlRequestContext,
	jobId: string,
	options: WaitOptions = {},
): Promise<Job> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
	const node = this.getNode();

	return await pollUntil<Job>(
		async () =>
			(await gluecrawlApiRequest.call(this, 'GET', `/v1/jobs/${jobId}`, undefined, undefined, {
				context: 'While waiting for the job to be mapped',
			})) as Job,
		(job) => job?.status !== undefined && job.status !== 'in_progress',
		{
			...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
			timeoutMs,
			onTimeout: (job) => {
				throw waitTimeoutError(node, {
					timeoutMs,
					jobId,
					...(job?.status ? { lastStatus: job.status } : {}),
					...(options.itemIndex !== undefined ? { itemIndex: options.itemIndex } : {}),
				});
			},
		},
	);
}
