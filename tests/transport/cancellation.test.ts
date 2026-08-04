/**
 * Cancelling an execution has to stop the wait loops.
 *
 * These loops are the only code in the package that can outlive its own
 * execution, and the failure they used to have was silent: "Stop execution"
 * left the loop sleeping out its tick and then polling on, so a cancelled
 * workflow kept issuing GETs for as long as its timeout budget allowed.
 *
 * Two halves are asserted here, and both matter:
 *
 * 1. The loop stops, and stops WITHOUT touching the API again.
 * 2. The cancellation reaches the caller as a cancellation. Every catch site in
 *    this package sits in front of a `continueOnFail()` check, and mapping a
 *    cancellation into a Gluecrawl error there would emit an error item and let
 *    the rest of the workflow run on top of a teardown.
 */

jest.mock('n8n-workflow', () => {
	const actual = jest.requireActual('n8n-workflow');
	const { virtualClock } = jest.requireActual('../helpers/clock');
	return {
		...actual,
		sleepWithAbort: async (ms: number, signal?: AbortSignal) => {
			// Mirrors the real helper: an already-aborted signal rejects rather than
			// advancing the clock, which is what lets a test cancel mid-wait.
			if (signal?.aborted) throw new actual.ManualExecutionCancelledError('');
			virtualClock.now += ms;
		},
	};
});

import nock from 'nock';
import { ExecutionCancelledError, type IExecuteFunctions } from 'n8n-workflow';

import { execute as createJob } from '../../nodes/Gluecrawl/resources/job/create.operation';
import { execute as startRun } from '../../nodes/Gluecrawl/resources/run/start.operation';
import {
	executionCancelSignal,
	isExecutionCancelled,
	throwIfCancelled,
} from '../../nodes/Gluecrawl/transport/cancellation';
import { pollUntil, waitForRunTerminal } from '../../nodes/Gluecrawl/transport/poll';
import {
	BASE_URL,
	createExecuteContext,
	createLoadOptionsContext,
	rejectionOf,
	useNock,
	type ExecuteContext,
} from '../helpers';
import { installVirtualClock, uninstallVirtualClock } from '../helpers/clock';

function asExecute(context: ExecuteContext): IExecuteFunctions {
	return context as unknown as IExecuteFunctions;
}

/** A signal that aborts after `afterCalls` invocations of the returned counter. */
function abortAfter(afterCalls: number): { signal: AbortSignal; tick: () => void } {
	const controller = new AbortController();
	let seen = 0;
	return {
		signal: controller.signal,
		tick: () => {
			seen += 1;
			if (seen >= afterCalls) controller.abort();
		},
	};
}

useNock();

beforeEach(() => installVirtualClock());
afterEach(() => uninstallVirtualClock());

describe('cancellation helpers', () => {
	it('reads the signal off an execution context', () => {
		const signal = new AbortController().signal;
		const context = createExecuteContext({ abortSignal: signal });

		expect(executionCancelSignal(asExecute(context))).toBe(signal);
	});

	it('returns undefined for a context that has no cancel signal', () => {
		// The pickers run at edit time on ILoadOptionsFunctions, which has no
		// cancel signal at all. An unguarded call would throw here.
		const context = createLoadOptionsContext();

		expect(executionCancelSignal(context as never)).toBeUndefined();
	});

	it('recognises n8n cancellation errors and nothing else', () => {
		expect(isExecutionCancelled(new Error('boom'))).toBe(false);
		expect(isExecutionCancelled(undefined)).toBe(false);

		const cancelled = rejectionOfSync(() => throwIfCancelled(abortedSignal()));
		expect(isExecutionCancelled(cancelled)).toBe(true);
		expect(cancelled).toBeInstanceOf(ExecutionCancelledError);
	});

	it('does not throw while the execution is alive', () => {
		expect(() => throwIfCancelled(new AbortController().signal)).not.toThrow();
		expect(() => throwIfCancelled(undefined)).not.toThrow();
	});
});

