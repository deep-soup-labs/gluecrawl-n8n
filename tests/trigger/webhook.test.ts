/**
 * Trigger inbound deliveries: verify-then-emit.
 *
 * Deliveries are signature-checked before anything here runs (see
 * signature.test.ts). What these tests enforce is what happens AFTER a delivery
 * is known to be genuine: the referenced record is fetched and emitted in place
 * of the bare payload, filters are applied, and no path hangs — the API
 * abandons an attempt after 10s, and a timeout burns a retry for nothing.
 */

import type { IWebhookFunctions } from 'n8n-workflow';
import nock from 'nock';

import { GluecrawlTrigger } from '../../nodes/GluecrawlTrigger/GluecrawlTrigger.node';
import type { Run } from '../../nodes/Gluecrawl/types';
import { BASE_URL, createHookContext, resourceLocatorValue, useNock } from '../helpers';

const trigger = new GluecrawlTrigger();

/** The secret the workflow stored when it registered its endpoint. */
const SECRET = 'whsec_test_endpoint_secret';

/**
 * A delivery context that is correctly signed by default.
 *
 * Signing is seeded here rather than in each test so that a test about routing,
 * filtering or enrichment states only what it is about. The tests that care
 * about authentication override `headers` or `staticData` explicitly.
 */
function ctxFor(options: Parameters<typeof createHookContext>[0] = {}) {
	return createHookContext({
		...options,
		staticData: { webhookSecret: SECRET, ...(options.staticData ?? {}) },
	});
}

const RUN_ID = '8f14e45f-ceea-467a-9c1b-2a6b3f2b7c10';
const JOB_ID = '7a3f9c1e-2b40-4d1a-9f77-0d5a1c8e3b62';

/**
 * The API's answer, deliberately richer than and contradicting the payload:
 * `item_count` and `billing` exist only here, and `status` disagrees with the
 * `run_status` the delivery claimed.
 */
const API_RUN: Run = {
	id: RUN_ID,
	job_id: JOB_ID,
	status: 'failed',
	item_count: 42,
	page_count: 3,
	credits_used: 12,
	billing: {
		listing_pages: 3,
		detail_items: 42,
		protection_level: 'light',
		credits_settled: 12,
	},
	created_at: '2026-01-01T00:00:00Z',
	completed_at: '2026-01-01T00:05:00Z',
};

function delivery(type: string, data: Record<string, unknown> = {}) {
	return {
		id: 'evt_123',
		type,
		api_version: '1',
		created_at: '2026-01-01T00:05:01Z',
		data,
	};
}

/** The single item a delivery produced, or undefined when nothing was emitted. */
function emitted(result: { workflowData?: unknown[][] }) {
	const items = (result.workflowData?.[0] ?? []) as Array<{ json: Record<string, unknown> }>;
	return items[0]?.json;
}

