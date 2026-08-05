/**
 * Starts a workflow when Gluecrawl finishes a run or settles a job's mapping.
 *
 * Two rules shape this whole file:
 *
 * 1. An account holds several webhook endpoints, so this workflow registers its
 *    OWN rather than competing for a slot. The lifecycle stays
 *    adopt-don't-clobber regardless: it reuses only an endpoint already aimed
 *    here, and deletes only one it created. The others belong to other
 *    workflows or to the dashboard.
 * 2. Deliveries are SIGNED (HMAC-SHA256 over the raw body, see ./signature) and
 *    retried on failure. A delivery whose signature does not verify is rejected
 *    outright, which is what lets the payload be trusted on its own instead of
 *    being re-fetched purely to authenticate it.
 *
 * The handler still answers quickly: the API abandons an attempt after 10s, and
 * a timeout burns one of the delivery's bounded retries for nothing.
 */

import {
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IHookFunctions,
	type INode,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';

import {
	WEBHOOK_EVENT_TYPES,
	type Job,
	type Run,
	type Webhook,
	type WebhookEventType,
	type WebhookListResponse,
	type WebhookPayload,
	type WebhookPayloadData,
} from '../Gluecrawl/types';

import { searchJobs } from '../Gluecrawl/methods';
import { jobFilterLocator } from '../Gluecrawl/resources/locators';
import { gluecrawlApiRequest } from '../Gluecrawl/transport';
import {
	isGluecrawlErrorCode,
	parseGluecrawlError,
	toGluecrawlApiError,
} from '../Gluecrawl/transport/errors';
import { SIGNATURE_HEADER, verifyDelivery } from './signature';

/**
 * Budget for the verify-then-emit fetch. Gluecrawl abandons a delivery after
 * 10s and never retries, so the fetch has to fail fast enough to leave room for
 * a response.
 */
const VERIFY_TIMEOUT_MS = 7_000;

const DASHBOARD_WEBHOOKS_URL = 'https://www.gluecrawl.ai/dashboard/settings';

/** Shape this node keeps in workflow static data, scoped to the node. */
interface TriggerStaticData extends IDataObject {
	/** Gluecrawl's id for the endpoint currently pointing at this workflow. */
	webhookId?: string;
	/**
	 * True only when THIS node registered the endpoint. Adopted endpoints stay
	 * false so deactivation never deletes someone else's configuration.
	 */
	createdByNode?: boolean;
	/**
	 * The endpoint's signing secret, disclosed once at creation. Present only
	 * for endpoints this node created; an adopted endpoint's secret went to
	 * whoever created it, so its deliveries cannot be verified here.
	 */
	webhookSecret?: string;
}

/** n8n and Gluecrawl disagree on trailing slashes often enough to matter. */
function normalizeWebhookUrl(url: string): string {
	return url.trim().replace(/\/+$/, '');
}

function sameEventSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const left = [...a].sort();
	const right = [...b].sort();
	return left.every((value, index) => value === right[index]);
}

/**
 * Validates the selected events. The API accepts 1-4 unique values; n8n's
 * multiOptions widget enforces neither, so dedupe and reject an empty set here
 * rather than letting the user discover it as a 422 on activation.
 */
function resolveEvents(node: INode, raw: unknown): WebhookEventType[] {
	const values = Array.isArray(raw) ? raw : [];
	const events = [
		...new Set(
			values.filter((value): value is WebhookEventType =>
				WEBHOOK_EVENT_TYPES.includes(value as WebhookEventType),
			),
		),
	];

	if (events.length === 0) {
		throw new NodeOperationError(node, 'Select at least one Gluecrawl event', {
			description:
				'The Events parameter is empty, so Gluecrawl would have nothing to deliver. Pick at least one of "Run Completed", "Run Failed", "Job Ready" or "Job Failed".',
		});
	}

	return events;
}

/** Lists the account's webhook endpoints. There may be several. */
async function listWebhooks(this: IHookFunctions): Promise<Webhook[]> {
	const response = (await gluecrawlApiRequest.call(
		this,
		'GET',
		'/v1/webhooks',
		undefined,
		undefined,
		{ context: 'While checking the Gluecrawl webhook endpoint' },
	)) as WebhookListResponse;

	return Array.isArray(response?.data) ? response.data : [];
}

/**
 * Brings an endpoint that already points at this workflow in line with the
 * node's parameters.
 *
 * `enabled: false` counts as drift: a disabled endpoint aimed at this workflow
 * delivers nothing, and the trigger would sit there looking active while never
 * firing.
 */
