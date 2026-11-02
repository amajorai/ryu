// Shared fixtures for the ryu.messaging tests (messaging.test.ts,
// messaging-errors.test.ts, messaging-lockstep.test.ts).
//
// Error bodies are built exactly as #777's `messagingErrorResponse`
// (packages/api/src/lib/messaging-auth.ts) renders them:
// `{ ...details, error: code, message }`, plus `retry-after` and
// `cache-control: no-store`. messaging-lockstep.test.ts pins that shape.

import { isRyuError, type RyuError } from "../errors.ts";
import { Ryu } from "../ryu.ts";

export const ORG = "64a0000000000000000000a1";
export const BASE = `https://api.ryuhq.com/api/messaging/orgs/${ORG}`;
export const ENV = {
	RYU_API_KEY: "ryu_messaging_secret",
	RYU_ORGANIZATION_ID: ORG,
};
export const NOW = "2026-10-21T12:00:00.000Z";
export const MESSAGE = {
	id: "msg_1",
	organizationId: ORG,
	channel: "sms",
	direction: "outbound",
	status: "accepted",
	from: "+15555550100",
	to: "+6591234567",
	isoCountryCode: "SG",
	numberId: "num_1",
	whatsappSenderId: null,
	body: "Shipped",
	bodyType: "text",
	encoding: "GSM",
	segments: 1,
	template: null,
	hasMedia: false,
	providerMessageId: "aws-1",
	providerStatus: null,
	providerStatusDescription: null,
	heldMicroUsd: 9000,
	priceMicroUsd: null,
	chargedMicroUsd: 0,
	absorbedMicroUsd: 0,
	chargeState: "held",
	estimated: false,
	ttlSeconds: null,
	metadata: {},
	error: null,
	createdAt: NOW,
	updatedAt: NOW,
};

export interface Recorded {
	body: string | null;
	headers: Headers;
	method: string;
	url: string;
}

export function stubFetch(
	respond: (request: Recorded, index: number) => Response
) {
	const calls: Recorded[] = [];
	const fetch = async (
		input: RequestInfo | URL,
		init?: RequestInit
	): Promise<Response> => {
		const request = new Request(input, init);
		const recorded: Recorded = {
			body: request.body === null ? null : await request.text(),
			headers: request.headers,
			method: request.method,
			url: request.url,
		};
		calls.push(recorded);
		return respond(recorded, calls.length - 1);
	};
	return { calls, fetch };
}

/** A refusal exactly as `messagingErrorResponse` renders a MessagingHttpError. */
export function refusal(
	status: number,
	code: string,
	message: string,
	options: {
		details?: Record<string, unknown>;
		headers?: Record<string, string>;
		retryAfterSeconds?: number;
	} = {}
): Response {
	const headers = new Headers({
		"cache-control": "no-store",
		"x-request-id": `req_${code}`,
		...options.headers,
	});
	if (options.retryAfterSeconds !== undefined) {
		headers.set("retry-after", String(options.retryAfterSeconds));
	}
	return Response.json(
		{ ...options.details, error: code, message },
		{ headers, status }
	);
}

export function ryuWith(fetch: ReturnType<typeof stubFetch>["fetch"]) {
	return new Ryu({ env: ENV, fetch });
}

export function ryuObject(fetch: ReturnType<typeof stubFetch>["fetch"]) {
	return new Ryu({ env: ENV, fetch, result: "object" });
}

export async function caught(promise: Promise<unknown>): Promise<RyuError> {
	try {
		await promise;
	} catch (error) {
		if (isRyuError(error)) {
			return error;
		}
		throw error;
	}
	throw new Error("expected the call to fail");
}

export const SMS = { from: "num_1", to: "+6591234567", body: "Shipped" };
export const STATUS = {
	apiVersion: "2026-10-01",
	configured: true,
	channels: { mms: true, sms: true, voice: true, whatsapp: false },
};

export const SETTINGS = {
	organizationId: ORG,
	webhookUrl: null,
	webhookSecretSet: false,
	allowedCountries: [],
	dailySendLimit: null,
	defaultDailySendLimit: 1000,
};
