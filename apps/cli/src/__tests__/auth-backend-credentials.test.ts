import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
	type ApiTarget,
	request,
	setUserJwtProvider,
} from "@ryuhq/core-client/client";
import { z } from "zod";
import { accountBackendTarget } from "../core/authBackend.ts";
import { fetchManagedNodes } from "../core/managedNodes.ts";
import { reportCliReferralEvent } from "../core/quest-events.ts";
import { resolveCliWaitlistAccess } from "../core/waitlist.ts";

// The account session token comes from Core's /api/auth/status. Release builds
// set no RYU_AUTH_URL, so the account backend falls back to plain-HTTP
// http://localhost:3000, which any local program can listen on. These tests
// stand in for that listener and check what it would receive.

const realFetch = globalThis.fetch;
const originalAuthUrl = process.env.RYU_AUTH_URL;
const originalProfile = process.env.RYU_PROFILE;
const ACCOUNT_TOKEN = "cloud-account-session-token";
const PROVIDER_JWT = "provider-user-jwt";
const CORE: ApiTarget = { token: "core-node-token", url: "https://core.test" };

interface Seen {
	authorization: string | null;
	url: string;
	userJwt: string | null;
}

function recordRequests(): Seen[] {
	const seen: Seen[] = [];
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const outgoing = new Request(input, init);
			const url = new URL(outgoing.url);
			if (url.origin === CORE.url) {
				return Promise.resolve(
					Response.json({
						authenticated: true,
						pending: false,
						token: ACCOUNT_TOKEN,
						userCode: null,
						verificationUri: null,
					})
				);
			}
			seen.push({
				authorization: outgoing.headers.get("authorization"),
				url: outgoing.url,
				userJwt: outgoing.headers.get("x-ryu-user-jwt"),
			});
			return Promise.resolve(Response.json({ nodes: [] }));
		},
		{ preconnect: realFetch.preconnect }
	);
	return seen;
}

async function callEveryAccountBackendPath(): Promise<void> {
	await fetchManagedNodes(CORE);
	await resolveCliWaitlistAccess(CORE).catch(() => undefined);
	await reportCliReferralEvent(CORE);
	await request(
		accountBackendTarget(ACCOUNT_TOKEN),
		"/api/auth/get-session",
		{},
		z.unknown()
	);
}

afterEach(() => {
	globalThis.fetch = realFetch;
	setUserJwtProvider(() => null);
	if (originalAuthUrl === undefined) {
		delete process.env.RYU_AUTH_URL;
	} else {
		process.env.RYU_AUTH_URL = originalAuthUrl;
	}
	if (originalProfile === undefined) {
		delete process.env.RYU_PROFILE;
	} else {
		process.env.RYU_PROFILE = originalProfile;
	}
});

test("the unconfigured loopback account backend gets no account token or user JWT", async () => {
	// Only the dev profile defaults to the plain-HTTP loopback control plane.
	delete process.env.RYU_AUTH_URL;
	process.env.RYU_PROFILE = "dev";
	setUserJwtProvider(() => PROVIDER_JWT);
	const seen = recordRequests();
	await callEveryAccountBackendPath();
	const backend = seen.filter((entry) =>
		entry.url.startsWith("http://localhost:3000/")
	);
	expect(backend.map((entry) => new URL(entry.url).pathname)).toContain(
		"/api/control-plane/nodes"
	);
	expect(backend.length).toBeGreaterThanOrEqual(4);
	for (const entry of backend) {
		expect(entry.authorization).toBeNull();
		expect(entry.userJwt).toBeNull();
	}
	expect(JSON.stringify(seen)).not.toContain(ACCOUNT_TOKEN);
	expect(JSON.stringify(seen)).not.toContain(PROVIDER_JWT);
});

test("an explicitly configured RYU_AUTH_URL still receives the account token", async () => {
	process.env.RYU_AUTH_URL = "http://localhost:3000";
	const seen = recordRequests();
	await callEveryAccountBackendPath();
	// The public feature-flag read is credential-free by design.
	const credentialed = seen.filter(
		(entry) => new URL(entry.url).pathname !== "/api/feature-flags/public"
	);
	expect(credentialed.length).toBeGreaterThanOrEqual(4);
	for (const entry of credentialed) {
		expect(entry.url.startsWith("http://localhost:3000/")).toBe(true);
		expect(entry.authorization).toBe(`Bearer ${ACCOUNT_TOKEN}`);
	}
});

test("the hosted default account backend keeps its credentials", () => {
	expect(accountBackendTarget(ACCOUNT_TOKEN, {})).toEqual({
		token: ACCOUNT_TOKEN,
		url: "https://api.ryuhq.com",
	});
	// A dev profile without RYU_AUTH_URL is the loopback fallback: credential-free.
	const dev = accountBackendTarget(ACCOUNT_TOKEN, { RYU_PROFILE: "dev" });
	expect(dev.url).toBe("http://localhost:3000");
	expect(dev.fetch).toBeDefined();
});

test("an HTTPS account backend is unaffected", () => {
	const target = accountBackendTarget(ACCOUNT_TOKEN, {
		RYU_AUTH_URL: "https://account.example.test",
	});
	expect(target).toEqual({
		token: ACCOUNT_TOKEN,
		url: "https://account.example.test",
	});
});

function sourceFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) {
			return name === "__tests__" || name === "proof" ? [] : sourceFiles(path);
		}
		return /\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name) ? [path] : [];
	});
}

test("every account-backend target is built by accountBackendTarget", () => {
	const root = join(import.meta.dir, "..");
	const offenders: string[] = [];
	for (const file of sourceFiles(root)) {
		const name = relative(root, file);
		const text = readFileSync(file, "utf8");
		// `controlPlane.ts` resolves the URL itself and `authBackend.ts` is the
		// only caller that turns it into a credential-bearing target.
		if (
			name !== join("core", "authBackend.ts") &&
			name !== join("core", "controlPlane.ts") &&
			/RYU_AUTH_URL\s*\?/u.test(text)
		) {
			offenders.push(`${name}: reads RYU_AUTH_URL itself`);
		}
		if (/url:\s*(?:AUTH_BACKEND_URL|authBackendUrl\(\))/u.test(text)) {
			offenders.push(`${name}: builds a raw account-backend target`);
		}
	}
	expect(offenders).toEqual([]);
});
