/**
 * The `listSearch` methods behind the Job and Run pickers.
 *
 * These run in an `ILoadOptionsFunctions` context, which the transport already
 * accepts (`GluecrawlRequestContext`), so they go through the same
 * `gluecrawlApiRequest` as every operation: same base-URL join, same
 * `httpRequestWithAuthentication` call, same error mapping. Nothing here talks
 * to `this.helpers` directly.
 *
 * Two constraints from `/v1` shape everything below:
 *
 * - **There is no server-side search.** `GET /v1/jobs` and
 *   `GET /v1/jobs/{id}/runs` take `limit` and `offset` and nothing else, so the
 *   `filter` the editor passes has to be applied here.
 *
 *   Filtering only the page the editor happened to ask for is NOT good enough,
 *   and this was measured rather than reasoned about: a real account had 122
 *   jobs, and searching for one that sat at offset 104 returned nothing at all.
 *   A picker that answers "no such job" for a job that exists is worse than one
 *   with no search box. So a filtered search SCANS — it pages forward until it
 *   has enough matches or runs out — while an unfiltered browse still hands the
 *   editor one page at a time.
 *
 *   (An earlier version of this comment claimed one page covers any account
 *   because Starter caps active jobs at 10. That cap is on ACTIVE jobs and does
 *   not bound the list; do not reintroduce the assumption.)
 * - **`paginationToken` is ours to define.** It carries the next `offset` as a
 *   string, and is omitted once the envelope's `total` has been reached, which
 *   is what tells the editor to stop asking. A scan returns its matches whole,
 *   with no token — there is nothing sensible for the editor to append to a
 *   result set it did not page through itself.
 *
 * Errors are deliberately NOT caught. n8n renders a failed list as a
 * "problem loading the parameter options" banner, and swallowing the failure to
 * return an empty list would both hide a bad credential behind "no jobs found"
 * and trip the community-nodes `no-silent-error-swallowing` rule. The `By ID`
 * mode is what keeps a failing list from blocking the workflow.
 */

import type {
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
} from 'n8n-workflow';

import { gluecrawlApiRequest } from '../transport';
import { isUuid } from '../resources/locators';
import { MAX_PAGE_SIZE_RECORDS, type DataEnvelope, type Job, type Run } from '../types';

/**
 * Records examined before a filtered scan gives up, and matches collected
 * before it stops early.
 *
 * The scan limit bounds the worst case at ten requests; the match limit is what
 * makes the common case one or two, since the list is newest-first and a search
 * usually hits near the top. Anything past 50 matches is not a list a user picks
 * from anyway — they should narrow the search or paste the ID.
 */
const SEARCH_SCAN_LIMIT = 1000;
const SEARCH_MATCH_LIMIT = 50;

/**
 * The host of a job URL, minus a leading `www.`.
 *
 * Deliberately a regex rather than `new URL()`: a stored URL that does not
 * parse must degrade to something readable, not throw inside a dropdown, and
 * the catch that `new URL()` would need is exactly the silent-swallow shape the
 * lint forbids.
 *
 * Only `www.` is stripped. Any other leading label (`shop.`, `en.`, `m.`) can
 * be the difference between two real sites, so trimming subdomains generally
 * would merge jobs that are not the same target.
 */
function hostOf(url: string): string {
	const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(url);
	return (match?.[1] ?? url).replace(/^www\./i, '');
}

/**
 * `2026-07-28T14:03:22.981Z` -> `2026-07-28 14:03 UTC`.
 *
 * The timestamp is rendered as the UTC it actually is rather than converted to
 * a local zone: there is no date library available (runtime dependencies must
 * stay at zero) and a hand-rolled offset conversion that is silently wrong is
 * worse than a label that states its zone.
 */
function formatTimestamp(iso: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
	return match ? `${match[1]} ${match[2]} UTC` : iso;
}

/**
 * A job's label: `host - status`.
 *
 * Status is in the NAME, not the description, and has to stay there: n8n's
 * resource-locator list renders one line per entry and drops
 * `INodeListSearchItems.description` entirely (checked in the editor on 2.32.7).
 * It is also the field that decides whether a job is usable at all — Run: Start
 * rejects anything that is not `ready`, and `failed`/`stale` are terminal — so a
 * picker that hid it would let users choose a job the next operation refuses.
 *
 * The goal is deliberately NOT shown. That makes two jobs against the same host
 * with the same status render identically; `created_at` in the description is
 * the only thing left that tells them apart, and the description is not
 * rendered. Chosen knowingly for a shorter, scannable row.
 */
function jobToListItem(job: Job): INodeListSearchItems {
	const status = job.status ?? 'unknown';

	return {
		name: `${hostOf(job.url)} - ${status}`,
		value: job.id,
		description: `created ${formatTimestamp(job.created_at)}`,
	};
}

