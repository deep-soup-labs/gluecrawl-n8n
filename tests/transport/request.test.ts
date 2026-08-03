/**
 * The request wrapper, exercised through a real (nock-intercepted) request
 * rather than a stub, so the URL join, the query assembly and the response
 * decoding are all covered by the same test.
 */

import nock from 'nock';
import type { IExecuteFunctions } from 'n8n-workflow';

import {
	gluecrawlApiRequest,
	gluecrawlApiRequestBinary,
	getGluecrawlCredential,
	type GluecrawlFullResponse,
} from '../../nodes/Gluecrawl/transport';
import { BASE_URL, createExecuteContext, useNock, type ExecuteContext } from '../helpers';

/** The contexts are structural stand-ins; the cast is the whole point of them. */
function asExecute(context: ExecuteContext): IExecuteFunctions {
	return context as unknown as IExecuteFunctions;
}

describe('gluecrawlApiRequest', () => {
	useNock();

	it('sends an authenticated GET and returns the parsed body', async () => {
		const scope = nock(BASE_URL, { reqheaders: { authorization: 'Bearer gc_test_key' } })
			.get('/v1/jobs/job-1')
			.reply(200, { id: 'job-1', url: 'https://example.com' });

		const context = createExecuteContext();
		const job = await gluecrawlApiRequest.call(asExecute(context), 'GET', '/v1/jobs/job-1');

		expect(job).toEqual({ id: 'job-1', url: 'https://example.com' });
		scope.done();
	});

	it('never sets the Authorization header itself', async () => {
		const scope = nock(BASE_URL).get('/v1/jobs/job-1').reply(200, {});
		const context = createExecuteContext();

		await gluecrawlApiRequest.call(asExecute(context), 'GET', '/v1/jobs/job-1');

		// Auth is the credential's job: hand-rolling it here would defeat
		// credential rotation and trip the community-node lint rule.
		const [, options] = context.helpers.httpRequestWithAuthentication.mock.calls[0];
		expect(Object.keys(options.headers ?? {})).toEqual(['Accept']);
		expect(options.headers?.Accept).toBe('application/json');
		scope.done();
	});

	it('honours a custom base URL from the credential', async () => {
		const scope = nock('https://staging-api.gluecrawl.ai').get('/v1/jobs').reply(200, { data: [] });

		const context = createExecuteContext({
			credential: { baseUrl: 'https://staging-api.gluecrawl.ai/' },
		});
		await gluecrawlApiRequest.call(asExecute(context), 'GET', '/v1/jobs');

		scope.done();
	});

	it('drops undefined and null query parameters', async () => {
		const scope = nock(BASE_URL).get('/v1/jobs').query({ limit: '20' }).reply(200, { data: [] });

		const context = createExecuteContext();
		await gluecrawlApiRequest.call(
			asExecute(context),
			'GET',
			'/v1/jobs',
			undefined,
			// A caller assembling an optional query inline must not send
			// "offset=undefined", which the API would reject as a validation error.
			{ limit: 20, offset: undefined, cursor: null },
		);

		expect(context.calls[0].query).toEqual({ limit: '20' });
		scope.done();
	});

	it('serialises a JSON body', async () => {
		let received: unknown;
		const scope = nock(BASE_URL)
			.post('/v1/jobs', (body) => {
				received = body;
				return true;
			})
			.reply(201, { id: 'job-1' });

		const context = createExecuteContext();
		await gluecrawlApiRequest.call(asExecute(context), 'POST', '/v1/jobs', {
			url: 'https://example.com',
			max_pages: 2,
		});

		expect(received).toEqual({ url: 'https://example.com', max_pages: 2 });
		scope.done();
	});

	it('tolerates the empty body of a 204', async () => {
		const scope = nock(BASE_URL).delete('/v1/jobs/job-1').reply(204);

		const context = createExecuteContext();
		await expect(
			gluecrawlApiRequest.call(asExecute(context), 'DELETE', '/v1/jobs/job-1'),
		).resolves.toBeUndefined();

		scope.done();
	});

	it('returns the full response when asked', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/jobs')
			.reply(200, { data: [] }, { 'x-request-id': 'abc' });

		const context = createExecuteContext();
		const response = (await gluecrawlApiRequest.call(
			asExecute(context),
			'GET',
			'/v1/jobs',
			undefined,
			undefined,
			{ returnFullResponse: true },
		)) as GluecrawlFullResponse<unknown>;

		expect(response.statusCode).toBe(200);
		expect(response.headers['x-request-id']).toBe('abc');
		scope.done();
	});

	it('maps a failure through the error mapper, context and all', async () => {
		const scope = nock(BASE_URL)
			.get('/v1/jobs/job-1')
			.reply(403, {
				error: {
					code: 'plan_required',
					message: 'This endpoint requires a Starter plan or higher.',
				},
			});

		const context = createExecuteContext();
		await expect(
			gluecrawlApiRequest.call(asExecute(context), 'GET', '/v1/jobs/job-1', undefined, undefined, {
				context: 'While retrieving the job',
				itemIndex: 2,
			}),
		).rejects.toMatchObject({
			message: 'The Gluecrawl API requires a Pro or Enterprise plan',
			httpCode: '403',
			description: expect.stringContaining('While retrieving the job.'),
		});

		scope.done();
	});
});

describe('gluecrawlApiRequestBinary', () => {
	useNock();

	it('returns the bytes untouched', async () => {
		const csv = 'name,price\nWidget,9.99\n';
		const scope = nock(BASE_URL)
			.get('/v1/runs/run-1/items/csv')
			.reply(200, csv, { 'content-type': 'text/csv' });

		const context = createExecuteContext();
		const buffer = await gluecrawlApiRequestBinary.call(
			asExecute(context),
			'GET',
			'/v1/runs/run-1/items/csv',
		);

		expect(Buffer.isBuffer(buffer)).toBe(true);
		expect(buffer.toString('utf8')).toBe(csv);

		// json:true would have tried to parse the CSV and lost the bytes.
		const [, options] = context.helpers.httpRequestWithAuthentication.mock.calls[0];
		expect(options.json).toBe(false);
		expect(options.encoding).toBe('arraybuffer');
		scope.done();
	});
});

describe('getGluecrawlCredential', () => {
	it('falls back to the production host when the base URL is blank', async () => {
		const context = createExecuteContext({ credential: { baseUrl: '  ' } });

		await expect(getGluecrawlCredential.call(asExecute(context))).resolves.toEqual({
			apiKey: 'gc_test_key',
			baseUrl: BASE_URL,
		});
	});
});