async function reconcileWebhook(
	this: IHookFunctions,
	webhook: Webhook,
	events: WebhookEventType[],
): Promise<void> {
	const eventsMatch = sameEventSet(webhook.events ?? [], events);
	if (eventsMatch && webhook.enabled !== false) return;

	await gluecrawlApiRequest.call(
		this,
		'PATCH',
		`/v1/webhooks/${webhook.id}`,
		{ events, enabled: true },
		undefined,
		{ context: 'While updating the Gluecrawl webhook endpoint' },
	);
}

/**
 * Authenticate one inbound delivery against the endpoint secret.
 *
 * Two cases fail closed rather than degrading to "emit it anyway":
 *
 * - No stored secret. That means the endpoint was adopted rather than created
 *   here, so its secret went to whoever created it. Emitting unverified items
 *   would make an adopted endpoint a hole in the check.
 * - No raw body available. The signature covers transmitted bytes; verifying a
 *   re-serialised object would either spuriously fail or, worse, pass on a body
 *   different from the one signed.
 */
function verifyInboundDelivery(
	this: IWebhookFunctions,
	staticData: TriggerStaticData,
): { ok: true } | { ok: false; reason: string } {
	const secret = typeof staticData.webhookSecret === 'string' ? staticData.webhookSecret : '';
	if (!secret) {
		return {
			ok: false,
			reason:
				'This workflow has no signing secret for its Gluecrawl webhook endpoint, so deliveries cannot be authenticated. Gluecrawl discloses the secret only when the endpoint is registered, so deactivate and reactivate this workflow to register one it owns.',
		};
	}

	const headers = this.getHeaderData() as Record<string, string | undefined>;
	// n8n augments http.IncomingMessage with `rawBody`, which is the only place
	// the transmitted bytes survive -- getBodyData() hands back a parsed object.
	const request = this.getRequestObject() as unknown as { rawBody?: Buffer | string };
	const rawBody = request?.rawBody;
	if (rawBody === undefined) {
		return {
			ok: false,
			reason:
				'The raw request body was not available, so the delivery signature could not be checked against the bytes that were signed.',
		};
	}

	return verifyDelivery(
		secret,
		headers[SIGNATURE_HEADER],
		typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'),
		Math.floor(Date.now() / 1000),
	);
}

/**
 * Raised when the account has no room for another endpoint.
 *
 * Deliberately not resolved by deleting someone else's endpoint: the others
 * belong to other workflows or to the dashboard, and picking one to evict would
 * break an integration this node never owned.
 */
function endpointLimitError(node: INode, error: unknown): NodeOperationError {
	const limit = parseGluecrawlError(error).extras?.limit;
	const cap = typeof limit === 'number' ? `${limit}` : 'its';
	return new NodeOperationError(node, 'The Gluecrawl account has no free webhook endpoint slots', {
		description: `This account has reached ${cap} webhook endpoint limit, so this workflow could not register its own. Delete an endpoint you no longer need in the Gluecrawl dashboard (${DASHBOARD_WEBHOOKS_URL}), or deactivate a workflow that owns one, then activate this workflow again.`,
	});
}

