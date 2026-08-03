/**
 * Job: Set Schedule and Remove Schedule.
 *
 * The weekly validator is the centrepiece. Gluecrawl compiles a weekly schedule
 * into an EventBridge cron expression, which cannot express "every N weeks on
 * these weekdays", and the API reports the violation as a raw FastAPI
 * validation list rather than the usual error envelope. Catching it in the node
 * is only worth anything if it happens BEFORE the request, so every rejection
 * test also asserts that nothing left the node.
 */

import nock from 'nock';
import type { IExecuteFunctions } from 'n8n-workflow';

import { execute as removeSchedule } from '../../nodes/Gluecrawl/resources/job/removeSchedule.operation';
import { execute as setSchedule } from '../../nodes/Gluecrawl/resources/job/setSchedule.operation';
import {
	BASE_URL,
	createExecuteContext,
	rejectionOf,
	useNock,
	type ExecuteContext,
} from '../helpers';

function asExecute(context: ExecuteContext): IExecuteFunctions {
	return context as unknown as IExecuteFunctions;
}

const BASE_PARAMETERS = {
	jobId: 'job-1',
	intervalType: 'days',
	every: 1,
	time: '9:00 AM',
	weekdays: [] as number[],
	dayOfMonth: 1,
	startDate: '',
	maxPages: 0,
	enabled: true,
};

function context(overrides: Record<string, unknown> = {}, continueOnFail = false): ExecuteContext {
	return createExecuteContext({
		parameters: { ...BASE_PARAMETERS, ...overrides },
		continueOnFail,
	});
}

const SCHEDULED_JOB = {
	id: 'job-1',
	url: 'https://example.com',
	status: 'ready',
	created_at: '2026-01-01T00:00:00Z',
	updated_at: '2026-01-02T00:00:00Z',
};

/** Captures the PUT body while replying with a scheduled job. */
function mockPut(): { scope: nock.Scope; body: () => Record<string, unknown> } {
	let captured: Record<string, unknown> = {};
	const scope = nock(BASE_URL)
		.put('/v1/jobs/job-1/schedule', (received) => {
			captured = received;
			return true;
		})
		.reply(200, SCHEDULED_JOB);

	return { scope, body: () => captured };
}

