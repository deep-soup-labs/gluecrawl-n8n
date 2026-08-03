/**
 * Pieces every Job operation needs.
 *
 * Kept deliberately small: display scoping (which is mechanical and repeated
 * once per operation file) and the "Continue On Fail" output shape, which has to
 * be identical across operations or downstream error handling has to special-case
 * each one.
 */

import {
	NodeApiError,
	NodeOperationError,
	type IDisplayOptions,
	type INode,
	type INodeExecutionData,
} from 'n8n-workflow';

import { errorOutputItem } from '../shared';

export const JOB_RESOURCE = 'job';

/** `displayOptions` scoping a property to a single Job operation. */
export function jobOperationDisplay(operation: string): IDisplayOptions {
	return { show: { resource: [JOB_RESOURCE], operation: [operation] } };
}

/**
 * Guarantees that whatever leaves an operation is a node error.
 *
 * Transport failures arrive already mapped and validation failures are raised as
 * `NodeOperationError`, so in practice this only wraps a genuine bug in this
 * package — but a raw `TypeError` reaching the n8n UI carries no node context at
 * all, and community-node lint rightly forbids re-throwing one untouched.
 */
export function asNodeError(
	node: INode,
	error: unknown,
	index: number,
): NodeApiError | NodeOperationError {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;

	return new NodeOperationError(node, error instanceof Error ? error : String(error), {
		itemIndex: index,
	});
}

/**
 * The "Continue On Fail" output, as a single-item list because that is what a
 * Job operation's execute signature returns.
 */
export function jobErrorOutput(error: unknown, index: number): INodeExecutionData[] {
	return [errorOutputItem(error, index)];
}
