/**
 * The Job and Run pickers.
 *
 * Both ids are `resourceLocator` rather than `options` + `loadOptionsMethod`,
 * and the choice is load-bearing for three separate reasons:
 *
 * 1. The verification scan applies `eslint-plugin-n8n-nodes-base`'s `nodes`
 *    ruleset, where `node-param-display-name-wrong-for-dynamic-options` and
 *    `node-param-description-wrong-for-dynamic-options` are errors. A dropdown
 *    built as `options` + `loadOptionsMethod` is forced to rename itself
 *    "<Entity> Name or ID" and to end its description with a fixed sentence of
 *    boilerplate, which would overwrite the per-operation copy below. The scan
 *    runs with `allowInlineConfig: false`, so an eslint-disable does not help.
 *    No rule in that plugin looks at `resourceLocator` at all.
 * 2. `type: 'options'` is on the editor's `$fromAI` denylist
 *    (`PROP_TYPE_DENYLIST = ['options', 'credentialsSelect']`), so a plain
 *    dropdown cannot be filled by an AI agent. This node sets `usableAsTool`
 *    and its tool copy steers agents at Run: Start against an existing job, so
 *    an unfillable `jobId` would break the exact path that copy recommends.
 *    `resourceLocator` is not denylisted.
 * 3. `loadOptions` has no pagination — the method must return the whole list in
 *    one array — while `/v1` caps `limit` at 100. A resource locator's
 *    `paginationToken` maps straight onto the offset paging the transport
 *    already does.
 *
 * The `By ID` mode is not a fallback, it is half the feature: every id in this
 * package normally arrives from an upstream node's output, and that mode is
 * what keeps `{{ $json.id }}` a first-class way to fill the field.
 */

import type { INodeProperties } from 'n8n-workflow';

/**
 * Any UUID version, which is what the API's `uuid.UUID` path parameters parse.
 * Shared with the search methods, which use it to tell a real id from an
 * unresolved expression before spending a request on it.
 */
export const UUID_REGEX =
	'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

const UUID_ANCHORED = new RegExp(`^${UUID_REGEX}$`);

/** Whether a value is a usable id rather than an empty field or a live expression. */
export function isUuid(value: unknown): value is string {
	return typeof value === 'string' && UUID_ANCHORED.test(value.trim());
}

/**
 * Shown when the list cannot load fast enough to feel interactive. Accounts are
 * capped at 10 active jobs on Starter, so this should effectively never fire —
 * it exists so that an account that is somehow much larger degrades into
 * "paste the id" instead of into a spinner.
 */
const slowLoadNotice = (entity: string) => ({
	message: `If loading takes longer than expected, select the ${entity} using "By ID" instead.`,
	timeout: 10000,
});

/**
 * The Job picker.
 *
 * `description` is always supplied by the caller: the operations differ in what
 * choosing a job actually does (delete it, schedule it, run it), and that
 * warning is the most useful sentence on the field.
 */
export function jobLocator(description: string): INodeProperties {
	return {
		displayName: 'Job',
		name: 'jobId',
		type: 'resourceLocator',
		required: true,
		default: { mode: 'list', value: '' },
		description,
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				placeholder: 'Select a job...',
				typeOptions: {
					searchListMethod: 'searchJobs',
					searchable: true,
					slowLoadNotice: slowLoadNotice('job'),
				},
			},
			{
				displayName: 'By ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. 8f4a2c1e-0b7d-4a19-9c3f-6d5e2a1b8c04',
				validation: [
					{
						type: 'regex',
						properties: {
							regex: `^\\s*${UUID_REGEX}\\s*$`,
							errorMessage: 'Not a valid Gluecrawl job ID. Job IDs are UUIDs.',
						},
					},
				],
			},
		],
	};
}

/**
 * The Run picker.
 *
 * `/v1` lists runs only under a job (`GET /v1/jobs/{id}/runs`; there is no
 * account-wide run list), so every operation that offers this picker also
 * carries a `jobId` — see `jobScopeLocator`.
 */
export function runLocator(description: string): INodeProperties {
	return {
		displayName: 'Run',
		name: 'runId',
		type: 'resourceLocator',
		required: true,
		default: { mode: 'list', value: '' },
		description,
		// No `loadOptionsDependsOn: ['jobId']` here. It was tried against n8n
		// 2.32.7 and does nothing useful for a resource locator: the run LIST
		// already re-fetches for the newly selected job without it, and the
		// selected VALUE is not cleared with it. A stale run therefore survives a
		// job change either way, which is what `fetchRunInJob` exists to catch at
		// execution time. Re-adding the option would only imply a guarantee n8n
		// does not provide.
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				placeholder: 'Select a run...',
				hint: 'Runs of the job selected above, newest first',
				typeOptions: {
					searchListMethod: 'searchRuns',
					searchable: true,
					slowLoadNotice: slowLoadNotice('run'),
				},
			},
			{
				displayName: 'By ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. 8f14e45f-ceea-467a-9c1b-2a6b3f2b7c10',
				validation: [
					{
						type: 'regex',
						properties: {
							regex: `^\\s*${UUID_REGEX}\\s*$`,
							errorMessage: 'Not a valid Gluecrawl run ID. Run IDs are UUIDs.',
						},
					},
				],
			},
		],
	};
}

/**
 * The Job field on the three run-scoped operations that are keyed on a run
 * alone (Run: Get, Run: Get Items, Run: Download CSV).
 *
 * It is NOT sent to the API — those endpoints are keyed on the run id alone.
 * It exists to scope the Run picker, because runs are only listable per job.
 * Every Gluecrawl output that carries a run id carries the job id beside it
 * (`Run: Start` returns a run with `job_id`, `Job: Create` returns the job with
 * the run nested under `run`, and the trigger emits `job_id` and `run_id`
 * together), so requiring it costs an upstream expression that is already to
 * hand rather than a lookup.
 */
export function jobScopeLocator(): INodeProperties {
	return jobLocator(
		"The job the run belongs to. Used to list that job's runs in the Run field below; it is not sent to the API, which identifies the run by its ID alone. Every Gluecrawl output carrying a run ID carries the job ID next to it.",
	);
}
