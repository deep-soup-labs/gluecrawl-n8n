/**
 * Honouring execution cancellation inside the wait loops.
 *
 * The poll loops are the only code in this package that keeps running after n8n
 * may have decided an execution is over — everything else is one request and a
 * return. A bare `sleep` there means "Stop execution" in the editor, a workflow
 * timeout, or a queue-mode worker shutting down leaves the loop sleeping out its
 * current tick and then issuing more GETs on behalf of an execution nobody is
 * waiting for.
 *
 * n8n hands execution contexts an `AbortSignal` for exactly this, and its own
 * community-node lint rules point at `sleepWithAbort` rather than `sleep`.
 *
 * **Cancellation is not a Gluecrawl failure.** It must never be mapped into one
 * by `toGluecrawlApiError`, and it must never become a Continue-On-Fail error
 * item: the execution is being torn down, so emitting an item would let
 * downstream nodes run on top of a cancellation. Every catch site in this
 * package rethrows it untouched, which is why this module exists rather than a
 * one-line `instanceof` at each of them.
 *
 * What cancelling does NOT do is stop the work. `/v1` has no cancel endpoint, so
 * the run continues on Gluecrawl's side and is still charged — the same caveat
 * a wait timeout carries, and for the same reason. See `waitTimeoutError`.
 */

import {
	ExecutionCancelledError,
	ManualExecutionCancelledError,
	type IExecuteFunctions,
} from 'n8n-workflow';

import type { GluecrawlRequestContext } from './index';

/**
 * The execution's cancel signal, when the context has one.
 *
 * Only execution-shaped contexts carry it. `ILoadOptionsFunctions` (the
 * pickers), `IHookFunctions` and `IWebhookFunctions` (the trigger) do not — and
 * none of them polls. Probed rather than cast because `GluecrawlRequestContext`
 * spans all of them, and an unguarded call would throw on the contexts that
 * lack it.
 */
export function executionCancelSignal(context: GluecrawlRequestContext): AbortSignal | undefined {
	const getSignal = (context as Partial<IExecuteFunctions>).getExecutionCancelSignal;
	return typeof getSignal === 'function' ? getSignal.call(context) : undefined;
}

/** True for n8n's own "this execution was cancelled" error, however it was raised. */
export function isExecutionCancelled(error: unknown): boolean {
	return error instanceof ExecutionCancelledError;
}

/**
 * Rethrows a cancellation untouched. Call it first in any catch block that maps
 * errors or honours `continueOnFail`.
 *
 * A function rather than an inline `if (...) throw error` at each call site, for
 * two reasons. It keeps one copy of the reasoning instead of four. And the
 * community-nodes rule `require-node-api-error` rejects re-throwing a caught
 * error from inside a catch block — rightly, since its purpose is to stop raw
 * HTTP failures reaching the UI stripped of their context. A cancellation is the
 * case that rule is not about: it carries no HTTP context to lose, and it has to
 * stay the exact class n8n core matches on to record the execution as cancelled
 * rather than failed. Wrapping it in a `NodeApiError` would report a cancelled
 * workflow as a Gluecrawl outage.
 */
export function rethrowIfCancelled(error: unknown): void {
	if (isExecutionCancelled(error)) throw error;
}

/**
 * Throws if the execution has already been cancelled, so a loop does not reach
 * the network again after the decision to stop.
 *
 * Raises the same concrete error `sleepWithAbort` does. An `AbortSignal` does
 * not carry a reason, and n8n's own helper reports every abort as a manual
 * cancellation, so matching it keeps exactly one error shape on this path.
 */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new ManualExecutionCancelledError('');
}
