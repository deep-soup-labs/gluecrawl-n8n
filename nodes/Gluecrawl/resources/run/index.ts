/**
 * The Run resource: start a scrape on an already-mapped job, and read back runs.
 *
 * `description` is the full property list for the resource — the operation
 * selector followed by every operation's own fields, each already scoped by
 * `displayOptions` — so the node class only has to splice it in. The operation
 * namespaces are re-exported for the router, which dispatches on the selector
 * value: `run[operation].execute.call(this, itemIndex)`.
 */

import type { INodeProperties } from 'n8n-workflow';

import * as get from './get.operation';
import * as getMany from './getMany.operation';
import * as start from './start.operation';

export { get, getMany, start };

/** Operation values this resource accepts, for the router's dispatch table. */
export type RunOperation = 'get' | 'getMany' | 'start';

const operationSelector: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	default: 'start',
	displayOptions: { show: { resource: ['run'] } },
	options: [
		{
			name: 'Get',
			value: 'get',
			action: 'Get a run',
			description: 'Retrieve a single run, including its billing breakdown once it has settled',
		},
		{
			name: 'Get Many',
			value: 'getMany',
			action: 'Get many runs',
			description: 'List the run history of a job',
		},
		{
			name: 'Start',
			value: 'start',
			action: 'Start a run',
			description:
				'Re-scrape a job that is already mapped, reusing its cached config. No mapping cost and nothing charged upfront; the run settles once it finishes. Rate limited to 10 requests per minute.',
		},
	],
};

export const description: INodeProperties[] = [
	operationSelector,
	...start.description,
	...get.description,
	...getMany.description,
];
