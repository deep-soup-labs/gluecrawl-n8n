/**
 * The action node's router: dispatch, and the Continue-On-Fail safety net.
 *
 * The safety net is not decorative. Five operations read their first parameter
 * OUTSIDE their own try block (`run/get`, `run/start`, `run/getMany`,
 * `run/getItems`, `run/downloadCsv`), so a failing expression on that
 * parameter — `={{ $json.run.id }}` against an item with no `run` key — is
 * caught here rather than by the operation. Whatever this branch emits is
 * therefore a real error-output shape a user's Switch node has to match, and it
 * has to be the same `{error, errorDescription}` pair every operation produces.
 */

import type { IExecuteFunctions } from 'n8n-workflow';

import { Gluecrawl } from '../../nodes/Gluecrawl/Gluecrawl.node';
import { jobOperations } from '../../nodes/Gluecrawl/resources/job/job.description';
import { createExecuteContext, rejectionOf } from '../helpers';
import type { ExecuteContext } from '../helpers';

const node = new Gluecrawl();

/** An n8n ExpressionError, as thrown by `getNodeParameter` on a bad reference. */
function expressionError(): Error & { description: string } {
	const error = new Error("Can't get data for expression '{{ $json.run.id }}'") as Error & {
		description: string;
	};
	error.description = 'The field "run" does not exist on the input item';
	return error;
}

/** Makes reading `name` blow up the way a failing expression does. */
function failParameter(ctx: ExecuteContext, name: string): void {
	const original = ctx.getNodeParameter;
	ctx.getNodeParameter = jest.fn((param: string, itemIndex: number, fallback?: unknown) => {
		if (param === name) throw expressionError();
		return original(param, itemIndex, fallback);
	}) as unknown as ExecuteContext['getNodeParameter'];
}

describe('Gluecrawl router', () => {
	it('does not expose job scheduling operations', () => {
		const operationNames = (jobOperations.options ?? []).map((option) => option.name);

		expect(operationNames).toEqual(['Create', 'Delete', 'Get', 'Get Many']);
	});

	it('emits the package-wide error keys when a parameter expression fails', async () => {
		const ctx = createExecuteContext({
			parameters: { resource: 'run', operation: 'get' },
			continueOnFail: true,
		});
		failParameter(ctx, 'runId');

		const result = await node.execute.call(ctx as unknown as IExecuteFunctions);

		expect(result[0]).toHaveLength(1);
		const json = result[0][0].json;
		// One Switch expression has to cover the whole package, so the fallback
		// item may not invent its own key for the actionable half.
		expect(json.errorDescription).toBe('The field "run" does not exist on the input item');
		expect(json).not.toHaveProperty('description');
		expect(String(json.error)).toContain("Can't get data for expression");
		expect(result[0][0].pairedItem).toEqual({ item: 0 });
		// Nothing reached the API: the failure happened before the first request.
		expect(ctx.calls).toHaveLength(0);
	});

	it('aborts the execution when Continue On Fail is off', async () => {
		const ctx = createExecuteContext({ parameters: { resource: 'run', operation: 'get' } });
		failParameter(ctx, 'runId');

		const error = await rejectionOf(node.execute.call(ctx as unknown as IExecuteFunctions));

		expect(error.message).toContain("Can't get data for expression");
	});

	it('rejects an unknown resource/operation pair regardless of Continue On Fail', async () => {
		// Not a data problem: no input item could make the combination valid, so
		// continueOnFail deliberately does not apply.
		const ctx = createExecuteContext({
			parameters: { resource: 'run', operation: 'create' },
			continueOnFail: true,
		});

		const error = await rejectionOf(node.execute.call(ctx as unknown as IExecuteFunctions));

		expect(error.message).toContain('is not supported on the "run" resource');
	});

	it('serves the row-reading operations off the Run resource', () => {
		// The rows used to live under an "item" resource. `/v1` has no item entity
		// to address — every row endpoint is keyed on a run — so a workflow that
		// still names it must fail loudly rather than dispatch somewhere plausible.
		const resources = (
			(node.description.properties.find((property) => property.name === 'resource')?.options ??
				[]) as Array<{ value: string }>
		).map((option) => option.value);

		expect(resources).toEqual(['job', 'run']);

		const runOperations = (
			(node.description.properties.find(
				(property) =>
					property.name === 'operation' && property.displayOptions?.show?.resource?.includes('run'),
			)?.options ?? []) as Array<{ value: string }>
		).map((option) => option.value);

		expect(runOperations).toEqual(['downloadCsv', 'get', 'getItems', 'getMany', 'start']);
	});
});
