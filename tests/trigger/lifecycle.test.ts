/**
 * Trigger webhook lifecycle: checkExists / create / delete.
 *
 * A Gluecrawl account has exactly one webhook endpoint slot, shared with the
 * dashboard and every other workflow. So the assertions that matter most here
 * are negative ones — the requests the node must NOT issue against an endpoint
 * it did not create. Those are checked against the recorded call log rather
 * than only through nock, so a missing interceptor cannot be mistaken for
 * correct restraint.
 */

import type { IHookFunctions } from 'n8n-workflow';
import nock from 'nock';

import { GluecrawlTrigger } from '../../nodes/GluecrawlTrigger/GluecrawlTrigger.node';
import { isGluecrawlErrorCode, toGluecrawlApiError } from '../../nodes/Gluecrawl/transport/errors';
import type { Webhook } from '../../nodes/Gluecrawl/types';
import {
	BASE_URL,
	DEFAULT_WEBHOOK_URL,
	NODE,
	callsOf,
	createHookContext,
	useNock,
} from '../helpers';

const methods = new GluecrawlTrigger().webhookMethods.default;

const OUR_ID = 'wh_ours';
const FOREIGN_URL = 'https://n8n.example.com/webhook/somebody-else';

function webhook(overrides: Partial<Webhook> = {}): Webhook {
	return {
		id: OUR_ID,
		url: DEFAULT_WEBHOOK_URL,
		events: ['run.completed'],
		enabled: true,
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
		...overrides,
	};
}

function listWebhooks(webhooks: Webhook[]) {
	return nock(BASE_URL).get('/v1/webhooks').reply(200, { data: webhooks });
}

describe('trigger: checkExists', () => {
	useNock();

	it('is false when the account has no webhook endpoint', async () => {
		listWebhooks([]);

		const ctx = createHookContext({ parameters: { events: ['run.completed'] } });

		await expect(methods.checkExists.call(ctx as unknown as IHookFunctions)).resolves.toBe(false);
		expect(callsOf(ctx.calls, 'POST')).toHaveLength(0);
	});

	it('is true when the endpoint already points at this workflow', async () => {
		listWebhooks([webhook()]);

		const ctx = createHookContext({ parameters: { events: ['run.completed'] } });

		await expect(methods.checkExists.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);
		expect(ctx.staticData.webhookId).toBe(OUR_ID);
		// Adopting must never claim ownership; only `create` may.
		expect(ctx.staticData.createdByNode).toBe(false);
		expect(callsOf(ctx.calls, 'PATCH')).toHaveLength(0);
	});

	it('matches regardless of a trailing slash on either side', async () => {
		listWebhooks([webhook({ url: `${DEFAULT_WEBHOOK_URL}/` })]);

		const ctx = createHookContext({ parameters: { events: ['run.completed'] } });

		await expect(methods.checkExists.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);
	});

	it('patches an endpoint whose event set drifted', async () => {
		listWebhooks([webhook({ events: ['run.completed'] })]);
		nock(BASE_URL).patch(`/v1/webhooks/${OUR_ID}`).reply(200, webhook());

		const ctx = createHookContext({
			parameters: { events: ['run.completed', 'run.failed'] },
		});

		await expect(methods.checkExists.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);

		const patches = callsOf(ctx.calls, 'PATCH');
		expect(patches).toHaveLength(1);
		expect(patches[0].path).toBe(`/v1/webhooks/${OUR_ID}`);
		expect(patches[0].body).toEqual({ events: ['run.completed', 'run.failed'], enabled: true });
	});

	it('does not patch when the same events arrive in a different order', async () => {
		listWebhooks([webhook({ events: ['run.failed', 'run.completed'] })]);

		const ctx = createHookContext({
			parameters: { events: ['run.completed', 'run.failed'] },
		});

		await expect(methods.checkExists.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);
		expect(callsOf(ctx.calls, 'PATCH')).toHaveLength(0);
	});

	it('re-enables an endpoint that points here but is disabled', async () => {
		// A disabled endpoint aimed at this workflow delivers nothing, so the
		// trigger would look active and never fire.
		listWebhooks([webhook({ enabled: false })]);
		nock(BASE_URL).patch(`/v1/webhooks/${OUR_ID}`).reply(200, webhook());

		const ctx = createHookContext({ parameters: { events: ['run.completed'] } });

		await expect(methods.checkExists.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);
		expect(callsOf(ctx.calls, 'PATCH')[0].body).toEqual({
			events: ['run.completed'],
			enabled: true,
		});
	});

	it('is false when the slot is held by a different URL, and forgets the stale id', async () => {
		listWebhooks([webhook({ id: 'wh_theirs', url: FOREIGN_URL })]);

		const ctx = createHookContext({
			parameters: { events: ['run.completed'] },
			staticData: { webhookId: 'wh_stale', createdByNode: true },
		});

		await expect(methods.checkExists.call(ctx as unknown as IHookFunctions)).resolves.toBe(false);
		// Dropping the record is what stops `delete` from later targeting an id
		// that now belongs to someone else.
		expect(ctx.staticData.webhookId).toBeUndefined();
		expect(ctx.staticData.createdByNode).toBeUndefined();
		expect(callsOf(ctx.calls, 'PATCH')).toHaveLength(0);
		expect(callsOf(ctx.calls, 'DELETE')).toHaveLength(0);
	});

	it('drops ownership when the slot holds a DIFFERENT endpoint id at the same URL', async () => {
		// The dashboard's natural way to fix an event set is delete + re-create,
		// which mints a fresh UUID while the URL stays the same. Ownership belongs
		// to the endpoint, not to this node, so it must not survive that.
		listWebhooks([webhook({ id: 'wh_dashboard' })]);

		const ctx = createHookContext({
			parameters: { events: ['run.completed'] },
			staticData: { webhookId: OUR_ID, createdByNode: true },
		});

		await expect(methods.checkExists.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);
		expect(ctx.staticData.webhookId).toBe('wh_dashboard');
		expect(ctx.staticData.createdByNode).toBe(false);
	});

	it('keeps ownership when the very same endpoint is still in the slot', async () => {
		// The ordinary re-activation: same id, same URL, still ours to clean up.
		listWebhooks([webhook()]);

		const ctx = createHookContext({
			parameters: { events: ['run.completed'] },
			staticData: { webhookId: OUR_ID, createdByNode: true },
		});

		await expect(methods.checkExists.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);
		expect(ctx.staticData.createdByNode).toBe(true);
	});

	it('is false without calling the API when n8n has no webhook URL yet', async () => {
		const ctx = createHookContext({
			parameters: { events: ['run.completed'] },
			webhookUrl: null,
		});

		await expect(methods.checkExists.call(ctx as unknown as IHookFunctions)).resolves.toBe(false);
		expect(ctx.calls).toHaveLength(0);
	});

	it('rejects an empty event selection before touching the API', async () => {
		const ctx = createHookContext({ parameters: { events: [] } });

		await expect(methods.checkExists.call(ctx as unknown as IHookFunctions)).rejects.toThrow(
			'Select at least one Gluecrawl event',
		);
		expect(ctx.calls).toHaveLength(0);
	});
});

