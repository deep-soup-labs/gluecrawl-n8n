/**
 * The Job resource.
 *
 * Router note: the operation VALUE for delete is `delete`, but the module is
 * exported as `deleteJob` because `delete` is a reserved word. Every other
 * operation value matches its export name exactly.
 */

import type { INodeProperties } from 'n8n-workflow';

import * as create from './create.operation';
import * as deleteJob from './deleteJob.operation';
import * as get from './get.operation';
import * as getMany from './getMany.operation';
import * as removeSchedule from './removeSchedule.operation';
import * as setSchedule from './setSchedule.operation';
import { jobOperations } from './job.description';

export { create, deleteJob, get, getMany, removeSchedule, setSchedule, jobOperations };
export { JOB_RESOURCE } from './shared';

/**
 * Every Job property, in panel order: the operation selector first, then each
 * operation's own fields, already scoped by `displayOptions` so only the selected
 * operation's fields are visible.
 */
export const jobDescription: INodeProperties[] = [
	jobOperations,
	...create.description,
	...deleteJob.description,
	...get.description,
	...getMany.description,
	...removeSchedule.description,
	...setSchedule.description,
];
