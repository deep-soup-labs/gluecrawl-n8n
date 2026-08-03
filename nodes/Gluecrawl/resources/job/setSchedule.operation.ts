/**
 * Job: Set Schedule — `PUT /v1/jobs/{job_id}/schedule`.
 *
 * Two preconditions are enforced by the API and worth knowing before the call:
 * the job must be `ready` (a job still being mapped, or one that failed, answers
 * 409 `job_not_ready`), and the account's plan must permit scheduling (403
 * `plan_required`).
 *
 * Three things are validated here instead of at the API, because the API turns
 * them into either an unhelpful FastAPI validation body or a parse failure:
 *
 *   - `weeks` requires exactly one weekday set and `every == 1`. Gluecrawl builds
 *     weekly schedules as an EventBridge cron expression, which cannot express
 *     "every N weeks on these days". This surfaces as a raw Pydantic validation
 *     list, not the usual error envelope.
 *   - `time` is parsed literally as "H:MM AM/PM". A 24-hour time or a missing
 *     meridiem is not rejected cleanly upstream.
 *   - `start_date` is parsed strictly as YYYY-MM-DD.
 */

import {
	NodeOperationError,
	updateDisplayOptions,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeProperties,
} from 'n8n-workflow';

import { gluecrawlApiRequest } from '../../transport';
import {
	MAX_MAX_PAGES,
	MIN_MAX_PAGES,
	type Job,
	type ScheduleConfig,
	type ScheduleIntervalType,
} from '../../types';
import { asNodeError, jobErrorOutput, jobOperationDisplay } from './shared';

/** 12-hour clock with a meridiem, which is the only shape the API parses. */
const TIME_PATTERN = /^(0?[1-9]|1[0-2]):([0-5]\d)\s*(AM|PM)$/i;

const START_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const properties: INodeProperties[] = [
	{
		displayName: 'Job ID',
		name: 'jobId',
		type: 'string',
		required: true,
		default: '',
		placeholder: '8f4a2c1e-0b7d-4a19-9c3f-6d5e2a1b8c04',
		description:
			'ID of the job to schedule. The job must already be mapped (status "ready"), and the account plan must include scheduled runs.',
	},
	{
		displayName: 'Interval',
		name: 'intervalType',
		type: 'options',
		default: 'days',
		options: [
			{ name: 'Days', value: 'days' },
			{ name: 'Hours', value: 'hours' },
			{ name: 'Minutes', value: 'minutes' },
			{ name: 'Months', value: 'months' },
			{ name: 'One-Time', value: 'one-time' },
			{ name: 'Weeks', value: 'weeks' },
		],
		description:
			'How often the job re-runs. "One-Time" fires once at Start Date and Time, then deletes itself.',
	},
	{
		displayName: 'Every',
		name: 'every',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 1,
		displayOptions: { hide: { intervalType: ['one-time'] } },
		description:
			'Number of intervals between runs, so 2 with Interval "Days" runs every other day. A weekly schedule must leave this at 1.',
	},
	{
		displayName: 'Time',
		name: 'time',
		type: 'string',
		default: '9:00 AM',
		placeholder: '9:00 AM',
		displayOptions: { hide: { intervalType: ['minutes', 'hours'] } },
		description:
			'Time of day to run, on a 12-hour clock with AM or PM, interpreted in UTC. Minute- and hour-based intervals ignore it.',
	},
	{
		displayName: 'Weekdays',
		name: 'weekdays',
		type: 'multiOptions',
		default: [],
		displayOptions: { show: { intervalType: ['weeks'] } },
		options: [
			{ name: 'Monday', value: 0 },
			{ name: 'Tuesday', value: 1 },
			{ name: 'Wednesday', value: 2 },
			{ name: 'Thursday', value: 3 },
			{ name: 'Friday', value: 4 },
			{ name: 'Saturday', value: 5 },
			{ name: 'Sunday', value: 6 },
		],
		description: 'Days of the week to run on. A weekly schedule needs at least one.',
	},
	{
		displayName: 'Day of Month',
		name: 'dayOfMonth',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 31 },
		default: 1,
		displayOptions: { show: { intervalType: ['months'] } },
		description:
			'Day of the month to run on. A day the month does not have is simply skipped that month.',
	},
	{
		displayName: 'Start Date',
		name: 'startDate',
		type: 'string',
		default: '',
		placeholder: 'YYYY-MM-DD',
		description:
			'Date the schedule becomes active, as YYYY-MM-DD. Leave empty to start immediately; for a one-time schedule an empty value means today.',
	},
	{
		displayName: 'Max Pages Override',
		name: 'maxPages',
		type: 'number',
		typeOptions: { minValue: 0, maxValue: MAX_MAX_PAGES },
		default: 0,
		description:
			"Max pages for the scheduled runs only. Leave at 0 to keep using the job's own Max Pages.",
	},
	{
		displayName: 'Enabled',
		name: 'enabled',
		type: 'boolean',
		default: true,
		description:
			'Whether the schedule is active. Turning it off does not park the configuration: the API deletes the schedule outright, exactly as the Remove Schedule operation does.',
	},
];