describe('trigger: create', () => {
	useNock();

	it('registers the endpoint when the slot is free and records ownership', async () => {
		listWebhooks([]);
		nock(BASE_URL)
			.post('/v1/webhooks')
			.reply(201, webhook({ id: 'wh_new' }));

		const ctx = createHookContext({ parameters: { events: ['run.completed'] } });

		await expect(methods.create.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);

		const posts = callsOf(ctx.calls, 'POST');
		expect(posts).toHaveLength(1);
		expect(posts[0].body).toEqual({ url: DEFAULT_WEBHOOK_URL, events: ['run.completed'] });
		expect(ctx.staticData.webhookId).toBe('wh_new');
		expect(ctx.staticData.createdByNode).toBe(true);
	});

	it('deduplicates the selected events before registering', async () => {
		listWebhooks([]);
		nock(BASE_URL)
			.post('/v1/webhooks')
			.reply(201, webhook({ id: 'wh_new' }));

		const ctx = createHookContext({
			parameters: { events: ['run.completed', 'run.completed', 'not-an-event'] },
		});

		await methods.create.call(ctx as unknown as IHookFunctions);

		expect(callsOf(ctx.calls, 'POST')[0].body).toEqual({
			url: DEFAULT_WEBHOOK_URL,
			events: ['run.completed'],
		});
	});

	it('ignores endpoints belonging to others and registers its own', async () => {
		// An account holds several endpoints now, so a foreign one is not a
		// conflict -- but it must still be left completely alone.
		listWebhooks([webhook({ id: 'wh_theirs', url: FOREIGN_URL })]);
		nock(BASE_URL)
			.post('/v1/webhooks')
			.reply(201, { ...webhook({ id: 'wh_ours' }), secret: 'whsec_new' });

		const ctx = createHookContext({ parameters: { events: ['run.completed'] } });

		await expect(methods.create.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);
		expect(ctx.staticData.webhookId).toBe('wh_ours');
		expect(ctx.staticData.createdByNode).toBe(true);
		// Someone else's endpoint is neither repointed nor removed.
		expect(callsOf(ctx.calls, 'DELETE')).toHaveLength(0);
		expect(callsOf(ctx.calls, 'PATCH')).toHaveLength(0);
	});

	it('stores the signing secret disclosed at registration', async () => {
		// Disclosed exactly once. Losing it means no delivery can be verified
		// afterwards, so it has to be persisted with the ownership record.
		listWebhooks([]);
		nock(BASE_URL)
			.post('/v1/webhooks')
			.reply(201, { ...webhook({ id: 'wh_ours' }), secret: 'whsec_disclosed_once' });

		const ctx = createHookContext({ parameters: { events: ['run.completed'] } });

		await expect(methods.create.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);
		expect(ctx.staticData.webhookSecret).toBe('whsec_disclosed_once');
	});

	it('reports the endpoint cap without deleting anything to make room', async () => {
		listWebhooks([webhook({ id: 'wh_theirs', url: FOREIGN_URL })]);
		nock(BASE_URL)
			.post('/v1/webhooks')
			.reply(409, {
				error: {
					code: 'webhook_limit_reached',
					message: 'An account may have at most 5 webhook endpoints.',
					limit: 5,
				},
			});

		const ctx = createHookContext({ parameters: { events: ['run.completed'] } });

		await expect(methods.create.call(ctx as unknown as IHookFunctions)).rejects.toMatchObject({
			message: 'The Gluecrawl account has no free webhook endpoint slots',
			// The cap is echoed from the API rather than hardcoded in the node.
			description: expect.stringContaining('5'),
		});
		// Evicting someone else's endpoint is never the resolution.
		expect(callsOf(ctx.calls, 'DELETE')).toHaveLength(0);
		expect(callsOf(ctx.calls, 'PATCH')).toHaveLength(0);
		expect(ctx.staticData.webhookId).toBeUndefined();
	});

	it('adopts an endpoint that already points here rather than creating a second one', async () => {
		// checkExists ran moments ago; reaching create with a matching endpoint is
		// a race, and adopting is the safe resolution.
		listWebhooks([webhook()]);

		const ctx = createHookContext({ parameters: { events: ['run.completed'] } });

		await expect(methods.create.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);
		expect(callsOf(ctx.calls, 'POST')).toHaveLength(0);
		expect(ctx.staticData.webhookId).toBe(OUR_ID);
		expect(ctx.staticData.createdByNode).toBe(false);
	});

	it('does not carry ownership onto a different endpoint id while adopting', async () => {
		// Same laundering hole as checkExists: the id in static data no longer
		// names the endpoint sitting in the slot, so the flag cannot follow it.
		listWebhooks([webhook({ id: 'wh_dashboard' })]);

		const ctx = createHookContext({
			parameters: { events: ['run.completed'] },
			staticData: { webhookId: OUR_ID, createdByNode: true },
		});

		await expect(methods.create.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);
		expect(ctx.staticData.webhookId).toBe('wh_dashboard');
		expect(ctx.staticData.createdByNode).toBe(false);
	});

	it('drops a stale secret when it adopts an endpoint it did not create', async () => {
		// An adopted endpoint's secret went to whoever registered it, so keeping a
		// previous one would make the handler verify against the wrong key and
		// reject every genuine delivery. Failing closed with no secret is correct.
		listWebhooks([webhook({ id: 'wh_dashboard' })]);

		const ctx = createHookContext({
			parameters: { events: ['run.completed'] },
			staticData: { webhookId: OUR_ID, createdByNode: true, webhookSecret: 'whsec_stale' },
		});

		await expect(methods.create.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);
		expect(ctx.staticData.webhookSecret).toBeUndefined();
		expect(ctx.staticData.createdByNode).toBe(false);
	});

	it('surfaces a registration failure that is not a slot conflict', async () => {
		listWebhooks([]);
		nock(BASE_URL)
			.post('/v1/webhooks')
			.reply(422, {
				error: { code: 'invalid_webhook_url', message: 'URL must be https and public.' },
			});

		const ctx = createHookContext({ parameters: { events: ['run.completed'] } });

		await expect(methods.create.call(ctx as unknown as IHookFunctions)).rejects.toMatchObject({
			message: 'Gluecrawl rejected the webhook URL',
		});
		expect(ctx.staticData.webhookId).toBeUndefined();
	});

	it('explains an unsaved workflow instead of calling the API', async () => {
		const ctx = createHookContext({
			parameters: { events: ['run.completed'] },
			webhookUrl: null,
		});

		await expect(methods.create.call(ctx as unknown as IHookFunctions)).rejects.toThrow(
			'n8n did not provide a webhook URL for this node',
		);
		expect(ctx.calls).toHaveLength(0);
	});
});