export class GluecrawlTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Gluecrawl Trigger',
		name: 'gluecrawlTrigger',
		icon: {
			light: 'file:gluecrawl.light.svg',
			dark: 'file:gluecrawl.dark.svg',
		},
		group: ['trigger'],
		version: 1,
		// Guarded against an empty selection so the canvas label never renders an
		// expression error while the node is still being configured.
		subtitle: '={{ ($parameter["events"] || []).join(", ") }}',
		description: 'Starts the workflow when a Gluecrawl run finishes or a job finishes mapping',
		documentationUrl: 'https://www.gluecrawl.ai/docs/api',
		// Declared explicitly, and explicitly not a tool: an AI agent calls the
		// Gluecrawl action node, which has an `execute`. A trigger only has a
		// `webhook`, so wrapping it as a tool would offer agents a node that
		// cannot be invoked. The property is typed `true | UsableAsToolDescription`
		// upstream, so `undefined` is the only way to state the intent in code
		// rather than leaving the reader to infer it from an omission.
		usableAsTool: undefined,
		defaults: {
			name: 'Gluecrawl Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'gluecrawlApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		eventTriggerDescription: 'Waiting for a Gluecrawl webhook delivery',
		activationMessage:
			'This workflow now receives Gluecrawl events. Every delivery is signature-checked before it reaches the next node.',
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['run.completed'],
				description:
					'Which Gluecrawl events should start this workflow. Gluecrawl accepts between one and four.',
				options: [
					{
						name: 'Job Failed',
						value: 'job.failed',
						description:
							'A job could not be mapped, or a scrape found nothing. Terminal: the job needs replacing, not retrying.',
					},
					{
						name: 'Job Ready',
						value: 'job.ready',
						description:
							'A job finished mapping and can now be run without paying the mapping cost again',
					},
					{
						name: 'Run Completed',
						value: 'run.completed',
						description: 'A run finished successfully and its extracted rows are available',
					},
					{
						name: 'Run Failed',
						value: 'run.failed',
						description: 'A run stopped with an error. Its credits are refunded automatically.',
					},
				],
			},
			jobFilterLocator(
				'Only start the workflow for events belonging to this job. Leave it empty to receive events for every job on the account. Filtering happens in n8n — a webhook endpoint subscribes to event types, not to jobs, so Gluecrawl delivers every subscribed event regardless.',
			),
		],
	};

	/**
	 * Edit-time method behind the Job filter. Shared verbatim with the action
	 * node: the picker has to list the same jobs from the same credential, and a
	 * trigger-local copy would only be a second place for the label format and
	 * the scan bounds to drift.
	 */
	methods = {
		listSearch: {
			searchJobs,
		},
	};

	webhookMethods = {
		default: {
			/**
			 * True when the account's endpoint already points at this workflow.
			 *
			 * Also the reconciliation point: n8n calls this before `create` on every
			 * activation, so an endpoint whose event set drifted (parameters edited
			 * while deactivated) is brought back in line here.
			 */
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const node = this.getNode();
				const staticData = this.getWorkflowStaticData('node') as TriggerStaticData;
				const webhookUrl = this.getNodeWebhookUrl('default');

				if (!webhookUrl) return false;

				const events = resolveEvents(node, this.getNodeParameter('events'));
				const existing = (await listWebhooks.call(this)).find(
					(webhook) => normalizeWebhookUrl(webhook.url ?? '') === normalizeWebhookUrl(webhookUrl),
				);

				if (!existing) {
					// The endpoint we knew about is gone (deleted in the dashboard, or the
					// slot was reassigned). Drop the stale ownership record so `delete`
					// never targets an id that now belongs to someone else, and the secret
					// with it -- it authenticated that endpoint and nothing else.
					delete staticData.webhookId;
					delete staticData.createdByNode;
					delete staticData.webhookSecret;
					return false;
				}

				await reconcileWebhook.call(this, existing, events);

				// Ownership belongs to the ENDPOINT, not to this node, so it has to be
				// re-derived BEFORE the id is overwritten. A user who deletes the
				// endpoint in the dashboard and re-creates it against the same n8n URL
				// gets a fresh id (ids are UUID primary keys and are never reused);
				// carrying the flag across that identity change would let a later
				// deactivation delete an endpoint the user created.
				const owned = staticData.createdByNode === true && staticData.webhookId === existing.id;
				const sameEndpoint = staticData.webhookId === existing.id;

				staticData.webhookId = existing.id;
				// Still sticky in the other direction: only `create` may promote to true.
				staticData.createdByNode = owned;
				// A different id at the same URL is a different endpoint with a different
				// secret. Keeping the old one would fail every signature check while
				// looking configured; dropping it makes the handler fail closed with the
				// message that tells the user to re-register.
				if (!sameEndpoint) {
					delete staticData.webhookSecret;
				}
				return true;
			},

			/**
			 * Registers this workflow as the account's webhook endpoint.
			 *
			 * An account holds several endpoints, so this registers its own rather
			 * than competing for a single slot. It still never adopts ownership of an
			 * endpoint pointing elsewhere: only an endpoint already aimed at THIS
			 * workflow URL is reused, and only one this node created is ever deleted.
			 */
			async create(this: IHookFunctions): Promise<boolean> {
				const node = this.getNode();
				const staticData = this.getWorkflowStaticData('node') as TriggerStaticData;
				const webhookUrl = this.getNodeWebhookUrl('default');

				if (!webhookUrl) {
					throw new NodeOperationError(node, 'n8n did not provide a webhook URL for this node', {
						description:
							'This usually means the workflow was not saved before activation. Save the workflow and activate it again.',
					});
				}

				const events = resolveEvents(node, this.getNodeParameter('events'));
				// Only an endpoint already pointing HERE is ours to reuse. Endpoints
				// belonging to other workflows or to the dashboard are simply ignored.
				const existing = (await listWebhooks.call(this)).find(
					(webhook) => normalizeWebhookUrl(webhook.url ?? '') === normalizeWebhookUrl(webhookUrl),
				);

				if (existing) {
					await reconcileWebhook.call(this, existing, events);
					// Same identity guard as `checkExists`: the flag may only survive
					// when the endpoint it was recorded against is still the one here.
					const owned = staticData.createdByNode === true && staticData.webhookId === existing.id;
					staticData.webhookId = existing.id;
					staticData.createdByNode = owned;
					// An adopted endpoint's secret was disclosed only to whoever created
					// it, so we cannot verify its deliveries. Drop any stale secret so
					// the webhook handler fails closed rather than against a wrong key.
					delete staticData.webhookSecret;
					return true;
				}

				let created: Webhook;
				try {
					created = (await gluecrawlApiRequest.call(
						this,
						'POST',
						'/v1/webhooks',
						{ url: webhookUrl, events },
						undefined,
						{ context: 'While registering the Gluecrawl webhook endpoint' },
					)) as Webhook;
				} catch (error) {
					if (isGluecrawlErrorCode(error, 'webhook_limit_reached')) {
						throw endpointLimitError(node, error);
					}
					throw toGluecrawlApiError(node, error, {
						context: 'While registering the Gluecrawl webhook endpoint',
					});
				}

				staticData.webhookId = created.id;
				staticData.createdByNode = true;
				// Disclosed exactly once, in this response. Losing it means deliveries
				// can no longer be verified, so it is persisted with the ownership record.
				if (typeof created.secret === 'string') {
					staticData.webhookSecret = created.secret;
				} else {
					delete staticData.webhookSecret;
				}
				return true;
			},

			/**
			 * Removes the endpoint only if this node created it AND it still points
			 * here.
			 *
			 * An adopted endpoint belongs to the dashboard or another workflow, and
			 * deleting it on deactivation would break an integration this node never
			 * owned. The recorded id is not sufficient on its own: `PATCH` can change
			 * an endpoint's `url` while keeping its id, so an endpoint the user
			 * repointed at their own receiver would still match the ownership record.
			 * The extra `GET /v1/webhooks` is free — reads are not rate limited at the
			 * v1 layer — and it is the only thing standing between a deactivation and
			 * a destroyed integration.
			 */
			async delete(this: IHookFunctions): Promise<boolean> {
				const node = this.getNode();
				const staticData = this.getWorkflowStaticData('node') as TriggerStaticData;
				const webhookId = typeof staticData.webhookId === 'string' ? staticData.webhookId : '';
				const createdByNode = staticData.createdByNode === true;

				// The secret goes with the endpoint. Leaving it behind would let the
				// next activation verify deliveries from a DIFFERENT endpoint (same
				// URL, new id, new secret) against the old key, and every delivery
				// would be rejected until the user deactivated again.
				const forget = (): void => {
					delete staticData.webhookId;
					delete staticData.createdByNode;
					delete staticData.webhookSecret;
				};

				if (!webhookId || !createdByNode) {
					forget();
					return true;
				}

				const webhookUrl = this.getNodeWebhookUrl('default');
				const listed = (await listWebhooks.call(this)).find((entry) => entry.id === webhookId);

				// Already gone, or repointed elsewhere by its owner. Either way there is
				// nothing here left to remove.
				if (
					!listed ||
					(webhookUrl !== undefined &&
						normalizeWebhookUrl(listed.url ?? '') !== normalizeWebhookUrl(webhookUrl))
				) {
					forget();
					return true;
				}

				try {
					await gluecrawlApiRequest.call(
						this,
						'DELETE',
						`/v1/webhooks/${webhookId}`,
						undefined,
						undefined,
						{ context: 'While removing the Gluecrawl webhook endpoint' },
					);
				} catch (error) {
					// Already gone is the outcome we wanted; anything else has to surface,
					// otherwise a stuck endpoint keeps delivering into a dead workflow.
					const alreadyGone = isGluecrawlErrorCode(error, 'not_found');
					if (!alreadyGone) {
						// Ownership deliberately survives a failed delete. Clearing it first
						// would leave the endpoint registered in the account's single slot
						// with nothing left that is allowed to remove it: the next
						// activation would adopt it as someone else's and every later
						// deactivation would skip it forever.
						throw toGluecrawlApiError(node, error, {
							context: 'While removing the Gluecrawl webhook endpoint',
						});
					}
				}

				forget();
				return true;
			},
		},
	};

	/**
	 * Authenticate the delivery, then emit it.
	 *
	 * The signature is what makes the payload trustworthy, so it is checked
	 * first and a failure is refused outright -- emitting an unverifiable item
	 * would hand a forger a workflow trigger. The subsequent API fetch is an
	 * enrichment (the payload carries only ids and statuses), no longer the
	 * thing that establishes authenticity.
	 *
	 * Failing closed is safe here because deliveries are retried: a rejection
	 * caused by a transient problem is re-attempted rather than lost.
	 */
	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const node = this.getNode();
		const staticData = this.getWorkflowStaticData('node') as TriggerStaticData;
		const payload = this.getBodyData() as unknown as Partial<WebhookPayload>;
		const eventType = typeof payload?.type === 'string' ? payload.type : 'unknown';
		const eventId = typeof payload?.id === 'string' ? payload.id : undefined;
		const data: WebhookPayloadData =
			typeof payload?.data === 'object' && payload.data !== null ? payload.data : {};

		const verdict = verifyInboundDelivery.call(this, staticData);
		if (!verdict.ok) {
			// 401 rather than a silent 200: the API records the failure, surfaces it
			// in the delivery log, and retries -- all of which a user can see and
			// act on. Answering 200 would discard the event and report success.
			throw new NodeOperationError(node, 'Rejected an unverified Gluecrawl delivery', {
				description: verdict.reason,
				level: 'warning',
			});
		}

		const envelope: IDataObject = {
			event: eventType,
			...(eventId !== undefined ? { event_id: eventId } : {}),
			...(typeof payload?.created_at === 'string' ? { event_created_at: payload.created_at } : {}),
		};

		// A test delivery carries no job or run to verify, and it is the only way a
		// user can confirm the wiring, so it bypasses the Job ID filter below.
		if (eventType === 'webhook.test') {
			return {
				workflowData: [
					[
						{
							json: {
								...envelope,
								test: true,
								verified: false,
								message:
									'Test delivery from Gluecrawl. The webhook endpoint is wired to this workflow. Real events are re-fetched from the API before they are emitted.',
							},
						},
					],
				],
			};
		}

		// Cheapest rejection first: no credential read, no API call.
		// `extractValue` unwraps the resource locator; it is a passthrough for a
		// plain string, so a value arriving from an expression reads the same.
		const jobIdFilter = String(
			this.getNodeParameter('jobId', '', { extractValue: true }) ?? '',
		).trim();
		if (jobIdFilter && data.job_id !== jobIdFilter) {
			// Acknowledged with 200 and dropped. Answering anything else would make
			// Gluecrawl record a delivery failure for an event we deliberately ignored.
			return {};
		}

		const runId = typeof data.run_id === 'string' ? data.run_id : undefined;
		const jobId = typeof data.job_id === 'string' ? data.job_id : undefined;
		// The event prefix, not the ids, picks the endpoint. A `run.*` payload also
		// carries `job_id`, and falling back to the job would emit a Job under a Run
		// event label — the downstream node would read the wrong `status`.
		const verifyRun = eventType.startsWith('run.') && runId !== undefined;
		const verifyJob = eventType.startsWith('job.') && jobId !== undefined;

		if (!verifyRun && !verifyJob) {
			// An event shape this version does not understand, or one missing its ids.
			// Emitted unverified rather than dropped, for the reason below.
			return {
				workflowData: [
					[
						{
							json: {
								...envelope,
								...(data as IDataObject),
								verified: false,
								verification_error:
									'The delivery did not reference a run or job that could be verified against the API.',
							},
						},
					],
				],
			};
		}

		try {
			const endpoint = verifyRun ? `/v1/runs/${runId}` : `/v1/jobs/${jobId}`;
			const record = (await gluecrawlApiRequest.call(this, 'GET', endpoint, undefined, undefined, {
				timeout: VERIFY_TIMEOUT_MS,
				context: 'While verifying the Gluecrawl webhook delivery',
			})) as Run | Job;

			return {
				workflowData: [
					[{ json: { ...(record as unknown as IDataObject), ...envelope, verified: true } }],
				],
			};
		} catch (error) {
			// Emit unverified rather than nothing. Gluecrawl attempts each delivery
			// exactly once and never retries, so a transient failure here would lose
			// the event permanently and silently. The item is flagged `verified:
			// false` and carries only the ids and statuses from the signed payload,
			// so a workflow can branch on the flag and re-fetch itself. Re-raising is
			// not an option either: the delivery must be answered within 10s.
			const mapped = toGluecrawlApiError(node, error, {
				context: 'While verifying the Gluecrawl webhook delivery',
			});

			return {
				workflowData: [
					[
						{
							json: {
								...envelope,
								...(data as IDataObject),
								verified: false,
								verification_error: mapped.message,
							},
						},
					],
				],
			};
		}
	}
}