export const description: INodeProperties[] = updateDisplayOptions(
	jobOperationDisplay('setSchedule'),
	properties,
);

/** Normalises to "H:MM AM" so the API's literal split-on-space parse succeeds. */
function normaliseTime(context: IExecuteFunctions, raw: string, index: number): string {
	const match = TIME_PATTERN.exec(raw.trim());

	if (!match) {
		throw new NodeOperationError(context.getNode(), `"${raw}" is not a valid schedule time`, {
			description:
				'Use a 12-hour clock time with a meridiem, such as "9:00 AM" or "11:30 PM". Gluecrawl parses this string literally, so 24-hour times and values without AM or PM are not accepted.',
			itemIndex: index,
		});
	}

	return `${Number(match[1])}:${match[2]} ${match[3].toUpperCase()}`;
}

function readStartDate(context: IExecuteFunctions, index: number): string | null {
	const raw = (context.getNodeParameter('startDate', index, '') as string).trim();
	if (raw === '') return null;

	if (!START_DATE_PATTERN.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
		throw new NodeOperationError(context.getNode(), `"${raw}" is not a valid start date`, {
			description:
				'Use a calendar date in YYYY-MM-DD form, for example 2026-03-01. Gluecrawl parses this field strictly and does not accept full timestamps.',
			itemIndex: index,
		});
	}

	return raw;
}

/**
 * Mirrors the API's weekly validator so the failure is a clear node error rather
 * than a raw FastAPI validation body.
 */
function assertWeeklyIsValid(
	context: IExecuteFunctions,
	weekdays: number[],
	every: number,
	index: number,
): void {
	if (weekdays.length === 0) {
		throw new NodeOperationError(
			context.getNode(),
			'A weekly schedule needs at least one weekday',
			{
				description:
					'Select the days the job should run on, or pick a different Interval such as Days.',
				itemIndex: index,
			},
		);
	}

	if (every !== 1) {
		throw new NodeOperationError(context.getNode(), 'A weekly schedule must run every 1 week', {
			description:
				'Gluecrawl compiles weekly schedules into an EventBridge cron expression, which cannot express "every N weeks on these weekdays". Set Every to 1, or use Interval "Days" with Every set to a multiple of 7.',
			itemIndex: index,
		});
	}
}

export async function execute(
	this: IExecuteFunctions,
	index: number,
): Promise<INodeExecutionData[]> {
	try {
		const jobId = this.getNodeParameter('jobId', index) as string;
		const intervalType = this.getNodeParameter('intervalType', index) as ScheduleIntervalType;
		const every = this.getNodeParameter('every', index, 1) as number;
		const weekdays = this.getNodeParameter('weekdays', index, []) as number[];
		const maxPages = this.getNodeParameter('maxPages', index, 0) as number;

		if (intervalType === 'weeks') {
			assertWeeklyIsValid(this, weekdays, every, index);
		}

		const body: ScheduleConfig = {
			enabled: this.getNodeParameter('enabled', index) as boolean,
			interval_type: intervalType,
			every,
			time: normaliseTime(this, this.getNodeParameter('time', index, '9:00 AM') as string, index),
			weekdays,
			day_of_month: this.getNodeParameter('dayOfMonth', index, 1) as number,
			start_date: readStartDate(this, index),
			max_pages: maxPages >= MIN_MAX_PAGES ? maxPages : null,
		};

		const job = (await gluecrawlApiRequest.call(
			this,
			'PUT',
			`/v1/jobs/${jobId}/schedule`,
			body,
			undefined,
			{ context: 'While setting the job schedule', itemIndex: index },
		)) as Job;

		return [{ json: job as unknown as IDataObject, pairedItem: { item: index } }];
	} catch (error) {
		if (!this.continueOnFail()) throw asNodeError(this.getNode(), error, index);
		return jobErrorOutput(error, index);
	}
}
