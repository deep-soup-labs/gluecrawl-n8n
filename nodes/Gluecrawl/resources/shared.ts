/**
 * Helpers every resource needs, hoisted out of the per-resource `shared.ts`
 * files so the two things a workflow can branch on stay identical everywhere.
 *
 * A user who turns "Continue On Fail" on and wires a Switch node to the error
 * output has to be able to write one expression, not one per resource.
 */

import type { IDataObject, INodeExecutionData, INodeProperties } from 'n8n-workflow';

import type { Item, Job, Run } from '../types';

/**
 * The `Simplify` toggle, worded exactly as the n8n UX guidelines specify.
 *
 * They ask for it on any response carrying ten or more fields: `Job` has 11 and
 * `Run` has 12. `Run: Get Items` builds its own instead, because there the
 * choice is about the row wrapper rather than about field count.
 *
 * Default off. Both single-record reads promise, in their own operation
 * descriptions, fields that simplification drops — the billing breakdown on a
 * run, the resolved column schema on a job — and a workflow fetching one record
 * usually wants the record. Opting in is cheap; silently losing `billing` is not.
 */
export function simplifyProperty(
	displayOptions: INodeProperties['displayOptions'],
): INodeProperties {
	return {
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: false,
		displayOptions,
		description: 'Whether to return a simplified version of the response instead of the raw data',
	};
}

/**
 * Simplified `Job`: the ten fields worth reading, with the nested ones flattened
 * as the guidelines require.
 *
 * `input` collapses to whichever half of the union is present, and `columns` to
 * the column NAMES — the part a downstream expression addresses. Dropped:
 * `protection_level` and `schedule`, neither of which a workflow branches on.
 *
 * Absent keys stay absent. `/v1` omits null-valued fields rather than sending
 * null, and re-introducing them here as `undefined` would break the
 * tolerate-a-missing-key contract the raw shape already teaches.
 */
export function simplifyJob(job: Job): IDataObject {
	const input = job.input;

	return {
		id: job.id,
		url: job.url,
		...(job.status !== undefined ? { status: job.status } : {}),
		...(input?.type === 'goal' ? { goal: input.value } : {}),
		...(input?.type === 'columns'
			? { requested_columns: input.value.map((column) => column.name) }
			: {}),
		...(job.columns
			? {
					listing_columns: job.columns.listing.map((column) => column.name),
					detail_columns: job.columns.detail.map((column) => column.name),
				}
			: {}),
		...(job.max_pages !== undefined ? { max_pages: job.max_pages } : {}),
		...(job.error !== undefined ? { error: job.error } : {}),
		created_at: job.created_at,
		updated_at: job.updated_at,
	};
}

/**
 * Simplified `Run`: ten fields, with `billing` flattened to the single number a
 * workflow actually gates on. The rest of the breakdown (listing pages, detail
 * items, protection level) is what Simplify off is for.
 */
export function simplifyRun(run: Run): IDataObject {
	return {
		id: run.id,
		job_id: run.job_id,
		status: run.status,
		...(run.item_count !== undefined ? { item_count: run.item_count } : {}),
		...(run.page_count !== undefined ? { page_count: run.page_count } : {}),
		...(run.credits_used !== undefined ? { credits_used: run.credits_used } : {}),
		...(run.billing?.credits_settled !== undefined
			? { credits_settled: run.billing.credits_settled }
			: {}),
		...(run.error !== undefined ? { error: run.error } : {}),
		created_at: run.created_at,
		...(run.completed_at !== undefined ? { completed_at: run.completed_at } : {}),
	};
}

/**
 * The `json` of one scraped row, for the two operations that emit rows
 * directly (Job: Create and Run: Start).
 *
 * Both must produce the same keys: a workflow that starts on create-and-wait
 * and later switches to rerunning an existing job would otherwise lose
 * `run_id` and see `page_number` change meaning, with nothing to warn it.
 *
 * The provenance keys are written last and therefore win a name clash with a
 * scraped column. That is the deliberate trade: a downstream node branching on
 * `page_number` or correlating on `run_id` has to be able to trust them, and a
 * job whose columns are literally named `run_id` or `item_index` is far rarer
 * than one that reads the provenance. Run: Get Items with Simplify on is the
 * escape hatch for the raw, un-merged row.
 */
export function itemRowJson(row: Item, runId: string): IDataObject {
	return {
		...row.data,
		run_id: runId,
		page_number: row.page_number,
		item_index: row.item_index,
	};
}

/**
 * The item emitted for an input item that failed while "Continue On Fail" is on.
 *
 * Two invariants, both learned the hard way:
 *
 * - The keys are always `error` and `errorDescription`, on every resource.
 * - `description` is where a `NodeApiError` keeps the actionable half of the
 *   explanation (which plan to upgrade to, whether a retry can help, whether
 *   the job is dead). Dropping it reduces a carefully mapped error to a bare
 *   one-liner exactly when the user chose to keep going and inspect it later.
 *
 * `extra` carries resource-specific context that helps correlate the failure
 * back to its input, e.g. the run id on the CSV export.
 */
export function errorOutputItem(
	error: unknown,
	index: number,
	extra: IDataObject = {},
): INodeExecutionData {
	const message = error instanceof Error ? error.message : String(error);
	const description = (error as { description?: unknown } | null)?.description;

	return {
		json: {
			...extra,
			error: message,
			...(typeof description === 'string' && description ? { errorDescription: description } : {}),
		},
		pairedItem: { item: index },
	};
}
