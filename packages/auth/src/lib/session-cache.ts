import type { BetterAuthOptions } from "better-auth";
import { deleteSessionCookie, setSessionCookie } from "better-auth/cookies";

// Keep revocation lag bounded. Sensitive requests read the session store.
export const sessionCookieCache = {
	enabled: true,
	maxAge: 60,
	strategy: "compact",
} satisfies NonNullable<
	NonNullable<BetterAuthOptions["session"]>["cookieCache"]
>;

// Only presentation reads may use a cached login. New API routes default to
// authoritative validation, including reads of billing and security settings.
const CACHED_API_READ_PATH =
	/^\/(?:api\/)?(?:catalog|marketplace|blog|changelog|help|community|announcements)(?:\/|$)/;

export function canUseSessionCookieCache(
	method: string,
	path: string
): boolean {
	return method === "GET" && CACHED_API_READ_PATH.test(path);
}

/** Better Auth merges returned context overrides into later hooks and handlers. */
export function authoritativeAuthContext(context: {
	path?: string;
	query?: Parameters<typeof setSessionCookie>[0]["query"];
}) {
	return context.path === "/get-session"
		? undefined
		: { context: { query: { ...context.query, disableCookieCache: true } } };
}

export async function refreshSessionCookieFromStore(
	context: Parameters<typeof setSessionCookie>[0],
	token: string
): Promise<void> {
	const session = await context.context.internalAdapter.findSession(token);
	context.context.session = session;
	if (session) {
		await setSessionCookie(context, session);
	} else {
		context.context.newSession = null;
		deleteSessionCookie(context);
	}
}
