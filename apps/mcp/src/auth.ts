// User authentication for the Ryu MCP server via the OAuth 2.0 Device
// Authorization Grant (RFC 8628). This is the same Better Auth flow the
// desktop, mobile, and CLI clients use, but it runs directly against the
// control plane so `ryu-mcp login` does not require a local Core node.
//
// The stored credential is a Better Auth control-plane session token. It
// identifies the user to the control plane for `whoami` and account operations.
// It is NOT a Core node-admittance bearer. Core requests use the separate
// `RYU_CORE_TOKEN` or a local node token.

import { spawn } from "node:child_process";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	ryuHomeDir,
	ryuProfile,
	secretPath,
} from "@ryuhq/core-client/data-dir";
import {
	type StoredCredentialTokenObservation,
	storedCredentialTokenObservationSchema,
} from "./credential-token-observation.ts";
import {
	deviceCodeClientProjectionSchema,
	deviceTokenClientProjectionSchema,
} from "./device-response-contracts.ts";
import {
	type LegacyRawAuthProfileObservation,
	legacyRawAuthProfileObservationSchema,
} from "./session-response-contracts.ts";

/** The hosted Ryu control plane, the same origin release Desktop signs in to. */
const PRODUCTION_AUTH_BACKEND = "https://api.ryuhq.com";
/** The local `apps/server` control plane a `RYU_PROFILE=dev` checkout runs. */
const DEV_AUTH_BACKEND = "http://localhost:3000";
const DEV_PROFILE = "dev";
const DEVICE_CLIENT_ID = "ryu-mcp";
const OAUTH_SCOPES = "openid profile email";
const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_SECONDS = 900;
const MAX_INTERVAL_SECONDS = 60;
const MAX_EXPIRES_SECONDS = 3600;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SECRET_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;
/**
 * Deadline for one control-plane auth request. Without it a hung connection
 * pins the device-grant poll loop past its own expiry deadline forever.
 */
const AUTH_REQUEST_TIMEOUT_MS = 15_000;

/** This bridge historically validates only the stored token. Profile/backend
 * metadata and future fields remain raw native JSON observations. This is not
 * the full BetterAuth session/user publisher contract. */
export type AuthData = StoredCredentialTokenObservation;

export interface DeviceAuthStart {
	backendUrl: string;
	deviceCode: string;
	expiresIn: number;
	interval: number;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
}

/** `<data dir>/secrets/mcp-auth.json`, with the data dir resolved like Core
 * (`RYU_DIR` > Storage pointer > `~/.ryu<sfx>`), unless `RYU_MCP_AUTH_FILE`
 * names the file explicitly. */
const authFilePath = (): string =>
	process.env.RYU_MCP_AUTH_FILE?.trim() ||
	secretPath(ryuHomeDir(), "mcp-auth.json");

/** Control-plane (Better Auth) base URL. */
/** Allow plaintext only for a local control plane; remote auth must use HTTPS. */
export const safeAuthBackendUrl = <BackendValue>(
	value: BackendValue
): string => {
	// SAFETY: the actual native URL constructor owns WebIDL USVString conversion.
	// This immediate SDK argument view permits coercible raw values and may throw;
	// it does not assert that the stored value is already a primitive string.
	// Keep the original native conversion/getter/error stage before protocol checks.
	const parsed = new URL(value as ConstructorParameters<typeof URL>[0]);
	const isLoopback =
		parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
	if (parsed.protocol !== "https:" && !isLoopback) {
		throw new Error("RYU_AUTH_URL must use HTTPS unless it targets loopback");
	}
	return parsed.href.replace(/\/$/, "");
};

/** The control plane used when `RYU_AUTH_URL` is unset: the local dev server
 * under `RYU_PROFILE=dev`, the hosted Ryu control plane for every other
 * profile, so an installed `ryu-mcp login` works without configuration. */
export const defaultAuthBackendUrl = (): string =>
	ryuProfile() === DEV_PROFILE ? DEV_AUTH_BACKEND : PRODUCTION_AUTH_BACKEND;

/** `RYU_AUTH_URL` when set, else {@link defaultAuthBackendUrl}. */
export const authBackendUrl = (): string =>
	safeAuthBackendUrl(
		process.env.RYU_AUTH_URL?.trim() || defaultAuthBackendUrl()
	);

const boundedPositiveSeconds = (
	value: Parameters<typeof Number.isFinite>[0],
	fallback: number,
	maximum: number
): number => {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	// SAFETY: The genuine native Number.isFinite accepts its complete input
	// domain without coercion and returns true only for primitive finite numbers.
	// This immediate checked value retains the original positive bound/fallback.
	const seconds = value as number;
	if (seconds <= 0) {
		return fallback;
	}
	return Math.min(seconds, maximum);
};

