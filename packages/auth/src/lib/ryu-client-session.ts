/**
 * Which Ryu client a Better Auth session was issued to.
 *
 * Ryu Desktop/Core, the CLI, and the MCP bridge sign in through the RFC 8628
 * device-authorization grant and receive an ordinary session token. Without a
 * marker that token is indistinguishable from a browser sign-in. This plugin
 * stamps `session.issuedClientId` at creation time, server-side only:
 *
 * - The value is taken from the `/device/token` request ONLY while that
 *   endpoint is creating the session. By then Better Auth has validated the
 *   client id against the allowlist and consumed the device code with a
 *   `clientId = client_id` ownership predicate, so the stamped id is the one
 *   the approved device-code grant was created for. No request header is read.
 * - The field is `input: false`, so no Better Auth endpoint accepts it from a
 *   caller. Browser sign-ins (email, social, passkey, the website's own
 *   `/device/session` cookie redemption) never pass through this path and stay
 *   unmarked.
 *
 * This is a provenance signal, not attestation: a client id is public, so a
 * determined account owner can run the device flow by hand or replay their own
 * client's token. Callers use it as a strong nudge toward the Ryu clients.
 */
import type { BetterAuthPlugin } from "better-auth";

/** Session field holding the device-authorization client id. */
export const ISSUED_CLIENT_ID_FIELD = "issuedClientId";

/** Better Auth's RFC 8628 token endpoint, the only path that stamps a client. */
const DEVICE_TOKEN_PATH = "/device/token";

/**
 * Ryu clients that run the user's agent: Desktop (and the Core runtime it
 * hosts), the CLI, and the MCP bridge. Other device-flow clients (browser
 * extension, mobile) are recorded on the session but are not agents.
 */
export const RYU_AGENT_CLIENT_IDS: readonly string[] = [
	"ryu-desktop",
	"ryu-cli",
	"ryu-mcp",
];

const MAX_CLIENT_ID_LENGTH = 80;

interface SessionCreationContext {
	body?: unknown;
	path?: string;
}

function readClientId(body: unknown): string | null {
	if (typeof body !== "object" || body === null || !("client_id" in body)) {
		return null;
	}
	const clientId = body.client_id;
	if (
		typeof clientId !== "string" ||
		clientId.length === 0 ||
		clientId.length > MAX_CLIENT_ID_LENGTH
	) {
		return null;
	}
	return clientId;
}

/**
 * The client id to stamp on a session being created in `context`, or null.
 * Only the device-token endpoint yields a value.
 */
export function deviceGrantClientId(
	context: SessionCreationContext | null | undefined
): string | null {
	if (context?.path !== DEVICE_TOKEN_PATH) {
		return null;
	}
	return readClientId(context.body);
}

/** The device-authorization client a session was issued to, if any. */
export function sessionIssuedClientId(session: unknown): string | null {
	if (
		typeof session !== "object" ||
		session === null ||
		!(ISSUED_CLIENT_ID_FIELD in session)
	) {
		return null;
	}
	const value = session[ISSUED_CLIENT_ID_FIELD];
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** True when the session was issued to one of Ryu's own agent clients. */
export function sessionIssuedToRyuAgentClient(session: unknown): boolean {
	const clientId = sessionIssuedClientId(session);
	return clientId !== null && RYU_AGENT_CLIENT_IDS.includes(clientId);
}

/**
 * Why a session cannot act as a Ryu agent:
 *
 * - `unstamped_bearer`: the session carries no issuance stamp and arrived as a
 *   bearer token, the transport Ryu Desktop/Core, the CLI, and MCP use. The
 *   most likely cause is a sign-in that predates issuance stamping (an existing
 *   session slides forward on use and is never re-created), so the remedy is to
 *   sign out of the Ryu client and sign in again. Nothing is backfilled: the
 *   session row does not record which client redeemed it, and the bearer
 *   transport is caller-controlled, so it only selects the explanation and
 *   never grants access.
 * - `not_agent_client`: anything else (a browser cookie session, or a device
 *   session issued to a non-agent client such as the browser extension).
 *
 * Returns null when the session was issued to a Ryu agent client.
 */
export type RyuAgentSessionRefusal = "not_agent_client" | "unstamped_bearer";

export function ryuAgentSessionRefusal(
	session: unknown,
	transport: { bearer: boolean }
): RyuAgentSessionRefusal | null {
	if (sessionIssuedToRyuAgentClient(session)) {
		return null;
	}
	if (transport.bearer && sessionIssuedClientId(session) === null) {
		return "unstamped_bearer";
	}
	return "not_agent_client";
}

export function ryuClientSessionPlugin(): BetterAuthPlugin {
	return {
		id: "ryu-client-session",
		schema: {
			session: {
				fields: {
					[ISSUED_CLIENT_ID_FIELD]: {
						type: "string",
						required: false,
						input: false,
					},
				},
			},
		},
		init: () => ({
			options: {
				databaseHooks: {
					session: {
						create: {
							before: async (session, context) => {
								const clientId = deviceGrantClientId(context);
								if (!clientId) {
									return { data: session };
								}
								return {
									data: { ...session, [ISSUED_CLIENT_ID_FIELD]: clientId },
								};
							},
						},
					},
				},
			},
		}),
	};
}
