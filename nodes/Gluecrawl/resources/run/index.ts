/**
 * The Run resource: start a scrape on an already-mapped job, read back runs,
 * and read back what a run extracted.
 *
 * The rows live here rather than under a resource of their own because `/v1`
 * has no item entity to address: every row endpoint is keyed on a run
 * (`/v1/runs/{id}/items`), rows have no id, and nothing can be done with one
 * except read it. Splitting them out made the user pick the Run twice — once
 * to start it and once to read it — under two different resources.
 *
 * `description` is the full property list for the resource — the operation
 * selector followed by every operation's own fields, each already scoped by
 * `displayOptions` — so the node class only has to splice it in. The operation
 * namespaces are re-exported for the router, which dispatches on the selector
 * value: `run[operation].execute.call(this, itemIndex)`.
 */

import type { INodeProperties } from 'n8n-workflow';

import * as downloadCsv from './downloadCsv.operation';
import * as get from './get.operation';
import * as getItems from './getItems.operation';
import * as getMany from './getMany.operation';
import * as start from './start.operation';

export { downloadCsv, get, getItems, getMany, start };

/** Operation values this resource accepts, for the router's dispatch table. */
export type RunOperation = 'downloadCsv' | 'get' | 'getItems' | 'getMany' | 'start';

const operationSelector: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	default: 'start',
	displayOptions: { show: { resource: ['run'] } },
	// Alphabetical by name: `node-param-options-type-unsorted-items` is an error
	// in the ruleset the verification scan applies.
	options: [
		{
			name: 'Download CSV',
			value: 'downloadCsv',
			action: 'Download run items as CSV',
			description: "Export a run's rows as a CSV file attached to the output item",
		},
		{
			name: 'Get',
			value: 'get',
			action: 'Get a run',
			description: 'Retrieve a single run, including its billing breakdown once it has settled',
		},
		{
			name: 'Get Items',
			value: 'getItems',
			action: 'Get run items',
			description: 'Retrieve the rows a run extracted, one n8n item per row',
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
	...getItems.description,
	...downloadCsv.description,
];
