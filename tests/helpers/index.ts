/**
 * Shared test scaffolding.
 *
 * The package never imports an HTTP client — every request goes through
 * `this.helpers.httpRequestWithAuthentication`. So the fake contexts below
 * implement that helper on top of the global `fetch`, which nock intercepts.
 * Going through a real request rather than stubbing the transport keeps
 * `buildUrl`, the query-string assembly, the JSON/arraybuffer decoding and the
 * error mapping inside the code under test instead of inside the mock.
 *
 * Every call is also recorded, because several behaviours are only expressible
 * as an assertion about a request that must NOT have happened (the trigger
 * never DELETEs or PATCHes an endpoint it does not own).
 */

import nock from 'nock';

import { SIGNATURE_HEADER, computeSignature } from '../../nodes/GluecrawlTrigger/signature';
import type { IBinaryData, IDataObject, IHttpRequestOptions, INode } from 'n8n-workflow';

export const BASE_URL = 'https://api.gluecrawl.ai';
export const API_KEY = 'gc_test_key';

/** What n8n hands the trigger as its production webhook URL. */
export const DEFAULT_WEBHOOK_URL = 'https://n8n.example.com/webhook/gluecrawl';

export const NODE: INode = {
	id: 'test-node',
	name: 'Gluecrawl',
	type: 'n8n-nodes-gluecrawl.gluecrawl',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** One request the code under test issued, captured before serialisation. */
export interface RecordedCall {
	method: string;
	/** Path only, without the query string. */
	path: string;
	query: Record<string, string>;
	/** The body object as the operation built it, not the JSON text. */
	body?: unknown;
}

export interface MockContextOptions {
	/** Node parameters by name. */
	parameters?: Record<string, unknown>;
	credential?: { apiKey?: string; baseUrl?: string };
	continueOnFail?: boolean;
	/** Seed for `getWorkflowStaticData('node')`. Mutated in place by the node. */
	staticData?: IDataObject;
	/** Value returned by `getNodeWebhookUrl`. `null` models an unsaved workflow. */
	webhookUrl?: string | null;
	/** Inbound webhook body for `getBodyData`. */
	body?: unknown;
	/**
	 * Exact bytes for `rawBody`. Defaults to `JSON.stringify(body)`. Set it
	 * explicitly to model a body whose serialisation differs from what the
	 * signature covers.
	 */
	rawBody?: string;
	headers?: Record<string, string>;
	node?: INode;
}

/** The parts of a fake context tests assert on, alongside the n8n surface. */
export interface MockContextExtras {
	calls: RecordedCall[];
	staticData: IDataObject;
	node: INode;
}

// Applied at import time, and never undone: a test file that reaches the real
// api.gluecrawl.ai does not fail loudly, it answers 401 and the assertion error
// blames the node instead of the missing interceptor.
nock.disableNetConnect();

/**
 * Registers nock's per-test cleanup: no interceptor leaks between tests, and a
 * hard failure if a test leaves one unconsumed (which otherwise silently
 * weakens the next test).
 *
 * Safe to call once per `describe`. It deliberately does not restore or
 * re-enable net connect, because those are process-wide and a later block would
 * inherit a live socket.
 */
export function useNock(): void {
	afterEach(() => {
		const pending = nock.pendingMocks();
		nock.cleanAll();
		if (pending.length > 0) {
			throw new Error(`Unconsumed nock interceptors: ${pending.join(', ')}`);
		}
	});
}

/** A node error as the tests read it: n8n keeps the actionable half on `description`. */
export type ThrownNodeError = Error & { description?: string; httpCode?: string };

/**
 * Returns what a promise rejected with, typed as an error.
 *
 * `expect(...).rejects` cannot express the assertions these tests need (several
 * facts about one error), and a bare `.catch((e) => e)` widens the type to
 * `Error | Run` and loses `.description`.
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<ThrownNodeError> {
	try {
		await promise;
	} catch (error) {
		return error as ThrownNodeError;
	}

	throw new Error('Expected the operation to reject, but it resolved');
}

/** Requests of a given method, for "this must not have been called" assertions. */
export function callsOf(calls: RecordedCall[], method: string): RecordedCall[] {
	return calls.filter((call) => call.method === method.toUpperCase());
}

/**
 * Resolves a parameter name the way n8n does, including the dotted path into a
 * `fixedCollection` that Job: Create uses (`getNodeParameter('columns.column')`
 * reads the `column` list out of the `columns` parameter).
 */
function resolveParameter(
	parameters: Record<string, unknown>,
	name: string,
	fallback: unknown,
): unknown {
	if (name in parameters) return parameters[name];

	let current: unknown = parameters;
	for (const segment of name.split('.')) {
		if (typeof current !== 'object' || current === null) return fallback;
		current = (current as Record<string, unknown>)[segment];
	}

	return current === undefined ? fallback : current;
}

/**
 * A stored `resourceLocator` value, as n8n persists it on the node.
 *
 * Tests set `jobId`/`runId` either as a bare string (what an expression or an
 * older workflow yields) or through `resourceLocatorValue`. Both must reach the
 * operation as the same plain id, which is exactly what `extractValue: true`
 * promises, so the mock has to model the object shape rather than only the
 * string one.
 */
export function resourceLocatorValue(value: string, mode: 'list' | 'id' = 'list') {
	return { __rl: true, mode, value };
}

function isResourceLocator(value: unknown): value is { __rl: true; value: unknown } {
	return typeof value === 'object' && value !== null && (value as { __rl?: unknown }).__rl === true;
}

/**
 * `getNodeParameter`'s `extractValue` option: unwraps a resource locator, and
 * passes anything else through untouched (n8n does the same, which is what
 * makes the option safe to apply to a parameter that arrived as a plain string).
 */
function applyExtractValue(value: unknown, options?: { extractValue?: boolean }): unknown {
	if (options?.extractValue !== true) return value;
	return isResourceLocator(value) ? value.value : value;
}

/** Error shape n8n's axios-based httpRequest throws on a non-2xx response. */
interface HttpErrorLike {
	message: string;
	response: { status: number; data: unknown; headers: Record<string, string> };
}

function parseMaybeJson(text: string): unknown {
	if (text === '') return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * Stand-in for `helpers.httpRequestWithAuthentication`: applies the credential
 * the way the generic auth in `GluecrawlApi.credentials.ts` does, issues the
 * request through `fetch`, and reshapes a non-2xx into the axios-like error the
 * transport's error mapper is written against.
 */
async function performRequest(
	options: IHttpRequestOptions,
	apiKey: string,
	calls: RecordedCall[],
): Promise<unknown> {
	const url = new URL(options.url);
	for (const [key, value] of Object.entries(options.qs ?? {})) {
		url.searchParams.set(key, String(value));
	}

	calls.push({
		method: (options.method ?? 'GET').toUpperCase(),
		path: url.pathname,
		query: Object.fromEntries(url.searchParams.entries()),
		...(options.body !== undefined ? { body: options.body } : {}),
	});

	const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
	for (const [key, value] of Object.entries(options.headers ?? {})) {
		if (value !== undefined && value !== null) headers[key] = String(value);
	}

	let payload: string | undefined;
	if (options.body !== undefined) {
		payload = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
		headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
	}

	const response = await fetch(url, {
		method: (options.method ?? 'GET').toUpperCase(),
		headers,
		...(payload !== undefined ? { body: payload } : {}),
	});

	const raw = Buffer.from(await response.arrayBuffer());

	if (!response.ok) {
		const error: HttpErrorLike = {
			message: `Request failed with status code ${response.status}`,
			response: {
				status: response.status,
				// axios decodes a failure body with the same `responseType` as a
				// success body, so an `arraybuffer` request fails with BYTES, not with
				// a parsed envelope. Decoding it here regardless would hide the one
				// shape Run: Download CSV actually produces.
				data: options.encoding === 'arraybuffer' ? raw : parseMaybeJson(raw.toString('utf8')),
				headers: Object.fromEntries(response.headers.entries()),
			},
		};
		throw error;
	}

	const text = raw.toString('utf8');
	const decoded =
		options.encoding === 'arraybuffer' ? raw : options.json === false ? text : parseMaybeJson(text);

	if (options.returnFullResponse) {
		return {
			body: decoded,
			headers: Object.fromEntries(response.headers.entries()),
			statusCode: response.status,
		};
	}

	return decoded;
}

function makeHelpers(apiKey: string, calls: RecordedCall[]) {
	return {
		httpRequestWithAuthentication: jest.fn(
			async (_credentialType: string, options: IHttpRequestOptions) =>
				performRequest(options, apiKey, calls),
		),
		httpRequest: jest.fn(async (options: IHttpRequestOptions) =>
			performRequest(options, apiKey, calls),
		),
		prepareBinaryData: jest.fn(
			async (buffer: Buffer, fileName?: string, mimeType?: string): Promise<IBinaryData> => ({
				data: buffer.toString('base64'),
				mimeType: mimeType ?? 'application/octet-stream',
				...(fileName !== undefined ? { fileName } : {}),
				...(fileName !== undefined && fileName.includes('.')
					? { fileExtension: fileName.split('.').pop() }
					: {}),
				fileSize: `${buffer.length} B`,
			}),
		),
	};
}

function baseContext(options: MockContextOptions) {
	const calls: RecordedCall[] = [];
	const staticData: IDataObject = options.staticData ?? {};
	const node = options.node ?? NODE;
	const credential = {
		apiKey: options.credential?.apiKey ?? API_KEY,
		baseUrl: options.credential?.baseUrl ?? BASE_URL,
	};

	return {
		calls,
		staticData,
		node,
		getNode: jest.fn(() => node),
		getCredentials: jest.fn(async () => credential),
		getWorkflowStaticData: jest.fn(() => staticData),
		continueOnFail: jest.fn(() => options.continueOnFail === true),
		helpers: makeHelpers(credential.apiKey, calls),
	};
}

/**
 * `IExecuteFunctions` stand-in. `getNodeParameter` follows the execute-context
 * signature `(name, itemIndex, fallback?)`.
 */
export function createExecuteContext(options: MockContextOptions = {}) {
	const parameters = options.parameters ?? {};
	const base = baseContext(options);

	return {
		...base,
		getInputData: jest.fn(() => [{ json: {} }]),
		getNodeParameter: jest.fn(
			(
				name: string,
				_itemIndex: number,
				fallback?: unknown,
				options?: { extractValue?: boolean },
			) => applyExtractValue(resolveParameter(parameters, name, fallback), options),
		),
	};
}

/**
 * `ILoadOptionsFunctions` stand-in for the Job and Run pickers.
 *
 * Edit-time context: there is no input data and no item index, and sibling
 * fields are read through `getCurrentNodeParameter` rather than
 * `getNodeParameter` — that difference is the whole reason the Run picker can
 * see which job is selected, so the mock keeps the two methods distinct instead
 * of aliasing them.
 */
export function createLoadOptionsContext(options: MockContextOptions = {}) {
	const parameters = options.parameters ?? {};
	const base = baseContext(options);

	return {
		...base,
		getNodeParameter: jest.fn(
			(name: string, fallback?: unknown, opts?: { extractValue?: boolean }) =>
				applyExtractValue(resolveParameter(parameters, name, fallback), opts),
		),
		getCurrentNodeParameter: jest.fn((name: string, opts?: { extractValue?: boolean }) =>
			applyExtractValue(resolveParameter(parameters, name, undefined), opts),
		),
		getCurrentNodeParameters: jest.fn(() => parameters),
	};
}

/**
 * `IHookFunctions` / `IWebhookFunctions` stand-in. `getNodeParameter` follows
 * the trigger-context signature `(name, fallback?, options?)` — no item index,
 * but the same `extractValue` option, which the Job filter's resource locator
 * relies on.
 */
export function createHookContext(options: MockContextOptions = {}) {
	const parameters = options.parameters ?? {};
	const base = baseContext(options);
	const webhookUrl = options.webhookUrl === undefined ? DEFAULT_WEBHOOK_URL : options.webhookUrl;

	const rawBody = options.rawBody ?? JSON.stringify(options.body ?? {});
	// Sign by default when the workflow owns a secret, so a test about routing
	// or filtering does not have to restate the crypto. A test that cares about
	// verification supplies its own header (or an explicit empty object) and
	// that always wins.
	const storedSecret = (options.staticData as { webhookSecret?: string } | undefined)
		?.webhookSecret;
	const signedHeaders: Record<string, string> =
		options.headers !== undefined
			? (options.headers as Record<string, string>)
			: storedSecret
				? {
						[SIGNATURE_HEADER]: `t=${Math.floor(Date.now() / 1000)},v1=${computeSignature(
							storedSecret,
							`${Math.floor(Date.now() / 1000)}`,
							rawBody,
						)}`,
					}
				: {};

	return {
		...base,
		getNodeParameter: jest.fn(
			(name: string, fallback?: unknown, options?: { extractValue?: boolean }) =>
				applyExtractValue(resolveParameter(parameters, name, fallback), options),
		),
		getNodeWebhookUrl: jest.fn(() => webhookUrl ?? undefined),
		getBodyData: jest.fn(() => options.body ?? {}),
		getHeaderData: jest.fn(() => signedHeaders),
		// n8n augments IncomingMessage with rawBody, and the signature covers
		// those exact bytes -- so the stand-in has to carry them too, or every
		// verification here would test a different body than production signs.
		getRequestObject: jest.fn(() => ({ body: options.body ?? {}, rawBody })),
		getResponseObject: jest.fn(() => ({})),
		getWebhookName: jest.fn(() => 'default'),
	};
}

export type ExecuteContext = ReturnType<typeof createExecuteContext>;
export type HookContext = ReturnType<typeof createHookContext>;
export type LoadOptionsContext = ReturnType<typeof createLoadOptionsContext>;
