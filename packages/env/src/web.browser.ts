/**
 * Browser entry of `@ryu/env/web`, selected by the `browser` export condition
 * in package.json. Server bundles, `next.config.ts`, Bun and Node keep resolving
 * the validating entry (`./web.ts`).
 *
 * Next inlines every `NEXT_PUBLIC_*` value at build time, and the server half of
 * the same build validates those exact values: `next.config.ts` imports
 * `./web.ts` during the build (unless SKIP_ENV_VALIDATION is set) and every
 * server render evaluates it again. Repeating that zod pass in the browser only
 * re-checked accepted values while shipping t3-env and zod's schema builders in
 * every page's first-load JS. This entry keeps what client code observes the
 * same: empty strings read as undefined, the schema defaults apply, and reading
 * a non-public key throws like t3-env's client proxy.
 */
import type { env as validatedWebEnv } from "./web.ts";

type WebEnv = typeof validatedWebEnv;
type RuntimeEnv = Record<string, string | undefined>;

const CLIENT_PREFIX = "NEXT_PUBLIC_";

/** The `.default(...)` values in `./web.ts`; web.browser.test.ts keeps them equal. */
export const WEB_ENV_DEFAULTS: Readonly<RuntimeEnv> = Object.freeze({
	NEXT_PUBLIC_CORE_URL: "http://localhost:7980",
	NEXT_PUBLIC_DOCS_URL: "http://localhost:4000",
	NEXT_PUBLIC_WEBAPP_URL: "http://localhost:5175",
	NEXT_PUBLIC_PRODUCT_DASHBOARD_URL: "https://app.ryuhq.com/dashboard",
	NEXT_PUBLIC_POSTHOG_HOST: "https://eu.i.posthog.com",
});

function isIgnoredProp(prop: string): boolean {
	return prop === "__esModule" || prop === "$$typeof";
}

export function createBrowserWebEnv(
	runtimeEnv: RuntimeEnv,
	skipValidation: boolean
): WebEnv {
	// Same order as t3-env: drop empty strings first, so a skipped validation
	// still sees them as missing.
	const values: RuntimeEnv = {};
	for (const [key, value] of Object.entries(runtimeEnv)) {
		if (value !== "") {
			values[key] = value;
		}
	}
	if (skipValidation) {
		// SAFETY: t3-env returns the raw runtime env unchanged when validation is
		// skipped; the declared type is the same lie it tells there.
		return values as WebEnv;
	}
	for (const [key, fallback] of Object.entries(WEB_ENV_DEFAULTS)) {
		if (values[key] === undefined) {
			values[key] = fallback;
		}
	}
	const publicEnv = new Proxy(values, {
		get(target, prop) {
			if (typeof prop !== "string" || isIgnoredProp(prop)) {
				return;
			}
			if (!prop.startsWith(CLIENT_PREFIX)) {
				throw new Error(
					"❌ Attempted to access a server-side environment variable on the client"
				);
			}
			return Reflect.get(target, prop);
		},
	});
	// SAFETY: every key the validating schema declares is a NEXT_PUBLIC_* string
	// (or undefined when optional), which is exactly what `values` holds.
	return publicEnv as WebEnv;
}

// Each read stays a literal `process.env.NEXT_PUBLIC_*` member so Next inlines it.
export const env = createBrowserWebEnv(
	{
		NEXT_PUBLIC_SERVER_URL: process.env.NEXT_PUBLIC_SERVER_URL,
		NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
		NEXT_PUBLIC_CORE_URL: process.env.NEXT_PUBLIC_CORE_URL,
		NEXT_PUBLIC_DOCS_URL: process.env.NEXT_PUBLIC_DOCS_URL,
		NEXT_PUBLIC_WEBAPP_URL: process.env.NEXT_PUBLIC_WEBAPP_URL,
		NEXT_PUBLIC_PRODUCT_DASHBOARD_URL:
			process.env.NEXT_PUBLIC_PRODUCT_DASHBOARD_URL,
		NEXT_PUBLIC_GOOGLE_CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
		NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
		NEXT_PUBLIC_STORAGE_ENDPOINT: process.env.NEXT_PUBLIC_STORAGE_ENDPOINT,
		NEXT_PUBLIC_STORAGE_BUCKET_NAME:
			process.env.NEXT_PUBLIC_STORAGE_BUCKET_NAME,
		NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
		NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
		NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
	},
	!!process.env.SKIP_ENV_VALIDATION
);
