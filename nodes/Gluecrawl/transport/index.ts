/**
 * The single HTTP entry point for every Gluecrawl operation.
 *
 * Operation files must never touch `this.helpers` directly: the base URL comes
 * from the credential, path joining has to tolerate a trailing slash, and every
 * failure has to be mapped by `errors.ts`. Centralising that is the only way
 * those three stay true across the whole package.
 */

import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IPollFunctions,
	IWebhookFunctions,
} from 'n8n-workflow';

import { DEFAULT_BASE_URL, type GluecrawlCredential } from '../types';
import { rethrowIfCancelled } from './cancellation';
import { toGluecrawlApiError } from './errors';

export const CREDENTIAL_NAME = 'gluecrawlApi';

/** Every n8n execution context this package issues requests from. */
export type GluecrawlRequestContext =
	IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions | IWebhookFunctions | IPollFunctions;

export interface GluecrawlRequestOptions {
	/**
	 * Response decoding. Defaults to JSON. Use `arraybuffer` for the CSV export
	 * so the bytes survive intact for `prepareBinaryData`.
	 */
	encoding?: 'json' | 'arraybuffer' | 'text';
	/** Resolve with the full response (status, headers, body) instead of the body. */
	returnFullResponse?: boolean;
	headers?: IDataObject;
	/** Per-request timeout in ms. Omit to use n8n's default. */
	timeout?: number;
	/** Phrase prefixed to the error description, e.g. "While starting a run". */
	context?: string;
	/** Item index to attribute a failure to, for per-item error reporting. */
	itemIndex?: number;
}

/** Shape returned when `returnFullResponse` is set. */
export interface GluecrawlFullResponse<T> {
	body: T;
	headers: IDataObject;
	statusCode: number;
}

/**
 * Joins the credential base URL with an endpoint path.
 *
 * Users paste base URLs with and without a trailing slash, and some paste a
 * URL that already ends in `/v1`; both must produce the same request.
 */
export function buildUrl(baseUrl: string, endpoint: string): string {
	const trimmedBase = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
	const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
	if (trimmedBase.endsWith('/v1') && path.startsWith('/v1/')) {
		return `${trimmedBase}${path.slice(3)}`;
	}
	return `${trimmedBase}${path}`;
}

/** Reads and normalises the Gluecrawl credential for the current context. */
export async function getGluecrawlCredential(
	this: GluecrawlRequestContext,
): Promise<GluecrawlCredential> {
	const credential = (await this.getCredentials(CREDENTIAL_NAME)) as unknown as GluecrawlCredential;
	return {
		apiKey: credential?.apiKey ?? '',
		baseUrl: (credential?.baseUrl ?? '').trim() || DEFAULT_BASE_URL,
	};
}

/**
 * Issues an authenticated request against the Gluecrawl API.
 *
 * `qs` entries that are `undefined` or `null` are dropped so callers can build
 * query objects with optional fields inline without sending `limit=undefined`.
 *
 * Call it bound to the node context. TypeScript cannot infer `T` through
 * `Function.prototype.call`, so assert the response type at the call site:
 *
 * ```ts
 * const job = (await gluecrawlApiRequest.call(this, 'GET', `/v1/jobs/${id}`)) as Job;
 * ```
 */
export async function gluecrawlApiRequest<T = IDataObject>(
	this: GluecrawlRequestContext,
	method: IHttpRequestMethods,
	endpoint: string,
	body?: IDataObject | IDataObject[],
	qs?: IDataObject,
	options: GluecrawlRequestOptions = {},
): Promise<T> {
	const { baseUrl } = await getGluecrawlCredential.call(this);
	const encoding = options.encoding ?? 'json';

	const query: IDataObject = {};
	for (const [key, value] of Object.entries(qs ?? {})) {
		if (value !== undefined && value !== null) query[key] = value;
	}

	const requestOptions: IHttpRequestOptions = {
		method,
		url: buildUrl(baseUrl, endpoint),
		headers: { Accept: encoding === 'json' ? 'application/json' : '*/*', ...options.headers },
		// json:true both serialises the body and parses the response. It is wrong
		// for the CSV export, which must stay raw bytes.
		json: encoding === 'json',
		returnFullResponse: options.returnFullResponse ?? false,
	};

	if (encoding !== 'json') requestOptions.encoding = encoding;
	if (Object.keys(query).length > 0) requestOptions.qs = query;
	if (body !== undefined) requestOptions.body = body as IDataObject;
	if (options.timeout !== undefined) requestOptions.timeout = options.timeout;

	try {
		return (await this.helpers.httpRequestWithAuthentication.call(
			this,
			CREDENTIAL_NAME,
			requestOptions,
		)) as T;
	} catch (error) {
		// n8n aborts in-flight requests when an execution is cancelled. Mapping
		// that into "Gluecrawl request failed" would both mislead and, under
		// Continue On Fail, let the workflow carry on past a cancellation.
		rethrowIfCancelled(error);

		throw toGluecrawlApiError(this.getNode(), error, {
			...(options.context !== undefined ? { context: options.context } : {}),
			...(options.itemIndex !== undefined ? { itemIndex: options.itemIndex } : {}),
		});
	}
}

/**
 * Downloads an endpoint as raw bytes. Used by the CSV export, where the body is
 * a streamed `text/csv` document rather than JSON.
 */
export async function gluecrawlApiRequestBinary(
	this: GluecrawlRequestContext,
	method: IHttpRequestMethods,
	endpoint: string,
	qs?: IDataObject,
	options: Omit<GluecrawlRequestOptions, 'encoding' | 'returnFullResponse'> = {},
): Promise<Buffer> {
	const response = (await gluecrawlApiRequest.call(this, method, endpoint, undefined, qs, {
		...options,
		encoding: 'arraybuffer',
	})) as unknown;

	return Buffer.isBuffer(response) ? response : Buffer.from(response as ArrayBuffer);
}
