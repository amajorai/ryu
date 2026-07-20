import { addAccount } from "@/lib/auth-client.ts";

// Device Authorization Grant (RFC 8628) run DIRECTLY against Better Auth — no
// Core broker. Sign-in must work with no local node running (desktop dev) and
// with no hosted "shell Core" (webapp), so the browser/webview talks to the
// auth backend itself, exactly like apps/extension/lib/oauth.ts. Core is only
// for RUNNING agents, never for signing in.

// Must be one of Better Auth's allowlisted device clients
// (packages/auth deviceAuthorization.validateClient).
const DEVICE_CLIENT_ID = "ryu-desktop";
const OAUTH_SCOPES = "openid profile email";
const SLOW_DOWN_BACKOFF_SECS = 5;
const DEFAULT_INTERVAL_SECS = 5;
const DEFAULT_EXPIRES_SECS = 900;

export interface DeviceAuthInfo {
	backendUrl: string;
	// Carried so the poll loop is self-contained (the old Core-broker flow kept
	// these server-side; the direct flow keeps them on the client).
	deviceCode: string;
	expiresIn: number;
	interval: number;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start the device authorization flow against Better Auth. Requests a device +
 * user code and returns the codes plus the verification URL to display. When
 * `returnTo` is set (webapp), it is appended to the verification URL so the
 * approve page can bounce back to the originating surface after approval.
 */
export async function startDeviceAuth(
	backendUrl: string,
	returnTo?: string
): Promise<DeviceAuthInfo> {
	const base = backendUrl.replace(/\/$/, "");
	const res = await fetch(`${base}/api/auth/device/code`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: DEVICE_CLIENT_ID,
			scope: OAUTH_SCOPES,
		}),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Device code request failed (${res.status}): ${text}`);
	}

	const data = (await res.json()) as Record<string, unknown>;
	const deviceCode =
		typeof data.device_code === "string" ? data.device_code : "";
	const userCode = typeof data.user_code === "string" ? data.user_code : "";
	if (!(deviceCode && userCode)) {
		throw new Error("Malformed device code response");
	}

	const verificationUri =
		typeof data.verification_uri === "string"
			? data.verification_uri
			: `${base}/device`;
	let verificationUriComplete =
		typeof data.verification_uri_complete === "string"
			? data.verification_uri_complete
			: verificationUri;
	if (returnTo) {
		const sep = verificationUriComplete.includes("?") ? "&" : "?";
		verificationUriComplete += `${sep}returnTo=${encodeURIComponent(returnTo)}`;
	}

	return {
		userCode,
		verificationUri,
		verificationUriComplete,
		deviceCode,
		backendUrl: base,
		interval:
			typeof data.interval === "number" ? data.interval : DEFAULT_INTERVAL_SECS,
		expiresIn:
			typeof data.expires_in === "number"
				? data.expires_in
				: DEFAULT_EXPIRES_SECS,
	};
}

/**
 * Poll Better Auth's device-token endpoint until the user approves (calls
 * `onSuccess` with the access token), denies, or the code expires (`onError`).
 * Returns a cancel function that stops polling. Mirrors the extension + Core
 * polling loops' RFC 8628 error handling.
 */
export function pollAuthStatus(
	start: DeviceAuthInfo,
	onSuccess: (token: string) => void,
	onError: (err: Error) => void
): () => void {
	let cancelled = false;
	let interval = Math.max(start.interval, DEFAULT_INTERVAL_SECS);
	const deadline = Date.now() + start.expiresIn * 1000;

	(async () => {
		while (Date.now() < deadline) {
			if (cancelled) {
				return;
			}
			await sleep(interval * 1000);
			if (cancelled) {
				return;
			}

			let data: Record<string, unknown>;
			try {
				// This Better Auth deployment enforces application/json on every auth
				// route (form-urlencoded → 415), so the RFC 8628 token request goes as
				// JSON rather than the standard form encoding.
				const res = await fetch(`${start.backendUrl}/api/auth/device/token`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						grant_type: "urn:ietf:params:oauth:grant-type:device_code",
						device_code: start.deviceCode,
						client_id: DEVICE_CLIENT_ID,
					}),
				});
				data = (await res.json()) as Record<string, unknown>;
			} catch {
				// Transient network error — keep polling until the deadline.
				continue;
			}

			const token = data.access_token;
			if (typeof token === "string" && token) {
				if (!cancelled) {
					onSuccess(token);
				}
				return;
			}

			const error = typeof data.error === "string" ? data.error : null;
			if (error === "authorization_pending") {
				continue;
			}
			if (error === "slow_down") {
				interval += SLOW_DOWN_BACKOFF_SECS;
				continue;
			}
			if (error === "access_denied") {
				if (!cancelled) {
					onError(
						new Error("Access denied. You declined the sign-in request.")
					);
				}
				return;
			}
			if (error === "expired_token") {
				if (!cancelled) {
					onError(new Error("The sign-in request expired. Please try again."));
				}
				return;
			}
			if (error) {
				if (!cancelled) {
					onError(new Error(`Sign-in failed: ${error}`));
				}
				return;
			}
		}
		if (!cancelled) {
			onError(new Error("Login timed out"));
		}
	})();

	return () => {
		cancelled = true;
	};
}

/**
 * Run the full device-authorization flow to add ANOTHER account without losing
 * the ones already signed in (Notion-style "Add account"). On success the new
 * token+profile are upserted into the local vault and made active via
 * {@link addAccount}; the existing accounts are preserved.
 *
 * Returns a cancel function that aborts the flow (both the pending code request
 * and the poll loop).
 */
export function addAccountViaDeviceAuth(
	backendUrl: string,
	handlers: {
		onCode?: (info: DeviceAuthInfo) => void;
		onAdded: (userId: string) => void;
		onError: (err: Error) => void;
	}
): () => void {
	let cancelPoll: (() => void) | null = null;
	let cancelled = false;

	startDeviceAuth(backendUrl)
		.then((info) => {
			if (cancelled) {
				return;
			}
			handlers.onCode?.(info);
			cancelPoll = pollAuthStatus(
				info,
				async (token) => {
					try {
						const account = await addAccount(token);
						if (!cancelled) {
							handlers.onAdded(account.userId);
						}
					} catch (err) {
						if (!cancelled) {
							handlers.onError(
								err instanceof Error ? err : new Error("Failed to add account")
							);
						}
					}
				},
				handlers.onError
			);
		})
		.catch((err: unknown) => {
			if (!cancelled) {
				handlers.onError(
					err instanceof Error ? err : new Error("Failed to start sign-in")
				);
			}
		});

	return () => {
		cancelled = true;
		cancelPoll?.();
	};
}
