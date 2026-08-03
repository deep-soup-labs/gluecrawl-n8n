import type { INodeProperties } from 'n8n-workflow';

import { JOB_RESOURCE } from './shared';

/**
 * The Job operation selector.
 *
 * A job is a persistent, billable record: creating one charges the fixed
 * job-creation cost and runs the LLM mapper over the site. Reusing an existing
 * job through Run: Start is always cheaper than creating a second job for the
 * same URL and goal, which is why Create leads with that warning.
 */
export const jobOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: [JOB_RESOURCE] } },
	default: 'create',
	options: [
		{
			name: 'Create',
			value: 'create',
			description:
				'Create a job: Gluecrawl maps the site with an LLM, then scrapes it. Charges the job-creation cost upfront and mints a job that persists until deleted. To scrape the same site again, reuse the job with Run: Start instead of creating another one.',
			action: 'Create a job',
		},
		{
			name: 'Delete',
			value: 'delete',
			description: 'Delete a job along with its runs, extracted rows and schedule',
			action: 'Delete a job',
		},
		{
			name: 'Get',
			value: 'get',
			description: 'Retrieve a single job, including its mapping status and resolved columns',
			action: 'Get a job',
		},
		{
			name: 'Get Many',
			value: 'getMany',
			description: 'Retrieve the jobs on this account, newest first',
			action: 'Get many jobs',
		},
	],
};