describe('pollUntil under cancellation', () => {
	it('never touches the API when the execution is already cancelled', async () => {
		const fetch = jest.fn().mockResolvedValue('pending');

		const error = await rejectionOf(
			pollUntil(fetch, () => false, {
				abortSignal: abortedSignal(),
				timeoutMs: 60_000,
				onTimeout: () => {
					throw new Error('should not time out');
				},
			}),
		);

		expect(isExecutionCancelled(error)).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('stops mid-wait instead of polling out the budget', async () => {
		const { signal, tick } = abortAfter(2);
		const fetch = jest.fn(async () => {
			tick();
			return 'pending';
		});

		const error = await rejectionOf(
			pollUntil(fetch, () => false, {
				abortSignal: signal,
				intervalMs: 5_000,
				// Budget enough for a dozen polls. Without the signal this would be
				// the exit, and the assertion below is what proves it was not.
				timeoutMs: 60_000,
				onTimeout: () => {
					throw new Error('should not time out');
				},
			}),
		);

		expect(isExecutionCancelled(error)).toBe(true);
		// Two fetches, then the sleep after the second one rejects. A loop that
		// ignored the signal would have run twelve.
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('times out normally when nothing cancels', async () => {
		const fetch = jest.fn().mockResolvedValue('pending');

		const error = await rejectionOf(
			pollUntil(fetch, () => false, {
				abortSignal: new AbortController().signal,
				intervalMs: 5_000,
				timeoutMs: 12_000,
				onTimeout: () => {
					throw new Error('timed out');
				},
			}),
		);

		expect(error.message).toBe('timed out');
		expect(isExecutionCancelled(error)).toBe(false);
	});
});

describe('waitForRunTerminal under cancellation', () => {
	it('picks the signal up from the execution context', async () => {
		const controller = new AbortController();
		const scope = nock(BASE_URL)
			.get('/v1/runs/run-1')
			.reply(200, () => {
				controller.abort();
				return { id: 'run-1', job_id: 'job-1', status: 'scraping' };
			});

		const context = createExecuteContext({ abortSignal: controller.signal });

		const error = await rejectionOf(
			waitForRunTerminal.call(asExecute(context), 'run-1', { timeoutMs: 300_000 }),
		);

		expect(isExecutionCancelled(error)).toBe(true);
		// The nock scope is satisfied by exactly one call; a second poll would
		// have failed with "no match for request" instead.
		expect(scope.isDone()).toBe(true);
	});
});

describe('operations do not swallow a cancellation', () => {
	const CREATE_PARAMETERS = {
		url: 'https://example.com/products',
		inputMode: 'goal',
		goal: 'Extract every product',
		maxPages: 2,
		waitForCompletion: true,
		outputItems: true,
		timeout: 300,
	};

	it('Job: Create rethrows rather than emitting an error item', async () => {
		const controller = new AbortController();
		nock(BASE_URL)
			.post('/v1/jobs')
			.reply(201, { id: 'job-1', url: CREATE_PARAMETERS.url, status: 'in_progress' })
			.get('/v1/jobs/job-1')
			.reply(200, () => {
				controller.abort();
				return { id: 'job-1', url: CREATE_PARAMETERS.url, status: 'in_progress' };
			});

		// Continue On Fail is ON: this is the branch that used to turn a teardown
		// into a cheerful error item and let downstream nodes run.
		const context = createExecuteContext({
			parameters: CREATE_PARAMETERS,
			abortSignal: controller.signal,
			continueOnFail: true,
		});

		const error = await rejectionOf(createJob.call(asExecute(context), 0));

		expect(isExecutionCancelled(error)).toBe(true);
	});

	it('Run: Start rethrows rather than emitting an error item', async () => {
		const controller = new AbortController();
		nock(BASE_URL)
			.post('/v1/jobs/job-1/runs')
			.reply(201, { id: 'run-1', job_id: 'job-1', status: 'pending' })
			.get('/v1/runs/run-1')
			.reply(200, () => {
				controller.abort();
				return { id: 'run-1', job_id: 'job-1', status: 'scraping' };
			});

		const context = createExecuteContext({
			parameters: { jobId: 'job-1', waitForCompletion: true, outputItems: true, timeout: 300 },
			abortSignal: controller.signal,
			continueOnFail: true,
		});

		const error = await rejectionOf(startRun.call(asExecute(context), 0));

		expect(isExecutionCancelled(error)).toBe(true);
	});
});

/** `rejectionOf` for a synchronous throw. */
function rejectionOfSync(fn: () => void): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error('expected a throw');
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}
