/**
 * Offset pagination over the two envelope shapes `/v1` uses.
 *
 * Jobs, runs, webhooks and deliveries paginate under `data`; run items
 * paginate under `items`. The page-size ceilings differ too (100 vs 500), and
 * asking for more is a 422 rather than a clamp, so the cap is applied here.
 */

import type { IDataObject, IHttpRequestMethods } from 'n8n-workflow';

import { MAX_PAGE_SIZE_ITEMS, MAX_PAGE_SIZE_RECORDS } from '../types';
import { gluecrawlApiRequest, type GluecrawlRequestContext } from './index';

export type PaginationEnvelopeKey = 'data' | 'items';

/** Server-enforced `limit` ceiling per envelope shape. */
export const MAX_PAGE_SIZE: Record<PaginationEnvelopeKey, number> = {
	data: MAX_PAGE_SIZE_RECORDS,
	items: MAX_PAGE_SIZE_ITEMS,
};

/**
 * Last-resort stop on request count. The repeated-page guard below ends a
 * broken endpoint on request two; this only bounds a pathological case neither
 * that nor `total` catches.
 */
const MAX_REQUESTS = 1000;

export interface PaginateOptions {
	/** Which key the rows live under. */
	envelopeKey: PaginationEnvelopeKey;
	/** Extra query parameters merged into every request. */
	qs?: IDataObject;
	/** Rows per request. Clamped to the endpoint ceiling. Defaults to the ceiling. */
	pageSize?: number;
	/** Stop once this many rows have been collected. Omit for everything. */
	maxResults?: number;
	context?: string;
	itemIndex?: number;
}

interface Envelope {
	data?: unknown;
	items?: unknown;
	total?: unknown;
}

/** Pulls the row array out of either envelope shape. Never throws on a surprise. */
export function extractEnvelopeRows<T>(response: unknown, envelopeKey: PaginationEnvelopeKey): T[] {
	const rows = (response as Envelope | undefined)?.[envelopeKey];
	return Array.isArray(rows) ? (rows as T[]) : [];
}

function clampPageSize(requested: number | undefined, ceiling: number): number {
	if (requested === undefined || !Number.isFinite(requested)) return ceiling;
	return Math.min(Math.max(Math.trunc(requested), 1), ceiling);
}

/**
 * Cheap identity for a page, used to notice an endpoint that ignores `offset`
 * and keeps replying with the same rows.
 *
 * Only the first and last row are hashed: enough to tell consecutive pages
 * apart, and constant work regardless of page size. Rows arrive from
 * `JSON.parse`, so there are no cycles to trip over.
 */
function pageFingerprint(batch: unknown[]): string {
	return JSON.stringify([batch.length, batch[0], batch[batch.length - 1]]);
}

/**
 * Fetches every page of a paginated endpoint and returns the concatenated rows.
 *
 * Termination is deliberately belt-and-braces: an empty page, a short page, a
 * satisfied `total`, a page identical to the previous one, or the request
 * ceiling. Any one of them ends the loop.
 */
export async function gluecrawlApiRequestAllItems<T>(
	this: GluecrawlRequestContext,
	method: IHttpRequestMethods,
	endpoint: string,
	options: PaginateOptions,
): Promise<T[]> {
	const ceiling = MAX_PAGE_SIZE[options.envelopeKey];
	const pageSize = clampPageSize(options.pageSize, ceiling);
	const results: T[] = [];

	let offset = 0;
	let requests = 0;
	let previousPage: string | undefined;

	while (requests < MAX_REQUESTS) {
		requests += 1;

		const response = (await gluecrawlApiRequest.call(
			this,
			method,
			endpoint,
			undefined,
			{ ...options.qs, limit: pageSize, offset },
			{
				...(options.context !== undefined ? { context: options.context } : {}),
				...(options.itemIndex !== undefined ? { itemIndex: options.itemIndex } : {}),
			},
		)) as unknown;

		const batch = extractEnvelopeRows<T>(response, options.envelopeKey);
		if (batch.length === 0) break;

		// A proxy or a mock that drops `offset` replies with page one forever.
		// Caught before the rows are appended, so the workflow gets one copy of
		// the data rather than a thousand.
		const fingerprint = pageFingerprint(batch);
		if (fingerprint === previousPage) break;
		previousPage = fingerprint;

		results.push(...batch);

		if (options.maxResults !== undefined && results.length >= options.maxResults) {
			results.length = options.maxResults;
			break;
		}

		// A short page means the server had nothing more to give.
		if (batch.length < pageSize) break;

		offset += batch.length;

		const total = (response as Envelope | undefined)?.total;
		if (typeof total === 'number' && offset >= total) break;
	}

	return results;
}

/**
 * Single-page fetch honouring the endpoint's ceiling — the non-"Return All"
 * branch of a Get Many operation.
 */
export async function gluecrawlApiRequestPage<T>(
	this: GluecrawlRequestContext,
	method: IHttpRequestMethods,
	endpoint: string,
	options: Omit<PaginateOptions, 'maxResults'> & { limit?: number; offset?: number },
): Promise<T[]> {
	const ceiling = MAX_PAGE_SIZE[options.envelopeKey];
	const response = (await gluecrawlApiRequest.call(
		this,
		method,
		endpoint,
		undefined,
		{
			...options.qs,
			limit: clampPageSize(options.limit, ceiling),
			offset: Math.max(options.offset ?? 0, 0),
		},
		{
			...(options.context !== undefined ? { context: options.context } : {}),
			...(options.itemIndex !== undefined ? { itemIndex: options.itemIndex } : {}),
		},
	)) as unknown;

	return extractEnvelopeRows<T>(response, options.envelopeKey);
}
