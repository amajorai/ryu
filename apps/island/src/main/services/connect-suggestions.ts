import { z } from "zod";
// Private Connect-trigger suggestions from Core's user-scoped notification inbox.
// The short-lived Core user JWT is obtained only from a trusted loopback Core and
// kept in memory; the device token remains the request bearer.

import { coreHeaders, loadConfig } from "./config.ts";
import {
	type ConnectSuggestionNotification,
	parseConnectSuggestionNotifications,
} from "./connect-suggestions-shared.ts";

const REQUEST_TIMEOUT_MS = 5000;
const USER_JWT_CACHE_MS = 30_000;
const notificationsSchema = z
	.object({ notifications: z.array(z.unknown()).catch([]) })
	.catch({ notifications: [] });
const authStatusSchema = z
	.object({ token: z.string().nullable().catch(null) })
	.catch({ token: null });

export type { ConnectSuggestionNotification } from "./connect-suggestions-shared.ts";

interface CoreTarget {
	coreBaseUrl: string;
	headers: Record<string, string>;
}

function coreTarget(): CoreTarget {
	return { coreBaseUrl: loadConfig().coreBaseUrl, headers: coreHeaders() };
}

function isLoopbackCore(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			["http:", "https:"].includes(parsed.protocol) &&
			["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) &&
			!parsed.username &&
			!parsed.password
		);
	} catch {
		return false;
	}
}

let cachedUserJwt: {
	target: string;
	credential: string | undefined;
	expiresAt: number;
	value: string | null;
} | null = null;

/** List pending Island suggestions for the signed-in user or personal local owner. */
export async function listConnectSuggestions(): Promise<
	ConnectSuggestionNotification[]
> {
	const target = coreTarget();
	const { coreBaseUrl } = target;
	const userJwt = await getLocalCoreUserJwt(target);
	const params = new URLSearchParams({ archived: "false", limit: "50" });
	if (!userJwt) {
		// Local, unbound Core uses the stable personal owner. Org-bound nodes reject
		// this anonymous path, so it cannot select another member's inbox.
		params.set("user_id", "local");
	}
	const response = await requestCore(
		`${coreBaseUrl}/api/notifications?${params.toString()}`,
		target,
		userJwt
	);
	if (!response.ok) {
		throw new Error(`Core notification request failed: ${response.status}`);
	}
	const payload = notificationsSchema.parse(await response.json());
	return parseConnectSuggestionNotifications(payload.notifications);
}

/** Resolve an Island suggestion in Core after the user accepts, dismisses, or snoozes it. */
export async function archiveConnectSuggestion(id: string): Promise<void> {
	const target = coreTarget();
	const { coreBaseUrl } = target;
	const userJwt = await getLocalCoreUserJwt(target);
	const response = await requestCore(
		`${coreBaseUrl}/api/notifications/${encodeURIComponent(id)}/archive`,
		target,
		userJwt,
		"POST"
	);
	if (!response.ok) {
		throw new Error(`Core could not archive suggestion: ${response.status}`);
	}
}

async function getLocalCoreUserJwt(
	target: CoreTarget,
	forceRefresh = false
): Promise<string | null> {
	if (!isLoopbackCore(target.coreBaseUrl)) {
		return null;
	}
	if (
		!forceRefresh &&
		cachedUserJwt?.target === target.coreBaseUrl &&
		cachedUserJwt.credential === target.headers.Authorization &&
		cachedUserJwt.expiresAt > Date.now()
	) {
		return cachedUserJwt.value;
	}
	const { coreBaseUrl } = target;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(`${coreBaseUrl}/api/auth/status`, {
			method: "GET",
			headers: target.headers,
			redirect: "error",
			signal: controller.signal,
		});
		if (!response.ok) {
			cachedUserJwt = {
				target: target.coreBaseUrl,
				credential: target.headers.Authorization,
				value: null,
				expiresAt: Date.now() + USER_JWT_CACHE_MS,
			};
			return null;
		}
		const token = authStatusSchema.parse(await response.json()).token;
		cachedUserJwt = {
			target: target.coreBaseUrl,
			credential: target.headers.Authorization,
			value: token,
			expiresAt: Date.now() + USER_JWT_CACHE_MS,
		};
		return token;
	} catch {
		cachedUserJwt = {
			target: target.coreBaseUrl,
			credential: target.headers.Authorization,
			value: null,
			expiresAt: Date.now() + USER_JWT_CACHE_MS,
		};
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

async function requestCore(
	url: string,
	target: CoreTarget,
	userJwt: string | null,
	method = "GET"
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const headers = new Headers(target.headers);
	if (userJwt) {
		headers.set("X-Ryu-User-Jwt", userJwt);
	}
	try {
		const response = await fetch(url, {
			method,
			headers,
			redirect: "error",
			signal: controller.signal,
		});
		if (response.status !== 401 || !userJwt) {
			return response;
		}
		cachedUserJwt = null;
		const refreshedJwt = await getLocalCoreUserJwt(target, true);
		if (!refreshedJwt) {
			return response;
		}
		return await fetch(url, {
			method,
			headers: { ...target.headers, "X-Ryu-User-Jwt": refreshedJwt },
			redirect: "error",
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}
}