describe('trigger: delete', () => {
	useNock();

	it('deletes the endpoint this node created and clears the ownership record', async () => {
		listWebhooks([webhook()]);
		nock(BASE_URL).delete(`/v1/webhooks/${OUR_ID}`).reply(204);

		const ctx = createHookContext({
			parameters: { events: ['run.completed'] },
			staticData: { webhookId: OUR_ID, createdByNode: true },
		});

		await expect(methods.delete.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);

		const deletes = callsOf(ctx.calls, 'DELETE');
		expect(deletes).toHaveLength(1);
		expect(deletes[0].path).toBe(`/v1/webhooks/${OUR_ID}`);
		expect(ctx.staticData.webhookId).toBeUndefined();
		expect(ctx.staticData.createdByNode).toBeUndefined();
	});

	it('never deletes an adopted endpoint, but still forgets it', async () => {
		// The destructive-action guard: the endpoint belongs to the dashboard or
		// another workflow, and deleting it would break an integration this node
		// never owned. No interceptor is registered, so an attempted DELETE would
		// also fail on the disabled net connect.
		const ctx = createHookContext({
			parameters: { events: ['run.completed'] },
			staticData: { webhookId: OUR_ID, createdByNode: false },
		});

		await expect(methods.delete.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);

		expect(ctx.calls).toHaveLength(0);
		expect(ctx.staticData.webhookId).toBeUndefined();
		expect(ctx.staticData.createdByNode).toBeUndefined();
	});

	it('never deletes when the ownership flag is absent entirely', async () => {
		const ctx = createHookContext({
			parameters: { events: ['run.completed'] },
			staticData: { webhookId: OUR_ID },
		});

		await expect(methods.delete.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);
		expect(ctx.calls).toHaveLength(0);
	});

	it('does nothing when no endpoint was ever recorded', async () => {
		const ctx = createHookContext({ parameters: { events: ['run.completed'] } });

		await expect(methods.delete.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);
		expect(ctx.calls).toHaveLength(0);
	});

	it('treats a 404 as success — the endpoint is already gone', async () => {
		listWebhooks([webhook()]);
		nock(BASE_URL)
			.delete(`/v1/webhooks/${OUR_ID}`)
			.reply(404, { error: { code: 'not_found', message: 'Webhook not found.' } });

		const ctx = createHookContext({
			parameters: { events: ['run.completed'] },
			staticData: { webhookId: OUR_ID, createdByNode: true },
		});

		await expect(methods.delete.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);
		expect(ctx.staticData.webhookId).toBeUndefined();
	});

	it('does not delete an endpoint the user repointed at another destination', async () => {
		// PATCH can change an endpoint's url while keeping its id, so the ownership
		// record alone would still match. Deleting here tears down the user's
		// current, dashboard-configured destination.
		listWebhooks([webhook({ url: FOREIGN_URL })]);

		const ctx = createHookContext({
			parameters: { events: ['run.completed'] },
			staticData: { webhookId: OUR_ID, createdByNode: true },
		});

		await expect(methods.delete.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);
		expect(callsOf(ctx.calls, 'DELETE')).toHaveLength(0);
		expect(ctx.staticData.webhookId).toBeUndefined();
	});

	it('issues no DELETE when the recorded endpoint is no longer on the account', async () => {
		listWebhooks([]);

		const ctx = createHookContext({
			parameters: { events: ['run.completed'] },
			staticData: { webhookId: OUR_ID, createdByNode: true },
		});

		await expect(methods.delete.call(ctx as unknown as IHookFunctions)).resolves.toBe(true);
		expect(callsOf(ctx.calls, 'DELETE')).toHaveLength(0);
		expect(ctx.staticData.webhookId).toBeUndefined();
	});

	it('surfaces a deletion failure that is not a 404, and KEEPS the ownership record', async () => {
		// A stuck endpoint would keep delivering into a deactivated workflow, so
		// this one has to be loud. It also has to stay removable: forgetting
		// ownership here strands the endpoint in the account's single slot, since
		// the next activation would adopt it as somebody else's and no later
		// deactivation would ever delete it.
		listWebhooks([webhook()]);
		nock(BASE_URL)
			.delete(`/v1/webhooks/${OUR_ID}`)
			.reply(401, { error: { code: 'invalid_api_key', message: 'Invalid API key.' } });

		const ctx = createHookContext({
			parameters: { events: ['run.completed'] },
			staticData: { webhookId: OUR_ID, createdByNode: true },
		});

		await expect(methods.delete.call(ctx as unknown as IHookFunctions)).rejects.toMatchObject({
			message: 'Gluecrawl rejected the API key',
		});
		expect(ctx.staticData.webhookId).toBe(OUR_ID);
		expect(ctx.staticData.createdByNode).toBe(true);
	});

	it('keeps the ownership record when the account cannot even be listed', async () => {
		nock(BASE_URL).get('/v1/webhooks').reply(503, '<html>upstream</html>', {
			'content-type': 'text/html',
		});

		const ctx = createHookContext({
			parameters: { events: ['run.completed'] },
			staticData: { webhookId: OUR_ID, createdByNode: true },
		});

		await expect(methods.delete.call(ctx as unknown as IHookFunctions)).rejects.toMatchObject({
			message: 'Gluecrawl returned 503',
		});
		expect(ctx.staticData.webhookId).toBe(OUR_ID);
		expect(ctx.staticData.createdByNode).toBe(true);
	});
});

