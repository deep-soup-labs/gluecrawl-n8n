/**
 * Helpers every resource needs, hoisted out of the per-resource `shared.ts`
 * files so the two things a workflow can branch on stay identical everywhere.
 *
 * A user who turns "Continue On Fail" on and wires a Switch node to the error
 * output has to be able to write one expression, not one per resource.
 */

import type { IDataObject, INodeExecutionData } from 'n8n-workflow';

import type { Item } from '../types';

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
