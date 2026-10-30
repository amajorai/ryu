import { getActiveToken } from "@/lib/auth-client.ts";
import type { ApiTarget, RequestOptions } from "./client.ts";

/**
 * The dedicated header carrying the user's CONTROL-PLANE (Better-Auth) session
 * bearer to Core on a Marketplace install for optional account-aware operations.
 * Kept distinct from `Authorization`
 * (which holds the Core node token, a machine secret the control plane does not
 * recognize as a user). Core forwards this to the Marketplace install handoff when present.
 */
export const BUYER_TOKEN_HEADER = "X-Ryu-Buyer-Token";

/** Only a Core running on this machine may receive the control-plane session. */
function isLoopbackTarget(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return false;
		}
		if (parsed.username || parsed.password) {
			return false;
		}
		const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
		if (hostname === "localhost" || hostname === "::1") {
			return true;
		}
		const octets = hostname.split(".");
		return (
			octets.length === 4 &&
			octets.every(
				(octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255
			) &&
			octets[0] === "127"
		);
	} catch {
		return false;
	}
}

/** TLS to any host, or a Core on this machine. Cleartext to another host is not. */
export function hasConfidentialTransport(url: string): boolean {
	if (isLoopbackTarget(url)) {
		return true;
	}
	try {
		return new URL(url).protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Build the buyer-token header from the signed-in control-plane session token,
 * but only for a loopback Core target. A remote or malformed target gets no
 * session credential; the node token remains the only credential sent there.
 */
export function buyerTokenHeader(
	target: Pick<ApiTarget, "url">
): NonNullable<RequestOptions["headers"]> {
	if (!isLoopbackTarget(target.url)) {
		return {};
	}
	try {
		const token = getActiveToken();
		if (token) {
			return { [BUYER_TOKEN_HEADER]: token };
		}
	} catch {
		// No storage — install proceeds anonymously.
	}
	return {};
}
