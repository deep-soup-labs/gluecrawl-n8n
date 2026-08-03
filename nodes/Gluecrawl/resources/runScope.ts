/**
 * The Job/Run consistency check for the three run-scoped operations.
 *
 * Why this exists, verified against n8n 2.32.7 rather than assumed:
 *
 * The Run picker is scoped by the sibling Job field. When the user changes the
 * Job, n8n re-fetches the run LIST for the new job but does **not** clear the
 * already-selected run — it stays in the field, pinned to the top of the
 * refreshed list as the current selection. `loadOptionsDependsOn: ['jobId']`
 * does not change this; it was tried and neither cleared the value nor altered
 * the refresh, so it was removed rather than left as a false promise.
 *
 * `/v1` keys these three endpoints on the run id alone, so a stale run would be
 * fetched perfectly happily and the workflow would return a real run belonging
 * to a different job than the panel displays. That is the one failure mode worth
 * paying a request to avoid: it is silent, and the output looks correct.
 *
 * Run: Get pays nothing — it needs the run record anyway, and `GET /v1/runs/{id}`
 * carries `job_id`. The two Item operations pay one extra unmetered read (`/v1`
 * does not rate limit GETs) to turn a plausible wrong answer into a clear error.
 */

import { NodeApiError, type IExecuteFunctions } from 'n8n-workflow';

import { gluecrawlApiRequest } from '../transport';
import { markGluecrawlError } from '../transport/errors';
import type { Run } from '../types';

/**
 * Raised when the chosen run belongs to a job other than the chosen one.
 *
 * A marked `NodeApiError` rather than a `NodeOperationError`, for the same
 * reason `waitTimeoutError` is: every operation funnels its failures through
 * `toGluecrawlApiError`, whose pass-through is deliberately narrow — only a
 * MARKED `NodeApiError` survives. A `NodeOperationError` would be re-wrapped
 * and this copy flattened into "Gluecrawl request failed", which is precisely
 * the message that would leave the user with no idea the two fields disagree.
 */
function mismatch(
	context: IExecuteFunctions,
	run: Run,
	jobId: string,
	index: number,
): NodeApiError {
	const message = `The selected run belongs to job ${run.job_id}, not to the selected job ${jobId}`;

	return markGluecrawlError(
		new NodeApiError(
			context.getNode(),
			{ message, run_id: run.id, job_id: run.job_id },
			{
				message,
				description:
					'Changing the Job does not clear a run already chosen in the Run field, so the two can drift apart. Re-pick the run from the list, or set the Job to the one this run belongs to.',
				itemIndex: index,
			},
		),
	);
}

/** Whether a fetched run contradicts the selected job. */
function contradicts(run: Run, jobId: string): boolean {
	return Boolean(jobId) && Boolean(run.job_id) && run.job_id !== jobId;
}

/**
 * Fetches the run, rejecting one that belongs to a different job.
 *
 * For the caller that needs the run record anyway (Run: Get), so the check is
 * free. A blank `jobId` is not a mismatch: the field is required, n8n blocks an
 * empty one before execution, and failing here on an empty string would replace
 * a clear "required parameter" message with a confusing one.
 */
export async function fetchRunInJob(
	this: IExecuteFunctions,
	runId: string,
	jobId: string,
	index: number,
	context: string,
): Promise<Run> {
	const run = (await gluecrawlApiRequest.call(
		this,
		'GET',
		`/v1/runs/${runId}`,
		undefined,
		undefined,
		{ context, itemIndex: index },
	)) as Run;

	if (contradicts(run, jobId)) throw mismatch(this, run, jobId, index);

	return run;
}

/**
 * The same check for a caller that does NOT otherwise need the run record
 * (the two Item operations), which is why it costs an extra read.
 *
 * With no job selected there is nothing to compare the run against, so the
 * request is skipped entirely rather than spent proving nothing. That also
 * keeps a run id supplied on its own — through an expression, or by a workflow
 * built before the Job field existed — exactly as cheap as it used to be.
 */
export async function assertRunInJob(
	this: IExecuteFunctions,
	runId: string,
	jobId: string,
	index: number,
	context: string,
): Promise<void> {
	if (!jobId) return;

	await fetchRunInJob.call(this, runId, jobId, index, context);
}
