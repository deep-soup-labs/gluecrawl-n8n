import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class GluecrawlApi implements ICredentialType {
	name = 'gluecrawlApi';

	displayName = 'Gluecrawl API';

	documentationUrl = 'https://www.gluecrawl.ai/docs/api';

	// Themed variants: the mark is a solid tile, so a single dark version would
	// disappear into n8n's dark canvas.
	icon: Icon = {
		light: 'file:gluecrawl.light.svg',
		dark: 'file:gluecrawl.dark.svg',
	};

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Your Gluecrawl API key. Every plan includes API access, Free included; an account has one active key at a time, minted in the Gluecrawl dashboard under Settings. Rotating the key in the dashboard invalidates the old one immediately.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.gluecrawl.ai',
			required: true,
			description:
				'Gluecrawl API base URL. Leave the default unless you were given a different host to target, such as a self-hosted or internal Gluecrawl deployment.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	/**
	 * `/v1` has no dedicated auth-check endpoint, so the cheapest authenticated
	 * read stands in for one. `limit=1` keeps it to a single row.
	 *
	 * The rules translate the two failures a correct-looking key still produces —
	 * an unverified account, and a plan without API access. Both arrive as a 403,
	 * so the rule has to name both causes; upgrading a plan does not fix an
	 * unverified email address.
	 *
	 * The base URL is normalised the same way `buildUrl` in the transport does —
	 * trailing slashes and an already-present `/v1` are both stripped. Without
	 * that, a Base URL of `https://api.gluecrawl.ai/v1` (a shape the transport
	 * accepts and the README promises) would test as `/v1/v1/jobs` -> 404 and
	 * report a perfectly good key as invalid.
	 */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.trim().replace(/\\/+$/, "").replace(/\\/v1$/, "")}}',
			url: '/v1/jobs',
			qs: { limit: 1 },
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message:
						'Gluecrawl rejected this API key. Check it against the key shown in the Gluecrawl dashboard, and confirm the Base URL points at the right environment.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 403,
					message:
						'The key was recognised but the account cannot use the API. Its email address is most likely unverified; the account may also be on a plan that does not include API access.',
				},
			},
		],
	};
}