describe('trigger: webhook', () => {
	useNock();

	it('emits the API response for a run event, not the delivered payload', async () => {
		nock(BASE_URL).get(`/v1/runs/${RUN_ID}`).reply(200, API_RUN);

		const ctx = ctxFor({
			parameters: { jobId: '' },
			body: delivery('run.completed', {
				run_id: RUN_ID,
				job_id: JOB_ID,
				run_status: 'completed',
			}),
		});

		const result = await trigger.webhook.call(ctx as unknown as IWebhookFunctions);
		const json = emitted(result);

		// Present only in the API response: proof the fetch happened and its body
		// is what was emitted.
		expect(json?.item_count).toBe(42);
		expect(json?.billing).toEqual(API_RUN.billing);
		// The payload claimed "completed"; the API is the authority.
		expect(json?.status).toBe('failed');
		expect(json?.verified).toBe(true);
		expect(json?.event).toBe('run.completed');
		expect(json?.event_id).toBe('evt_123');
		expect(json?.event_created_at).toBe('2026-01-01T00:05:01Z');
		expect(ctx.calls).toEqual([
			expect.objectContaining({ method: 'GET', path: `/v1/runs/${RUN_ID}` }),
		]);
	});

	it('re-fetches the job for a job event', async () => {
		nock(BASE_URL)
			.get(`/v1/jobs/${JOB_ID}`)
			.reply(200, {
				id: JOB_ID,
				url: 'https://example.com',
				status: 'ready',
				columns: { listing: [{ name: 'title', type: 'text' }], detail: [] },
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:01:00Z',
			});

		const ctx = ctxFor({
			parameters: { jobId: '' },
			body: delivery('job.ready', { job_id: JOB_ID, job_status: 'ready' }),
		});

		const json = emitted(await trigger.webhook.call(ctx as unknown as IWebhookFunctions));

		expect(json?.columns).toEqual({ listing: [{ name: 'title', type: 'text' }], detail: [] });
		expect(json?.verified).toBe(true);
		expect(ctx.calls[0].path).toBe(`/v1/jobs/${JOB_ID}`);
	});

	it('bounds the verification fetch so the 10s delivery budget is not blown', async () => {
		nock(BASE_URL).get(`/v1/runs/${RUN_ID}`).reply(200, API_RUN);

		const ctx = ctxFor({
			parameters: { jobId: '' },
			body: delivery('run.failed', { run_id: RUN_ID, job_id: JOB_ID }),
		});

		await trigger.webhook.call(ctx as unknown as IWebhookFunctions);

		const [, options] = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
		expect(options.timeout).toBeLessThan(10_000);
		expect(options.timeout).toBeGreaterThan(0);
	});

	it('marks a test delivery and performs no verification fetch', async () => {
		const ctx = ctxFor({
			parameters: { jobId: '' },
			body: delivery('webhook.test'),
		});

		const json = emitted(await trigger.webhook.call(ctx as unknown as IWebhookFunctions));

		expect(json?.test).toBe(true);
		expect(json?.verified).toBe(false);
		expect(json?.event).toBe('webhook.test');
		expect(json?.message).toContain('Test delivery from Gluecrawl');
		// Nothing to verify, and no credential read either.
		expect(ctx.calls).toHaveLength(0);
		expect(ctx.getCredentials).not.toHaveBeenCalled();
	});

	it('lets a test delivery through even when a Job ID filter is set', async () => {
		// The test delivery carries no job, and it is the only way to confirm the
		// wiring, so the filter must not swallow it.
		const ctx = ctxFor({
			parameters: { jobId: JOB_ID },
			body: delivery('webhook.test'),
		});

		const json = emitted(await trigger.webhook.call(ctx as unknown as IWebhookFunctions));

		expect(json?.test).toBe(true);
	});

	it('drops an event for another job and acknowledges it with a 200', async () => {
		const ctx = ctxFor({
			parameters: { jobId: JOB_ID },
			body: delivery('run.completed', { run_id: RUN_ID, job_id: 'some-other-job' }),
		});

		const result = await trigger.webhook.call(ctx as unknown as IWebhookFunctions);

		// No workflowData means no items started the workflow, and an empty result
		// still answers 200 — answering anything else would make Gluecrawl record
		// a delivery failure for an event we ignored on purpose.
		expect(result).toEqual({});
		expect(result.noWebhookResponse).toBeUndefined();
		expect(ctx.calls).toHaveLength(0);
	});

	it('passes an event through when the Job ID filter matches', async () => {
		nock(BASE_URL).get(`/v1/runs/${RUN_ID}`).reply(200, API_RUN);

		const ctx = ctxFor({
			parameters: { jobId: `  ${JOB_ID}  ` },
			body: delivery('run.completed', { run_id: RUN_ID, job_id: JOB_ID }),
		});

		const json = emitted(await trigger.webhook.call(ctx as unknown as IWebhookFunctions));

		expect(json?.verified).toBe(true);
	});

	// The field is a resource locator, so the stored value is an object rather
	// than the string the filter compares. Reading it without `extractValue`
	// would stringify to "[object Object]" and silently drop every delivery.
	it('filters on a job chosen from the picker, not only on a pasted ID', async () => {
		nock(BASE_URL).get(`/v1/runs/${RUN_ID}`).reply(200, API_RUN);

		const ctx = ctxFor({
			parameters: { jobId: resourceLocatorValue(JOB_ID) },
			body: delivery('run.completed', { run_id: RUN_ID, job_id: JOB_ID }),
		});

		const json = emitted(await trigger.webhook.call(ctx as unknown as IWebhookFunctions));

		expect(json?.verified).toBe(true);
	});

	it('drops an event for another job when the picker holds a job', async () => {
		const ctx = ctxFor({
			parameters: { jobId: resourceLocatorValue(JOB_ID) },
			body: delivery('run.completed', { run_id: RUN_ID, job_id: 'some-other-job' }),
		});

		expect(await trigger.webhook.call(ctx as unknown as IWebhookFunctions)).toEqual({});
		expect(ctx.calls).toHaveLength(0);
	});

	// An untouched picker persists as `{ mode: 'list', value: '' }`, which is the
	// default state of the field and has to keep meaning "every job".
	it('treats an empty picker as no filter at all', async () => {
		nock(BASE_URL).get(`/v1/runs/${RUN_ID}`).reply(200, API_RUN);

		const ctx = ctxFor({
			parameters: { jobId: resourceLocatorValue('') },
			body: delivery('run.completed', { run_id: RUN_ID, job_id: JOB_ID }),
		});

		const json = emitted(await trigger.webhook.call(ctx as unknown as IWebhookFunctions));

		expect(json?.verified).toBe(true);
	});

	it('emits the event unverified when the verification fetch fails', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}`)
			.reply(500, { error: { code: 'internal_error', message: 'Boom.' } });

		const ctx = ctxFor({
			parameters: { jobId: '' },
			body: delivery('run.completed', {
				run_id: RUN_ID,
				job_id: JOB_ID,
				run_status: 'completed',
			}),
		});

		// Emitting beats dropping: the delivery is already authenticated, so
		// surfacing a degraded item beats discarding it. Re-raising
		// would lose the event permanently and silently.
		const result = await trigger.webhook.call(ctx as unknown as IWebhookFunctions);
		const json = emitted(result);

		expect(json?.verified).toBe(false);
		expect(json?.verification_error).toBe('Gluecrawl returned 500');
		// Falls back to the ids and statuses from the signed payload so a
		// workflow can branch on the flag and re-fetch itself.
		expect(json?.run_id).toBe(RUN_ID);
		expect(json?.run_status).toBe('completed');
		expect(json?.event).toBe('run.completed');
	});

	it('emits unverified when the API rejects the credential outright', async () => {
		nock(BASE_URL)
			.get(`/v1/runs/${RUN_ID}`)
			.reply(401, { error: { code: 'invalid_api_key', message: 'Invalid API key.' } });

		const ctx = ctxFor({
			parameters: { jobId: '' },
			body: delivery('run.completed', { run_id: RUN_ID, job_id: JOB_ID }),
		});

		const json = emitted(await trigger.webhook.call(ctx as unknown as IWebhookFunctions));

		expect(json?.verified).toBe(false);
		expect(json?.verification_error).toBe('Gluecrawl rejected the API key');
	});

	it('emits unverified rather than fetching when the payload references nothing', async () => {
		const ctx = ctxFor({
			parameters: { jobId: '' },
			body: delivery('run.completed', { job_id: JOB_ID }),
		});

		const json = emitted(await trigger.webhook.call(ctx as unknown as IWebhookFunctions));

		// A run event that carries only a job id must NOT fall back to the job:
		// the item would be a Job emitted under a run event label, and the next
		// node would read the wrong `status`.
		expect(ctx.calls).toHaveLength(0);
		expect(json?.verified).toBe(false);
		expect(json?.verification_error).toContain('did not reference a run or job');
	});

	it('verifies a run event this version does not know by name', async () => {
		nock(BASE_URL).get(`/v1/runs/${RUN_ID}`).reply(200, API_RUN);

		const ctx = ctxFor({
			parameters: { jobId: '' },
			body: delivery('run.paused', { run_id: RUN_ID, job_id: JOB_ID }),
		});

		const json = emitted(await trigger.webhook.call(ctx as unknown as IWebhookFunctions));

		// The event prefix, not a known-events list, picks the endpoint — so a new
		// `run.*` event added upstream keeps working instead of arriving raw.
		expect(json?.event).toBe('run.paused');
		expect(json?.verified).toBe(true);
		expect(json?.item_count).toBe(42);
	});

	it('emits unverified when the verification request never gets a response', async () => {
		// Envelope C: a transport-level failure with no HTTP response at all.
		nock(BASE_URL).get(`/v1/runs/${RUN_ID}`).replyWithError('socket hang up');

		const ctx = ctxFor({
			parameters: { jobId: '' },
			body: delivery('run.completed', { run_id: RUN_ID, job_id: JOB_ID }),
		});

		const json = emitted(await trigger.webhook.call(ctx as unknown as IWebhookFunctions));

		expect(json?.verified).toBe(false);
		expect(typeof json?.verification_error).toBe('string');
		expect(json?.verification_error).not.toBe('');
		expect(json?.run_id).toBe(RUN_ID);
	});

	it('survives a body that is not a Gluecrawl payload at all', async () => {
		const ctx = ctxFor({ parameters: { jobId: '' }, body: 'not json' });

		const json = emitted(await trigger.webhook.call(ctx as unknown as IWebhookFunctions));

		expect(json?.event).toBe('unknown');
		expect(json?.verified).toBe(false);
		expect(ctx.calls).toHaveLength(0);
	});
});
