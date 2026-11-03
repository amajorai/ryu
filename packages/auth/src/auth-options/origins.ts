import { env } from "@ryu/env/server";
import { resolveRyuCorsOrigins } from "../lib/cors-origins.ts";

// Trusted origins, the passkey relying party and the auth cookie domain.

// The browser extension's pages (dashboard.html, popup) run on a fixed
// chrome-extension:// origin and call Better Auth directly (device-auth flow,
// matching desktop + CLI). That origin must be trusted or POSTs to
// /api/auth/device/* are rejected by Better Auth's origin/CSRF check. The
// desktop never needed this because Core calls these endpoints server-side
// (reqwest) with no Origin header.
const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1"]);

function frontendOrigin(): string | undefined {
	const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3001";
	try {
		return new URL(frontendUrl).origin;
	} catch {
		return undefined;
	}
}

interface PasskeyWebAuthnOptionsResult {
	origin?: string;
	rpID?: string;
}

function passkeyWebAuthnOptions(): PasskeyWebAuthnOptionsResult {
	const origin = frontendOrigin();
	if (!origin) {
		return {};
	}

	try {
		return {
			origin,
			rpID: new URL(origin).hostname,
		};
	} catch {
		return {};
	}
}

export const PASSKEY_WEBAUTHN_OPTIONS = passkeyWebAuthnOptions();

/** Strip a leading `www.` so api.ryuhq.com + www.ryuhq.com share ryuhq.com. */
function normalizeHostname(hostname: string): string {
	return hostname.replace(/^www\./, "");
}

/**
 * When the auth API and marketing web live on sibling subdomains (api.ryuhq.com
 * vs ryuhq.com), the session cookie must use the shared parent domain or SSR on
 * the apex never sees it and /login <-> /console loops forever. Explicit
 * AUTH_COOKIE_DOMAIN wins; otherwise infer from FRONTEND_URL + BETTER_AUTH_URL.
 */
export function resolveAuthCookieDomain(): string | undefined {
	if (env.AUTH_COOKIE_DOMAIN) {
		return env.AUTH_COOKIE_DOMAIN;
	}

	const frontendUrl = process.env.FRONTEND_URL;
	if (!frontendUrl) {
		return undefined;
	}

	try {
		const authHost = normalizeHostname(new URL(env.BETTER_AUTH_URL).hostname);
		const frontendHost = normalizeHostname(new URL(frontendUrl).hostname);

		if (authHost === frontendHost) {
			return undefined;
		}
		if (LOCAL_DEV_HOSTS.has(authHost) || LOCAL_DEV_HOSTS.has(frontendHost)) {
			return undefined;
		}
		if (authHost.endsWith(`.${frontendHost}`)) {
			return frontendHost;
		}
		if (frontendHost.endsWith(`.${authHost}`)) {
			return authHost;
		}
	} catch {
		return undefined;
	}

	return undefined;
}

export function parseCorsOrigins(): string[] {
	return resolveRyuCorsOrigins({
		corsOrigin: process.env.CORS_ORIGIN,
		extensionOrigin: process.env.EXTENSION_ORIGIN,
		frontendUrl: frontendOrigin(),
		nodeEnv: env.NODE_ENV,
		webappUrl: env.WEBAPP_URL || "https://app.ryuhq.com",
	});
}

export function parseCsvEnv(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

/**
 * Recover a referral code from the `ryu_ref` cookie on the sign-up request.
 * Social/OAuth sign-up (`signIn.social`) has no request body to carry a
 * `referredBy` field, so a Google-referred visitor's code only survives as the
 * cookie the web client set when they landed on a `?ref=` link. The DB create
 * hook reads it here so social referrals attribute the same as email/password.
 * Defensive against Better Auth's context shape: returns undefined if the
 * cookie (or the context) is absent, so a missing cookie is simply a no-op.
 */
interface ReferralCookieContext {
	headers?: Pick<Headers, "get"> | null;
	request?: { headers?: Pick<Headers, "get"> | null } | null;
}
export function referredByFromCookie(
	ctx: ReferralCookieContext | null | undefined
): string | undefined {
	const cookieHeader =
		ctx?.headers?.get?.("cookie") ??
		ctx?.request?.headers?.get?.("cookie") ??
		null;
	if (!cookieHeader) {
		return;
	}
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) {
			continue;
		}
		const key = part.slice(0, eq).trim();
		if (key === "ryu_ref") {
			const value = decodeURIComponent(part.slice(eq + 1).trim()).trim();
			return value || undefined;
		}
	}
	return;
}
