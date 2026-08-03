/**
 * Small helpers shared by the Run operations.
 *
 * Kept local to the resource on purpose: if a second resource needs the same
 * two functions, hoist them to a package-level helpers module rather than
 * importing across resource folders.
 */

import type { IDataObject, INodeExecutionData, NodeApiError } from 'n8n-workflow';

import { errorOutputItem } from '../shared';

/**
 * Casts a wire record to `IDataObject` for `INodeExecutionData.json`.
 *
 * The `/v1` types are plain JSON, but the interfaces in `types.ts` carry no
 * index signature, so structural assignment to `IDataObject` fails. This is the
 * one place that cast lives, rather than sprinkling it through the operations.
 */
export function toJson(value: unknown): IDataObject {
	return value as IDataObject;
}

/**
 * The "Continue On Fail" output item. Shape is shared across every resource.
 *
 * `extra` is the run-scoped context the row-reading operations add (`run_id`),
 * so a failure can be correlated back to its run without re-reading the input.
 */
export function errorItem(
	error: NodeApiError,
	index: number,
	extra: IDataObject = {},
): INodeExecutionData {
	return errorOutputItem(error, index, extra);
}