/** Read this bridge's local credential, or null when absent/malformed. */
export const loadToken = (): AuthData | null => {
	try {
		const data = JSON.parse(readFileSync(authFilePath(), "utf8"));
		const observed = storedCredentialTokenObservationSchema.safeParse(data);
		return observed.success ? observed.data : null;
	} catch {
		return null;
	}
};

/** Write the credential 0600 under `<data dir>/secrets` (0700). Mode is ignored on Windows. */
const saveToken = (data: AuthData): void => {
	mkdirSync(dirname(authFilePath()), {
		recursive: true,
		mode: SECRET_DIR_MODE,
	});
	// Write-then-rename so a crash mid-write can't leave a truncated credential
	// file that silently reads back as "signed out".
	const target = authFilePath();
	const temporary = `${target}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(data, null, 2), {
		mode: SECRET_FILE_MODE,
	});
	try {
		renameSync(temporary, target);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
};

export const clearToken = (): void => {
	try {
		rmSync(authFilePath());
	} catch {
		// Already absent - nothing to clear.
	}
};

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

class TerminalDeviceAuthError extends Error {}

/** Return a canonical URL that is safe to hand to an OS browser launcher. */
export const safeBrowserUrl = (value: string): string | null => {
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return null;
		}
		return parsed.href;
	} catch {
		return null;
	}
};

/** Open a URL in the default browser, cross-platform. Best-effort. */
const openBrowser = (url: string): void => {
	const safeUrl = safeBrowserUrl(url);
	if (!safeUrl) {
		return;
	}
	try {
		if (process.platform === "win32") {
			spawn("rundll32.exe", ["url.dll,FileProtocolHandler", safeUrl], {
				stdio: "ignore",
				detached: true,
			}).unref();
			return;
		}
		const command = process.platform === "darwin" ? "open" : "xdg-open";
		spawn(command, [safeUrl], { stdio: "ignore", detached: true }).unref();
	} catch {
		// Non-fatal: the URL is also printed for manual navigation.
	}
};

/** Start the Better Auth device grant directly at the control plane. */
export const requestDeviceCode = async (
	backendUrl: string
): Promise<DeviceAuthStart> => {
	const base = safeAuthBackendUrl(backendUrl);
	const resp = await fetch(`${base}/api/auth/device/code`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: DEVICE_CLIENT_ID,
			scope: OAUTH_SCOPES,
		}),
		signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
	});
	const data = await resp.json().catch(() => ({}));
	if (!resp.ok) {
		throw new Error(
			`Device code request failed (${resp.status}): ${String(data.error ?? "unknown error")}`
		);
	}
	const decodedDeviceCode = deviceCodeClientProjectionSchema.safeParse(data);
	if (!decodedDeviceCode.success) {
		throw new Error("Better Auth returned an invalid device code response");
	}
	const payload = decodedDeviceCode.data;
	const deviceCode = payload.device_code;
	const userCode = payload.user_code;
	const configuredVerificationUri =
		payload.verification_uri === undefined
			? null
			: safeBrowserUrl(payload.verification_uri);
	const verificationUri = configuredVerificationUri ?? `${base}/device`;
	const verificationUriComplete =
		payload.verification_uri_complete === undefined
			? null
			: safeBrowserUrl(payload.verification_uri_complete);
	return {
		backendUrl: base,
		deviceCode,
		expiresIn: boundedPositiveSeconds(
			payload.expires_in,
			DEFAULT_EXPIRES_SECONDS,
			MAX_EXPIRES_SECONDS
		),
		interval: boundedPositiveSeconds(
			payload.interval,
			DEFAULT_INTERVAL_SECONDS,
			MAX_INTERVAL_SECONDS
		),
		userCode,
		verificationUri,
		verificationUriComplete: verificationUriComplete ?? verificationUri,
	};
};

/** Poll Better Auth until the device grant is approved, denied, or expires. */
export const pollDeviceToken = async (
	backendUrl: string,
	deviceCode: string,
	intervalSeconds: number,
	expiresInSeconds: number
): Promise<string> => {
	const base = safeAuthBackendUrl(backendUrl);
	const expiresIn = boundedPositiveSeconds(
		expiresInSeconds,
		DEFAULT_EXPIRES_SECONDS,
		MAX_EXPIRES_SECONDS
	);
	const deadline = Date.now() + expiresIn * 1000;
	let interval =
		boundedPositiveSeconds(
			intervalSeconds,
			DEFAULT_INTERVAL_SECONDS,
			MAX_INTERVAL_SECONDS
		) * 1000;
	while (Date.now() < deadline) {
		let shouldContinue = false;
		try {
			const resp = await fetch(`${base}/api/auth/device/token`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					client_id: DEVICE_CLIENT_ID,
					device_code: deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
				signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
			});
			const data = await resp.json().catch(() => ({}));
			const decodedToken = deviceTokenClientProjectionSchema.safeParse(data);
			if (decodedToken.success) {
				return decodedToken.data.access_token;
			}
			switch (data.error) {
				case "access_denied":
					throw new TerminalDeviceAuthError(
						"Access denied. You declined the sign-in request."
					);
				case "expired_token":
					throw new TerminalDeviceAuthError(
						"The sign-in request expired. Please try again."
					);
				case "slow_down":
					interval = Math.min(interval + 5000, MAX_INTERVAL_SECONDS * 1000);
					shouldContinue = true;
					break;
				case undefined:
				case "authorization_pending":
					shouldContinue = true;
					break;
				default:
					throw new TerminalDeviceAuthError(
						`Sign-in failed: ${String(data.error)}`
					);
			}
		} catch (error) {
			if (error instanceof TerminalDeviceAuthError) {
				throw error;
			}
			// A transport failure is transient. Keep polling until the grant expires.
			shouldContinue = true;
		}
		if (shouldContinue) {
			await sleep(interval);
		}
	}
	throw new Error("Login timed out. Please try again.");
};

/** Run the device authorization flow and persist this bridge's session. */
export const runLogin = async (): Promise<void> => {
	const backend = authBackendUrl();
	let start: DeviceAuthStart;
	try {
		start = await requestDeviceCode(backend);
	} catch (error) {
		throw new Error(
			`Could not reach the Ryu control plane at ${backend}: ${String(error)}`
		);
	}

	process.stdout.write("Opening your browser to sign in to Ryu...\n");
	process.stdout.write(
		`If it does not open, visit:\n  ${start.verificationUriComplete}\n`
	);
	process.stdout.write(`Device code: ${start.userCode}\n`);
	openBrowser(start.verificationUriComplete);
	process.stdout.write(
		"Waiting for you to approve the sign-in (Ctrl+C to cancel)...\n"
	);

	const token = await pollDeviceToken(
		start.backendUrl,
		start.deviceCode,
		start.interval,
		start.expiresIn
	);
	const user = await fetchSession(token, start.backendUrl);
	saveToken({
		backendUrl: start.backendUrl,
		token,
		email: user?.email ?? null,
		name: user?.name ?? null,
	});

	process.stdout.write("Signed in.\n");
	if (user?.name) {
		process.stdout.write(`  Name:  ${String(user.name)}\n`);
	}
	if (user?.email) {
		process.stdout.write(`  Email: ${String(user.email)}\n`);
	}
};

/** Clear this bridge's local session without changing other Ryu clients. */
export const runLogout = (): void => {
	clearToken();
	process.stdout.write("Signed out.\n");
};

/** Fetch the control-plane user for the stored session. */
export const fetchSession = async <BackendValue>(
	token: string,
	backendUrl?: BackendValue
): Promise<LegacyRawAuthProfileObservation | null> => {
	try {
		const resp = await fetch(
			`${safeAuthBackendUrl(backendUrl ?? authBackendUrl())}/api/auth/get-session`,
			{
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
			}
		);
		if (!resp.ok) {
			return null;
		}
		const json = await resp.json();
		const user = json.user ?? null;
		if (user === null) {
			return null;
		}
		const observedProfile =
			legacyRawAuthProfileObservationSchema.safeParse(user);
		return observedProfile.success ? observedProfile.data : null;
	} catch {
		return null;
	}
};

/** Print the signed-in user, or an actionable login hint. */
export const runWhoami = async (): Promise<void> => {
	const data = loadToken();
	if (!data) {
		process.stdout.write("Not signed in. Run `ryu-mcp login`.\n");
		return;
	}
	const user = await fetchSession(data.token, data.backendUrl);
	if (user) {
		process.stdout.write(
			`Signed in as ${String(user.name ?? "?")} <${String(user.email ?? "?")}>\n`
		);
		return;
	}
	const who = data.name || data.email || "stored credential";
	process.stdout.write(
		`Signed in (${who}) - control plane unreachable or token expired.\n`
	);
};
