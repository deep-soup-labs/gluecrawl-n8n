/**
 * Delivery authentication.
 *
 * The signature is the only thing standing between "Gluecrawl said so" and
 * "anything that can reach this URL said so", so every rejection path is
 * asserted explicitly. Failing closed is safe because deliveries are retried:
 * a rejection caused by a transient fault is re-attempted, not lost.
 */

import type { IWebhookFunctions } from 'n8n-workflow';

import { GluecrawlTrigger } from '../../nodes/GluecrawlTrigger/GluecrawlTrigger.node';
import {
	SIGNATURE_HEADER,
	SIGNATURE_TOLERANCE_SECONDS,
	computeSignature,
	verifyDelivery,
} from '../../nodes/GluecrawlTrigger/signature';
import { createHookContext, useNock } from '../helpers';

useNock();

const trigger = new GluecrawlTrigger();
const SECRET = 'whsec_test_endpoint_secret';

const PAYLOAD = {
	id: 'evt_123',
	type: 'webhook.test',
	api_version: '1',
	created_at: '2026-01-01T00:05:01Z',
	data: {},
};

function signedContext(
	overrides: {
		secret?: string;
		signingSecret?: string;
		skewSeconds?: number;
		header?: string | undefined;
		body?: unknown;
		rawBody?: string;
	} = {},
) {
	const body = overrides.body ?? PAYLOAD;
	const rawBody = overrides.rawBody ?? JSON.stringify(body);
	const timestamp = `${Math.floor(Date.now() / 1000) + (overrides.skewSeconds ?? 0)}`;
	const signingSecret = overrides.signingSecret ?? SECRET;

	const header =
		overrides.header !== undefined
			? overrides.header
			: `t=${timestamp},v1=${computeSignature(signingSecret, timestamp, rawBody)}`;

	return createHookContext({
		parameters: { jobId: '' },
		body,
		rawBody,
		headers: header === '' ? {} : { [SIGNATURE_HEADER]: header },
		staticData:
			overrides.secret === undefined ? { webhookSecret: SECRET } : { webhookSecret: overrides.secret },
	});
}

async function run(ctx: ReturnType<typeof createHookContext>) {
	return trigger.webhook.call(ctx as unknown as IWebhookFunctions);
}

describe('trigger: delivery signature', () => {
	it('accepts a correctly signed delivery', async () => {
		const result = await run(signedContext());
		expect(result.workflowData?.[0]?.[0]?.json).toMatchObject({ test: true });
	});

	it('rejects a forged body signed with the wrong secret', async () => {
		await expect(run(signedContext({ signingSecret: 'whsec_attacker' }))).rejects.toThrow(
			'Rejected an unverified Gluecrawl delivery',
		);
	});

	it('rejects a body altered after signing', async () => {
		// Signature computed over the original bytes, a different body delivered.
		const rawBody = JSON.stringify(PAYLOAD);
		const timestamp = `${Math.floor(Date.now() / 1000)}`;
		const ctx = createHookContext({
			parameters: { jobId: '' },
			body: { ...PAYLOAD, type: 'run.completed' },
			rawBody: JSON.stringify({ ...PAYLOAD, type: 'run.completed' }),
			headers: { [SIGNATURE_HEADER]: `t=${timestamp},v1=${computeSignature(SECRET, timestamp, rawBody)}` },
			staticData: { webhookSecret: SECRET },
		});

		await expect(run(ctx)).rejects.toThrow('Rejected an unverified Gluecrawl delivery');
	});

	it('rejects a delivery carrying no signature at all', async () => {
		await expect(run(signedContext({ header: '' }))).rejects.toMatchObject({
			description: expect.stringContaining('no signature header'),
		});
	});

	it('rejects a malformed signature header instead of crashing', async () => {
		await expect(run(signedContext({ header: 'garbage' }))).rejects.toMatchObject({
			description: expect.stringContaining('malformed'),
		});
	});

	it('rejects a replayed delivery once it ages past the tolerance', async () => {
		await expect(
			run(signedContext({ skewSeconds: -(SIGNATURE_TOLERANCE_SECONDS + 60) })),
		).rejects.toMatchObject({
			description: expect.stringContaining('tolerance'),
		});
	});

	it('accepts clock skew inside the tolerance', async () => {
		const result = await run(signedContext({ skewSeconds: SIGNATURE_TOLERANCE_SECONDS - 30 }));
		expect(result.workflowData?.[0]?.[0]?.json).toMatchObject({ test: true });
	});

	it('fails closed when the workflow has no secret for its endpoint', async () => {
		// An adopted endpoint. Emitting unverified items here would make adoption
		// a hole straight through the signature check.
		await expect(run(signedContext({ secret: '' }))).rejects.toMatchObject({
			description: expect.stringContaining('no signing secret'),
		});
	});

	it('fails closed when the raw body is unavailable', async () => {
		const ctx = createHookContext({
			parameters: { jobId: '' },
			body: PAYLOAD,
			headers: { [SIGNATURE_HEADER]: 't=1,v1=abc' },
			staticData: { webhookSecret: SECRET },
		});
		// Model an n8n build that did not populate rawBody.
		ctx.getRequestObject = jest.fn(() => ({ body: PAYLOAD })) as never;

		await expect(run(ctx)).rejects.toMatchObject({
			description: expect.stringContaining('raw request body'),
		});
	});
});

describe('verifyDelivery', () => {
	const rawBody = '{"id":"evt_1"}';

	it('matches a digest computed the way the docs describe', () => {
		const timestamp = '1785000000';
		const header = `t=${timestamp},v1=${computeSignature(SECRET, timestamp, rawBody)}`;
		expect(verifyDelivery(SECRET, header, rawBody, Number(timestamp))).toEqual({ ok: true });
	});

	it('is not fooled by a signature of the right length but wrong value', () => {
		const timestamp = '1785000000';
		const real = computeSignature(SECRET, timestamp, rawBody);
		const forged = real.slice(0, -1) + (real.endsWith('a') ? 'b' : 'a');
		expect(
			verifyDelivery(SECRET, `t=${timestamp},v1=${forged}`, rawBody, Number(timestamp)),
		).toMatchObject({ ok: false });
	});

	it('rejects a header missing the version tag', () => {
		expect(verifyDelivery(SECRET, 't=1785000000', rawBody, 1785000000)).toMatchObject({
			ok: false,
		});
	});
});
