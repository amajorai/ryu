// User authentication for the Ryu MCP server via the OAuth 2.0 Device
// Authorization Grant (RFC 8628) - the SAME flow the desktop, mobile, and CLI
// clients use. The MCP server is a local, non-browser process, so it drives the
// grant through Ryu Core's proxy (POST /api/auth/login -> open browser -> poll
// GET /api/auth/status), exactly like apps/cli. Core performs the Better Auth
// device grant server-side and persists the resulting bearer to the shared
// credential store ~/.ryu/auth.json - so `ryu-mcp login`, `ryu login`, and a
// desktop sign-in all satisfy each other (single sign-on).
//
// The stored credential is a standard OAuth 2.0 Bearer access token (a Better
// Auth control-plane SESSION token) - which is exactly the bearer format MCP's
// own auth model expects. It identifies the USER to the control plane (whoami,
// sessions, billing). It is NOT a Core node-admittance bearer: Core's /api/*
// routes are gated by RYU_CORE_TOKEN (the node secret), which the server keeps
// sending as `Authorization: Bearer`. Device-auth here is additive.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CORE_URL = "http://127.0.0.1:7980";
const DEFAULT_AUTH_BACKEND = "http://localhost:3000";
const POLL_INTERVAL_MS = 1500;
const LOGIN_TIMEOUT_MS = 300_000;
const SECRET_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;

/** Persisted credential. Shape matches apps/cli (token + optional profile). */
export interface AuthData {
	email?: string | null;
	name?: string | null;
	token: string;
}

const ryuDir = (): string => join(homedir(), ".ryu");
const authFilePath = (): string => join(ryuDir(), "auth.json");

const coreUrl = (): string =>
	process.env.RYU_CORE_URL?.trim() || DEFAULT_CORE_URL;

/** Control-plane (Better Auth) base URL - where the session token is valid. */
export const authBackendUrl = (): string =>
	process.env.RYU_AUTH_URL?.trim() || DEFAULT_AUTH_BACKEND;

/** Read the shared credential, or null when absent/malformed. */
export const loadToken = (): AuthData | null => {
	try {
		const data = JSON.parse(readFileSync(authFilePath(), "utf8")) as AuthData;
		return typeof data.token === "string" && data.token ? data : null;
	} catch {
		return null;
	}
};

/** Write the credential 0600 under ~/.ryu (0700). Mode is ignored on Windows. */
const saveToken = (data: AuthData): void => {
	mkdirSync(ryuDir(), { recursive: true, mode: SECRET_DIR_MODE });
	writeFileSync(authFilePath(), JSON.stringify(data, null, 2), {
		mode: SECRET_FILE_MODE,
	});
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

/** Open a URL in the default browser, cross-platform. Best-effort. */
const openBrowser = (url: string): void => {
	try {
		if (process.platform === "win32") {
			spawn("cmd", ["/c", "start", "", url], {
				stdio: "ignore",
				detached: true,
			}).unref();
			return;
		}
		const cmd = process.platform === "darwin" ? "open" : "xdg-open";
		spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
	} catch {
		// Non-fatal: the URL is also printed for manual navigation.
	}
};

interface LoginStartResponse {
	error?: string;
	userCode?: string;
	verificationUri?: string;
	verificationUriComplete?: string;
}

interface StatusResponse {
	authenticated?: boolean;
	pending?: boolean;
	token?: string | null;
}

/** Fetch the control-plane session for a token. Returns the `user` object. */
export const fetchSession = async (
	token: string
): Promise<Record<string, unknown> | null> => {
	try {
		const resp = await fetch(`${authBackendUrl()}/api/auth/get-session`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!resp.ok) {
			return null;
		}
		const json = (await resp.json()) as { user?: Record<string, unknown> };
		return json.user ?? null;
	} catch {
		return null;
	}
};

/** Poll Core's device-auth status until authenticated; returns the bearer. */
const pollStatus = async (core: string): Promise<string> => {
	const deadline = Date.now() + LOGIN_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
		try {
			const resp = await fetch(`${core}/api/auth/status`);
			const data = (await resp.json()) as StatusResponse;
			if (data.authenticated && data.token) {
				return data.token;
			}
		} catch {
			// Transient - keep polling until the deadline.
		}
	}
	throw new Error(`Login timed out after ${LOGIN_TIMEOUT_MS / 1000} seconds`);
};

/**
 * Run the device-authorization login through Core's proxy and persist the
 * bearer. Prints progress to stdout - this runs as the `ryu-mcp login`
 * subcommand (a normal terminal process), NOT the stdio MCP server.
 */
export const runLogin = async (): Promise<void> => {
	const core = coreUrl();

	let start: LoginStartResponse;
	try {
		const resp = await fetch(`${core}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		start = (await resp.json()) as LoginStartResponse;
	} catch {
		throw new Error(
			`Could not reach Ryu Core at ${core}. Is it running? Set RYU_CORE_URL to point elsewhere.`
		);
	}
	if (start.error) {
		throw new Error(`Core could not start the login flow: ${start.error}`);
	}

	const url = start.verificationUriComplete || start.verificationUri;
	if (!url) {
		throw new Error("Core did not return a verification URL");
	}

	process.stdout.write("Opening your browser to sign in to Ryu...\n");
	process.stdout.write(`If it does not open, visit:\n  ${url}\n`);
	if (start.userCode) {
		process.stdout.write(`Device code: ${start.userCode}\n`);
	}
	openBrowser(url);
	process.stdout.write(
		"Waiting for you to approve the sign-in (Ctrl+C to cancel)...\n"
	);

	const token = await pollStatus(core);

	// Core persists {token}; upgrade it to {token,email,name} (a superset both
	// Core and the CLI read) so whoami can answer without a round-trip.
	const user = await fetchSession(token);
	saveToken({
		token,
		email: (user?.email as string | undefined) ?? null,
		name: (user?.name as string | undefined) ?? null,
	});

	process.stdout.write("Signed in.\n");
	if (user?.name) {
		process.stdout.write(`  Name:  ${String(user.name)}\n`);
	}
	if (user?.email) {
		process.stdout.write(`  Email: ${String(user.email)}\n`);
	}
};

/** Clear the local credential and tell Core to drop its in-memory token. */
export const runLogout = async (): Promise<void> => {
	clearToken();
	try {
		await fetch(`${coreUrl()}/api/auth/logout`, { method: "POST" });
	} catch {
		// Core may be down - the local credential is already cleared.
	}
	process.stdout.write("Signed out.\n");
};

/** Print the signed-in user (or a prompt to log in). For the CLI subcommand. */
export const runWhoami = async (): Promise<void> => {
	const data = loadToken();
	if (!data) {
		process.stdout.write("Not signed in. Run `ryu-mcp login`.\n");
		return;
	}
	const user = await fetchSession(data.token);
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
