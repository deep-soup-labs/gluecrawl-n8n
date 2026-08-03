import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verification for the `X-Gluecrawl-Signature` header.
 *
 * Gluecrawl signs each delivery with the endpoint's secret, using the scheme
 * Stripe popularised:
 *
 *     X-Gluecrawl-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
 *
 * over `{timestamp}.{raw body}`. The signature covers the bytes as transmitted,
 * which is why this verifies against the RAW body string and never against a
 * re-serialised object: `JSON.stringify(JSON.parse(body))` reorders nothing in
 * practice but does drop whitespace, and either would produce a digest that
 * cannot match.
 *
 * Node's `crypto` is a built-in, not a dependency, so this does not breach the
 * zero-runtime-dependency rule that n8n Cloud verification imposes.
 */

export const SIGNATURE_HEADER = 'x-gluecrawl-signature';

/**
 * How far apart the delivery timestamp and local clock may be.
 *
 * Bounds replay: a captured delivery stops being accepted once it ages out.
 * Five minutes is loose enough to absorb ordinary clock skew between the API
 * host and the n8n host, which is not something a user can debug easily.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureVerdict =
	| { ok: true }
	| { ok: false; reason: string };

function parseHeader(headerValue: string): { timestamp?: string; signature?: string } {
	const parts: { timestamp?: string; signature?: string } = {};
	for (const piece of headerValue.split(',')) {
		const index = piece.indexOf('=');
		if (index === -1) continue;
		const key = piece.slice(0, index).trim();
		const value = piece.slice(index + 1).trim();
		if (key === 't') parts.timestamp = value;
		if (key === 'v1') parts.signature = value;
	}
	return parts;
}

/**
 * Constant-time compare that tolerates length mismatch.
 *
 * `timingSafeEqual` throws when the buffers differ in length, and letting that
 * throw would turn a malformed signature into a node crash rather than a clean
 * rejection.
 */
function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a, 'utf8');
	const right = Buffer.from(b, 'utf8');
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

export function computeSignature(secret: string, timestamp: string, rawBody: string): string {
	return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * Verify a delivery. Returns a reason rather than throwing so the caller can
 * decide the HTTP response and log something a user can act on.
 */
export function verifyDelivery(
	secret: string,
	headerValue: string | undefined,
	rawBody: string,
	nowSeconds: number,
): SignatureVerdict {
	if (!headerValue) {
		return { ok: false, reason: 'The delivery carried no signature header.' };
	}

	const { timestamp, signature } = parseHeader(headerValue);
	if (!timestamp || !signature) {
		return { ok: false, reason: 'The signature header was malformed.' };
	}

	const sent = Number(timestamp);
	if (!Number.isFinite(sent)) {
		return { ok: false, reason: 'The signature timestamp was not a number.' };
	}

	// Checked before the HMAC so an obviously stale replay is cheap to reject.
	if (Math.abs(nowSeconds - sent) > SIGNATURE_TOLERANCE_SECONDS) {
		return {
			ok: false,
			reason: `The delivery timestamp is outside the ${SIGNATURE_TOLERANCE_SECONDS}s tolerance. Check the clock on this n8n host.`,
		};
	}

	if (!safeEqual(computeSignature(secret, timestamp, rawBody), signature)) {
		return {
			ok: false,
			reason:
				'The signature did not match this endpoint secret. If the endpoint was recreated in the Gluecrawl dashboard, deactivate and reactivate this workflow to register a new one.',
		};
	}

	return { ok: true };
}
