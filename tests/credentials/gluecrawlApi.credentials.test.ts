/**
 * The credential is declarative, so the tests assert the declaration: the
 * pieces n8n reads at runtime (auth injection, the credential test) and the
 * pieces n8n Cloud verification reads at review time (password flag,
 * documentation URL, icon).
 *
 * The load-bearing assertion is the 403 rule. A 403 is two different failures —
 * an unverified email address and a plan without API access — and the rule has
 * to name both, or the user pays to fix the wrong one.
 */

import type { INodeProperties } from 'n8n-workflow';

import { GluecrawlApi } from '../../credentials/GluecrawlApi.credentials';
import { buildUrl } from '../../nodes/Gluecrawl/transport';
import { DEFAULT_BASE_URL } from '../../nodes/Gluecrawl/types';

const credential = new GluecrawlApi();

function property(name: string): INodeProperties {
	const found = credential.properties.find((entry) => entry.name === name);
	if (!found) throw new Error(`Credential has no "${name}" property`);
	return found;
}

describe('GluecrawlApi credential', () => {
	it('registers under the name the transport asks for', () => {
		expect(credential.name).toBe('gluecrawlApi');
		expect(credential.displayName).toBe('Gluecrawl API');
		expect(credential.documentationUrl).toMatch(/^https:\/\//);
		// Themed SVG variants, not a single PNG: the verification scan errors on a
		// PNG icon, and a solid dark tile vanishes into n8n's dark canvas.
		expect(credential.icon).toEqual({
			light: 'file:gluecrawl.light.svg',
			dark: 'file:gluecrawl.dark.svg',
		});
	});

	it('masks the API key', () => {
		const apiKey = property('apiKey');

		expect(apiKey.type).toBe('string');
		expect(apiKey.required).toBe(true);
		expect(apiKey.typeOptions?.password).toBe(true);
	});

	it('defaults the base URL to production', () => {
		const baseUrl = property('baseUrl');

		expect(baseUrl.default).toBe(DEFAULT_BASE_URL);
		expect(baseUrl.required).toBe(true);
		// Not a secret: masking it would hide which environment a workflow targets.
		expect(baseUrl.typeOptions?.password).toBeUndefined();
	});

	it('sends the key as a bearer token', () => {
		expect(credential.authenticate).toEqual({
			type: 'generic',
			properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
		});
	});

	it('tests the credential with the cheapest authenticated read', () => {
		expect(credential.test.request).toMatchObject({
			url: '/v1/jobs',
			qs: { limit: 1 },
		});
		// A GET, so the check itself is neither rate limited nor billable.
		expect(credential.test.request.method ?? 'GET').toBe('GET');
	});

	/**
	 * The credential test and the transport have to agree on what a Base URL
	 * means, or a supported one (`https://api.gluecrawl.ai/v1`, which `buildUrl`
	 * deliberately accepts and the README advertises) reports a working key as
	 * invalid while every operation on the node succeeds.
	 *
	 * n8n evaluates the expression, not this test, and building a `Function` from
	 * the string to evaluate it here is exactly what the community-nodes lint
	 * rules forbid. So the two halves are pinned instead: the expression is
	 * asserted to be this chain, and the chain — the SAME regex objects, rendered
	 * into it — is asserted to agree with `buildUrl` on every shape.
	 */
	describe('base URL normalisation matches the transport', () => {
		const TRAILING_SLASHES = /\/+$/;
		const TRAILING_V1 = /\/v1$/;

		function normalise(baseUrl: string): string {
			return baseUrl.trim().replace(TRAILING_SLASHES, '').replace(TRAILING_V1, '');
		}

		it('drives the test request through that normalisation', () => {
			expect(credential.test.request.baseURL).toBe(
				`={{$credentials.baseUrl.trim().replace(${TRAILING_SLASHES}, "").replace(${TRAILING_V1}, "")}}`,
			);
		});

		it.each([
			DEFAULT_BASE_URL,
			`${DEFAULT_BASE_URL}/`,
			`${DEFAULT_BASE_URL}///`,
			`${DEFAULT_BASE_URL}/v1`,
			`${DEFAULT_BASE_URL}/v1/`,
			'  https://gluecrawl.internal.example.com/v1  ',
			'https://gluecrawl.internal.example.com',
		])('resolves %p to the same URL the transport would build', (baseUrl) => {
			expect(`${normalise(baseUrl)}/v1/jobs`).toBe(buildUrl(baseUrl, '/v1/jobs'));
		});
	});

	it('explains a 401 without guessing at the cause', () => {
		const rule = credential.test.rules?.find(
			(entry) => entry.type === 'responseCode' && entry.properties.value === 401,
		);

		expect(rule?.properties.message).toMatch(/API key/i);
		expect(rule?.properties.message).toMatch(/Base URL/i);
	});

	it('names both 403 causes', () => {
		const rule = credential.test.rules?.find(
			(entry) => entry.type === 'responseCode' && entry.properties.value === 403,
		);
		const message = String(rule?.properties.message);

		// Every plan includes the API, so the message must not name a tier to
		// upgrade to — that would send a user to buy what they already have.
		expect(message).not.toMatch(/Starter/);
		expect(message).toMatch(/API access/);
		// 403 is two different failures; both have to be named or the user
		// upgrades a plan when the real problem was an unverified email.
		expect(message).toMatch(/unverified|verif/i);
	});
});
