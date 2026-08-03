/**
 * Item resource — the rows a run extracted.
 *
 * `description` is the full property set for the resource: the operation
 * selector followed by each operation's own fields, already scoped by
 * `displayOptions`. The router imports `getMany`/`downloadCsv` to dispatch on
 * the selected operation.
 */

import type { INodeProperties } from 'n8n-workflow';

import * as downloadCsv from './downloadCsv.operation';
import * as getMany from './getMany.operation';

export { downloadCsv, getMany };

export const description: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'getMany',
		displayOptions: {
			show: {
				resource: ['item'],
			},
		},
		options: [
			{
				name: 'Download CSV',
				value: 'downloadCsv',
				description: "Export a run's rows as a CSV file attached to the output item",
				action: 'Download items as CSV',
			},
			{
				name: 'Get Many',
				value: 'getMany',
				description: 'Retrieve the rows a run extracted, one n8n item per row',
				action: 'Get many items',
			},
		],
	},
	...downloadCsv.description,
	...getMany.description,
];