/**
 * A run's label: `when - status`.
 *
 * Runs of one job differ only by time and outcome, so the timestamp leads and
 * is what actually distinguishes rows. Item and page counts are deliberately
 * omitted; `description` carries the id, though see `jobToListItem` — the list
 * does not render descriptions.
 */
function runToListItem(run: Run): INodeListSearchItems {
	return {
		name: `${formatTimestamp(run.created_at)} - ${run.status}`,
		value: run.id,
		description: run.id,
	};
}

/** Case-insensitive match on the label, or an exact match on the id. */
function matches(item: INodeListSearchItems, filter?: string): boolean {
	if (!filter) return true;
	const needle = filter.trim().toLowerCase();
	if (!needle) return true;
	return item.name.toLowerCase().includes(needle) || String(item.value).toLowerCase() === needle;
}

/** Next offset, or nothing once the envelope says the list is exhausted. */
function nextToken(offset: number, received: number, total: number): { paginationToken?: string } {
	const consumed = offset + received;
	return received > 0 && consumed < total ? { paginationToken: String(consumed) } : {};
}

function offsetFrom(paginationToken?: string): number {
	const parsed = Number(paginationToken);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/** One page of a `data` envelope, normalised so a surprise cannot throw. */
async function fetchPage<T>(
	context: ILoadOptionsFunctions,
	endpoint: string,
	offset: number,
	requestContext: string,
): Promise<{ rows: T[]; total: number }> {
	const response = (await gluecrawlApiRequest.call(
		context,
		'GET',
		endpoint,
		undefined,
		{ limit: MAX_PAGE_SIZE_RECORDS, offset },
		{ context: requestContext },
	)) as DataEnvelope<T>;

	return {
		rows: Array.isArray(response?.data) ? response.data : [],
		total: typeof response?.total === 'number' ? response.total : 0,
	};
}

/**
 * Backs both pickers: browse a page at a time, or scan when the user is
 * searching.
 *
 * The two modes are genuinely different operations, not one with a flag. A
 * browse hands the editor exactly what it asked for and a token for the next
 * page. A search cannot do that — filtering one page silently hides every match
 * beyond it — so it walks forward itself and returns the matches whole.
 */
async function browseOrScan<T>(
	context: ILoadOptionsFunctions,
	endpoint: string,
	toItem: (row: T) => INodeListSearchItems,
	requestContext: string,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const needle = filter?.trim();

	if (!needle) {
		const offset = offsetFrom(paginationToken);
		const { rows, total } = await fetchPage<T>(context, endpoint, offset, requestContext);

		return { results: rows.map(toItem), ...nextToken(offset, rows.length, total) };
	}

	const results: INodeListSearchItems[] = [];
	let offset = 0;
	let scanned = 0;

	while (scanned < SEARCH_SCAN_LIMIT && results.length < SEARCH_MATCH_LIMIT) {
		const { rows, total } = await fetchPage<T>(context, endpoint, offset, requestContext);
		if (rows.length === 0) break;

		for (const row of rows) {
			const item = toItem(row);
			if (matches(item, needle)) results.push(item);
			if (results.length >= SEARCH_MATCH_LIMIT) break;
		}

		scanned += rows.length;
		offset += rows.length;

		// A short page or a satisfied `total` both mean there is no more to scan;
		// without either check this would keep asking for empty pages forever.
		if (rows.length < MAX_PAGE_SIZE_RECORDS || offset >= total) break;
	}

	// Deliberately no `paginationToken`: the editor did not page through this,
	// and handing it an offset into the UNFILTERED list would make "load more"
	// append arbitrary non-matching rows underneath the matches.
	return { results };
}

/** The account's jobs, newest first. Backs the Job picker on every operation. */
export async function searchJobs(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	return await browseOrScan<Job>(
		this,
		'/v1/jobs',
		jobToListItem,
		'While listing jobs for the Job field',
		filter,
		paginationToken,
	);
}

/**
 * The runs of the job selected in the sibling `jobId` field, newest first.
 *
 * The empty-list guard is a guard clause, not a swallowed error: it is reached
 * before any request, when the user opens the Run picker before choosing a job,
 * or when `jobId` is set to an expression that only resolves at execution time.
 * Firing a request with an unresolved `{{ ... }}` in the path would answer 404
 * and surface as "problem loading options", which reads as a broken node rather
 * than as an unfilled field.
 */
export async function searchRuns(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const jobId = this.getCurrentNodeParameter('jobId', { extractValue: true });
	if (!isUuid(jobId)) return { results: [] };

	// A scheduled job accumulates runs indefinitely, so this list outgrows one
	// page exactly like the job list does.
	return await browseOrScan<Run>(
		this,
		`/v1/jobs/${jobId.trim()}/runs`,
		runToListItem,
		'While listing runs for the Run field',
		filter,
		paginationToken,
	);
}