describe('Job: Set Schedule', () => {
	useNock();

	it('sends the full schedule object the API expects', async () => {
		const { scope, body } = mockPut();

		const items = await setSchedule.call(
			asExecute(context({ intervalType: 'days', every: 3, time: '11:30 PM' })),
			0,
		);

		expect(body()).toEqual({
			enabled: true,
			interval_type: 'days',
			every: 3,
			time: '11:30 PM',
			weekdays: [],
			day_of_month: 1,
			start_date: null,
			max_pages: null,
		});
		expect(items).toEqual([{ json: SCHEDULED_JOB, pairedItem: { item: 0 } }]);
		scope.done();
	});

	it('accepts a valid weekly schedule', async () => {
		const { scope, body } = mockPut();

		await setSchedule.call(
			asExecute(context({ intervalType: 'weeks', every: 1, weekdays: [0, 3] })),
			0,
		);

		expect(body()).toMatchObject({ interval_type: 'weeks', every: 1, weekdays: [0, 3] });
		scope.done();
	});

	it('rejects a weekly schedule with no weekdays, before any request', async () => {
		const ctx = context({ intervalType: 'weeks', every: 1, weekdays: [] });
		const error = await rejectionOf(setSchedule.call(asExecute(ctx), 0));

		expect(error.message).toContain('needs at least one weekday');
		expect(ctx.calls).toHaveLength(0);
	});

	it('rejects a weekly schedule with Every above 1, before any request', async () => {
		const ctx = context({ intervalType: 'weeks', every: 2, weekdays: [1] });
		const error = await rejectionOf(setSchedule.call(asExecute(ctx), 0));

		expect(error.message).toContain('must run every 1 week');
		expect(error.description).toContain('Interval "Days"');
		expect(ctx.calls).toHaveLength(0);
	});

	it('leaves Every alone for non-weekly intervals', async () => {
		const { scope, body } = mockPut();

		// The every == 1 rule is weeks-only; days every 14 is a valid schedule.
		await setSchedule.call(asExecute(context({ intervalType: 'days', every: 14 })), 0);

		expect(body()).toMatchObject({ interval_type: 'days', every: 14 });
		scope.done();
	});

	it.each([
		['09:30 am', '9:30 AM'],
		['9:00 AM', '9:00 AM'],
		['12:05 pm', '12:05 PM'],
	])('normalises the time %s to %s', async (input, expected) => {
		const { scope, body } = mockPut();

		await setSchedule.call(asExecute(context({ time: input })), 0);

		// The API splits this string literally, so the shape has to be exact.
		expect(body().time).toBe(expected);
		scope.done();
	});

	it.each(['14:00', '9:00', 'noon', '13:00 PM', ''])(
		'rejects the unparseable time %p before any request',
		async (time) => {
			const ctx = context({ time });
			const error = await rejectionOf(setSchedule.call(asExecute(ctx), 0));

			expect(error.message).toContain('not a valid schedule time');
			expect(ctx.calls).toHaveLength(0);
		},
	);

	it('passes a valid start date through and nulls an empty one', async () => {
		const withDate = mockPut();
		await setSchedule.call(asExecute(context({ startDate: '2026-03-01' })), 0);
		expect(withDate.body().start_date).toBe('2026-03-01');
		withDate.scope.done();

		const withoutDate = mockPut();
		await setSchedule.call(asExecute(context({ startDate: '  ' })), 0);
		expect(withoutDate.body().start_date).toBeNull();
		withoutDate.scope.done();
	});

	it.each(['01/03/2026', '2026-3-1', '2026-03-01T00:00:00Z', '2026-13-45'])(
		'rejects the start date %p before any request',
		async (startDate) => {
			const ctx = context({ startDate });
			const error = await rejectionOf(setSchedule.call(asExecute(ctx), 0));

			expect(error.message).toContain('not a valid start date');
			expect(ctx.calls).toHaveLength(0);
		},
	);

	it('treats a Max Pages override of 0 as "use the job\'s own limit"', async () => {
		const { scope, body } = mockPut();

		await setSchedule.call(asExecute(context({ maxPages: 0 })), 0);

		expect(body().max_pages).toBeNull();
		scope.done();
	});

	it('sends a real Max Pages override', async () => {
		const { scope, body } = mockPut();

		await setSchedule.call(asExecute(context({ maxPages: 5 })), 0);

		expect(body().max_pages).toBe(5);
		scope.done();
	});

	it('sends the month-day for a monthly schedule', async () => {
		const { scope, body } = mockPut();

		await setSchedule.call(asExecute(context({ intervalType: 'months', dayOfMonth: 15 })), 0);

		expect(body()).toMatchObject({ interval_type: 'months', day_of_month: 15 });
		scope.done();
	});

	it('explains a 409 on a job that is not mapped yet', async () => {
		const scope = nock(BASE_URL)
			.put('/v1/jobs/job-1/schedule')
			.reply(409, { error: { code: 'job_not_ready', message: 'Job is not ready.' } });

		const error = await rejectionOf(setSchedule.call(asExecute(context()), 0));

		expect(error.message).toBe('The job is not ready to run');
		expect(error.description).toContain('While setting the job schedule.');
		scope.done();
	});

	it('surfaces a raw FastAPI validation body rather than showing "undefined"', async () => {
		// What the API answers when a schedule field slips past the node's own
		// checks: no error envelope, no code, just Pydantic's list.
		const scope = nock(BASE_URL)
			.put('/v1/jobs/job-1/schedule')
			.reply(422, {
				detail: [
					{
						loc: ['body', 'max_pages'],
						msg: 'Input should be less than or equal to 100',
						type: 'less_than_equal',
					},
				],
			});

		const error = await rejectionOf(setSchedule.call(asExecute(context({ maxPages: 100 })), 0));

		expect(error.message).toBe('Gluecrawl rejected the request parameters');
		expect(error.description).toContain('max_pages: Input should be less than or equal to 100');
		expect(`${error.message}${error.description}`).not.toContain('undefined');
		scope.done();
	});

	it('emits an error item when continue on fail is set', async () => {
		const ctx = context({ intervalType: 'weeks', weekdays: [] }, true);
		const items = await setSchedule.call(asExecute(ctx), 0);

		expect(items[0].json.error).toContain('needs at least one weekday');
		expect(items[0].pairedItem).toEqual({ item: 0 });
		expect(ctx.calls).toHaveLength(0);
	});
});

describe('Job: Remove Schedule', () => {
	useNock();

	it('confirms the removal the 204 gave no body for', async () => {
		const scope = nock(BASE_URL).delete('/v1/jobs/job-1/schedule').reply(204);

		const items = await removeSchedule.call(
			asExecute(createExecuteContext({ parameters: { jobId: 'job-1' } })),
			0,
		);

		expect(items).toEqual([{ json: { success: true, id: 'job-1' }, pairedItem: { item: 0 } }]);
		scope.done();
	});

	it('maps a failure with the operation context', async () => {
		const scope = nock(BASE_URL)
			.delete('/v1/jobs/job-1/schedule')
			.reply(404, { error: { code: 'not_found', message: 'Job not found.' } });

		const error = await rejectionOf(
			removeSchedule.call(asExecute(createExecuteContext({ parameters: { jobId: 'job-1' } })), 0),
		);

		expect(error.description).toContain('While removing the job schedule.');
		scope.done();
	});
});
