/**
 * Tauri v2 desktop webview origins (platform-specific). Production builds are NOT
 * localhost — Windows/Android use http://tauri.localhost; macOS/Linux use
 * tauri://localhost. Both must be CORS/trusted-origins allowed or every
 * control-plane fetch from a release build fails (waitlist gate, profile, etc.).
 */
export const TAURI_DESKTOP_ORIGINS = [
	"tauri://localhost",
	"http://tauri.localhost",
	"https://tauri.localhost",
] as const;

export const DEFAULT_EXTENSION_ORIGIN =
	"chrome-extension://eahmgoelihpjlbejliklmfcohjhpgeml";

const DEFAULT_BROWSER_AND_APP_ORIGINS = [
	"http://localhost:3001",
	"http://localhost:1420",
	"http://localhost:5173",
	"http://localhost:5175",
	"http://127.0.0.1:3001",
	"ryu://",
] as const;

/**
 * Expo Go's scheme. Better Auth matches a bare custom-scheme origin against
 * every URL with that scheme, so `exp://` would accept any
 * `exp://<host>/...` callbackURL, and the expo() plugin forwards the session
 * cookie on redirects to trusted non-http origins. Shipped native builds use
 * `ryu://`, so Expo Go is trusted in development only.
 */
const EXPO_GO_DEVELOPMENT_ORIGIN = "exp://";

function urlOrigin(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	try {
		return new URL(value).origin;
	} catch {
		return undefined;
	}
}

/** One origin policy for Hono CORS and Better Auth CSRF/trusted-origin checks. */
export function resolveRyuCorsOrigins(input: {
	corsOrigin?: string;
	extensionOrigin?: string;
	frontendUrl?: string;
	nodeEnv?: string;
	webappUrl?: string;
}): string[] {
	const configured = (input.corsOrigin ?? "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);
	const extensionOrigin =
		input.extensionOrigin?.trim() || DEFAULT_EXTENSION_ORIGIN;
	const alwaysTrusted = [
		input.nodeEnv === "development" ? EXPO_GO_DEVELOPMENT_ORIGIN : undefined,
		"ryu://",
		...TAURI_DESKTOP_ORIGINS,
		extensionOrigin,
		urlOrigin(input.frontendUrl),
		urlOrigin(input.webappUrl),
	];
	return [
		...new Set([
			...(configured.length > 0 ? configured : DEFAULT_BROWSER_AND_APP_ORIGINS),
			...alwaysTrusted.filter((origin): origin is string => Boolean(origin)),
		]),
	];
}