/**
 * The whole hazard end to end, in the order a user hits it: this node registers
 * the endpoint, the user replaces it from the dashboard against the same n8n
 * URL, and the workflow is later deactivated. Every step in isolation looks
 * correct; only the sequence shows the ownership flag laundering onto an
 * endpoint the node never created.
 */
describe('trigger: endpoint identity changes under a stable URL', () => {
	useNock();

	it('never deletes a dashboard-created endpoint that replaced ours', async () => {
		const staticData = {};

		// 1. Fresh activation on a free slot: the node creates the endpoint.
		listWebhooks([]);
		nock(BASE_URL)
			.post('/v1/webhooks')
			.reply(201, webhook({ id: 'wh_old' }));

		const activate = createHookContext({ parameters: { events: ['run.completed'] }, staticData });
		await methods.create.call(activate as unknown as IHookFunctions);
		expect(staticData).toEqual({ webhookId: 'wh_old', createdByNode: true });

		// 2. The user deletes it in the dashboard and re-creates it against the same
		//    URL, which mints a new id. 3. n8n restarts and re-activates.
		listWebhooks([webhook({ id: 'wh_dashboard' })]);
		const reactivate = createHookContext({ parameters: { events: ['run.completed'] }, staticData });
		await expect(methods.checkExists.call(reactivate as unknown as IHookFunctions)).resolves.toBe(
			true,
		);
		expect(staticData).toEqual({ webhookId: 'wh_dashboard', createdByNode: false });

		// 4. Deactivation must leave the user's endpoint alone.
		const deactivate = createHookContext({ parameters: { events: ['run.completed'] }, staticData });
		await expect(methods.delete.call(deactivate as unknown as IHookFunctions)).resolves.toBe(true);
		expect(callsOf(deactivate.calls, 'DELETE')).toHaveLength(0);
	});
});

/**
 * Both `isGluecrawlErrorCode` call sites in this node sit behind
 * `gluecrawlApiRequest`, which funnels every failure through
 * `toGluecrawlApiError` first. So the code has to survive that round trip, or
 * the `webhook_already_exists` recovery and the tolerated 404 above both become
 * dead branches — which is exactly what happened before the error mapper
 * learned the flat `{code, message, status}` shape a `NodeApiError` carries.
 *
 * Pinned here as well as through the two behaviours, so a regression points
 * straight at the cause rather than at the trigger.
 */
describe('error code detection through the transport', () => {
	it('recognises the code on an already-mapped NodeApiError', () => {
		const raw = {
			message: 'Request failed with status code 404',
			response: {
				status: 404,
				data: { error: { code: 'not_found', message: 'Webhook not found.' } },
				headers: {},
			},
		};

		expect(isGluecrawlErrorCode(raw, 'not_found')).toBe(true);
		expect(isGluecrawlErrorCode(toGluecrawlApiError(NODE, raw), 'not_found')).toBe(true);
	});
});
