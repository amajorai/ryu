/* @jsxImportSource @opentui/react */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import type { z } from "zod";
import { App } from "../App.tsx";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import { testRender } from "./cli-test-render.ts";

// The configured local account service these flows run against.
const AUTH_BACKEND_URL = "http://localhost:3000";
const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
type Setup = Awaited<ReturnType<typeof testRender>>;
let testSetup: Setup | null = null;

const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;
let configDir: string | undefined;
beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "ryu-sessions-state-"));
	process.env.RYU_CLI_CONFIG_DIR = configDir;
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath()
	);
});
const originalAuthUrl = process.env.RYU_AUTH_URL;

beforeEach(() => {
	// These flows use a configured local account service. The unconfigured
	// loopback default is never sent account credentials (core/authBackend.ts).
	process.env.RYU_AUTH_URL = "http://localhost:3000";
});

afterEach(() => {
	if (originalAuthUrl === undefined) {
		delete process.env.RYU_AUTH_URL;
	} else {
		process.env.RYU_AUTH_URL = originalAuthUrl;
	}
});

afterEach(async () => {
	globalThis.fetch = realFetch;
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
	if (originalConfigDir === undefined) {
		delete process.env.RYU_CLI_CONFIG_DIR;
	} else {
		process.env.RYU_CLI_CONFIG_DIR = originalConfigDir;
	}
	if (configDir) {
		rmSync(configDir, { recursive: true, force: true });
	}
	configDir = undefined;
});

interface SessionFixture {
	createdAt: string;
	expiresAt: string;
	id: string;
	ipAddress?: string;
	isCurrent?: unknown;
	userAgent?: string;
	userId: string;
}

interface RequestRecord {
	authorization: string | null;
	body?: z.infer<typeof appResponseValueSchema>;
	method: string;
	origin: string;
	path: string;
}

interface CoreOptions {
	failFirstListRead?: boolean;
	failNextRevoke?: boolean;
	initialSessions?: SessionFixture[];
	status?: { authenticated: boolean; token?: string };
}

// Core's /api/auth/status publisher always serializes all five fields.
function coreAuthStatus(status: { authenticated: boolean; token?: string }) {
	return {
		authenticated: status.authenticated,
		pending: false,
		token: status.token ?? null,
		userCode: null,
		verificationUri: null,
	};
}

function installSessionCore(options: CoreOptions = {}) {
	const sessions = [...(options.initialSessions ?? [])];
	const requests: RequestRecord[] = [];
	let failFirstListRead = options.failFirstListRead ?? false;
	let failNextRevoke = options.failNextRevoke ?? false;
	const provide = async (
		...args: Parameters<typeof realFetch>
	): ReturnType<typeof realFetch> => {
		const [input, init] = args;
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		if (url.pathname === "/api/preferences/terminal-theme") {
			return Response.json({ value: { mode: "system", preset: "ryu" } });
		}
		if (
			url.origin === LOCAL_TARGET.url &&
			url.pathname === "/api/auth/status"
		) {
			requests.push({
				authorization: new Headers(init?.headers).get("authorization"),
				method,
				origin: url.origin,
				path: url.pathname,
			});
			return Response.json(
				coreAuthStatus(
					options.status ?? { authenticated: true, token: "account-token" }
				)
			);
		}
		if (
			url.origin === AUTH_BACKEND_URL &&
			url.pathname.startsWith("/api/sessions")
		) {
			const body = init?.body
				? appResponseValueSchema.parse(JSON.parse(String(init.body)))
				: undefined;
			requests.push({
				authorization: new Headers(init?.headers).get("authorization"),
				body,
				method,
				origin: url.origin,
				path: url.pathname,
			});
			if (method === "GET") {
				if (failFirstListRead) {
					failFirstListRead = false;
					return Response.json(
						{ error: "temporary sessions read failure" },
						{ status: 503 }
					);
				}
				return Response.json({ sessions });
			}
			if (method === "DELETE" && url.pathname === "/api/sessions") {
				const currentId = "current-session";
				for (let index = sessions.length - 1; index >= 0; index -= 1) {
					if (sessions[index]?.id !== currentId) {
						sessions.splice(index, 1);
					}
				}
				return Response.json({
					success: true,
					message: "All other sessions revoked",
				});
			}
			if (method === "DELETE" && url.pathname.startsWith("/api/sessions/")) {
				if (failNextRevoke) {
					failNextRevoke = false;
					return Response.json(
						{ error: "temporary session revoke failure" },
						{ status: 503 }
					);
				}
				const sessionId = decodeURIComponent(
					url.pathname.slice("/api/sessions/".length)
				);
				const index = sessions.findIndex((session) => session.id === sessionId);
				if (index < 0) {
					return Response.json({ error: "Session not found" }, { status: 404 });
				}
				if (sessions[index]?.id === "current-session") {
					return Response.json(
						{ error: "Cannot revoke current session" },
						{ status: 400 }
					);
				}
				sessions.splice(index, 1);
				return Response.json({ success: true, message: "Session revoked" });
			}
		}
		return Response.json({});
	};
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});
	return { requests, sessions };
}

interface KeyInput {
	ctrl?: boolean;
	name: string;
}

async function press(setup: Setup, key: KeyInput): Promise<void> {
	const keyInput = setup.renderer.keyInput;
	await act(async () => {
		keyInput.emit(
			"keypress",
			new KeyEvent({
				name: key.name,
				sequence: key.name.length === 1 ? key.name : "",
				ctrl: key.ctrl ?? false,
				shift: false,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: key.name.length === 1 ? key.name : "",
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
	});
}

async function waitForFrame(
	setup: Setup,
	predicate: (frame: string) => boolean,
	maxFrames = 100
): Promise<string> {
	let frame = setup.captureCharFrame();
	for (let pass = 0; pass < maxFrames && !predicate(frame); pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
		frame = setup.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Sessions settings render did not match: ${frame}`);
	}
	return frame;
}

async function renderApp(): Promise<Setup> {
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 180,
		height: 48,
	});
	testSetup = setup;
	await setup.renderOnce();
	return setup;
}

async function selectSessions(setup: Setup): Promise<string> {
	for (let step = 0; step < 30; step += 1) {
		const frame = setup.captureCharFrame();
		if (frame.split("\n").some((row) => row.includes("› Sessions"))) {
			return frame;
		}
		await press(setup, { name: "j" });
		await setup.flush({ maxPasses: 12 });
	}
	throw new Error(
		`Settings Sessions was not reachable: ${setup.captureCharFrame()}`
	);
}

async function openSessions(setup: Setup): Promise<string> {
	await waitForFrame(setup, (frame) => frame.includes("› Message"));
	await press(setup, { name: "k", ctrl: true });
	for (const character of "settings") {
		await press(setup, { name: character });
	}
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Node connection is managed")
	);
	await selectSessions(setup);
	return waitForFrame(setup, (frame) => frame.includes("Sessions & devices"));
}

function newerRemoteSessions() {
	const sessions = fixtureSessions().reverse();
	const first = sessions[0];
	if (first) {
		first.createdAt = "2026-10-08T08:00:00.000Z";
	}
	return sessions;
}

function fixtureSessions(): SessionFixture[] {
	return [
		{
			id: "current-session",
			isCurrent: true,
			userId: "account-user",
			createdAt: "2026-10-01T08:00:00.000Z",
			expiresAt: "2026-10-08T08:00:00.000Z",
			userAgent: "Chrome/140.0.0.0",
			ipAddress: "192.0.2.10",
		},
		{
			id: "remote-session",
			isCurrent: false,
			userId: "account-user",
			createdAt: "2026-09-30T08:00:00.000Z",
			expiresAt: "2026-10-07T08:00:00.000Z",
			userAgent: "Firefox/142.0",
			ipAddress: "192.0.2.20",
		},
	];
}

test("Settings Sessions lists Better Auth devices and revokes a selected remote session with exact path and readback", async () => {
	const core = installSessionCore({ initialSessions: fixtureSessions() });
	const setup = await renderApp();
	const initial = await openSessions(setup);
	expect(initial).toContain("Chrome");
	expect(initial).toContain("This device");
	expect(initial).toContain("Firefox");
	expect(initial).toContain("192.0.2.20");
	expect(
		core.requests.some(
			(request) =>
				request.method === "GET" &&
				request.origin === AUTH_BACKEND_URL &&
				request.path === "/api/sessions" &&
				request.authorization === "Bearer account-token"
		)
	).toBe(true);
	expect(core.requests.some((request) => request.method === "DELETE")).toBe(
		false
	);

	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) => frame.includes("› Firefox"));
	await press(setup, { name: "x" });
	const confirmed = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Session revoked and confirmed.") &&
			!frame.includes("Firefox")
	);
	expect(confirmed).toContain("Chrome");
	expect(core.sessions.map((session) => session.id)).toEqual([
		"current-session",
	]);
	expect(
		core.requests.filter((request) => request.method === "DELETE")
	).toEqual([
		{
			authorization: "Bearer account-token",
			method: "DELETE",
			origin: AUTH_BACKEND_URL,
			path: "/api/sessions/remote-session",
		},
	]);
	expect(
		core.requests.filter(
			(request) => request.method === "GET" && request.path === "/api/sessions"
		)
	).toHaveLength(2);
});

test("Settings Sessions protects the current device and requires confirmation before revoking others", async () => {
	const core = installSessionCore({ initialSessions: fixtureSessions() });
	const setup = await renderApp();
	await openSessions(setup);
	await press(setup, { name: "x" });
	await waitForFrame(setup, (frame) =>
		frame.includes("This device's session can't be revoked here.")
	);
	expect(core.requests.some((request) => request.method === "DELETE")).toBe(
		false
	);

	await press(setup, { name: "a" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Revoke all other sessions?") &&
			frame.includes("y confirm · n cancel")
	);
	await press(setup, { name: "n" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Session revocation cancelled.")
	);
	expect(core.requests.some((request) => request.method === "DELETE")).toBe(
		false
	);
	expect(core.sessions).toHaveLength(2);

	await press(setup, { name: "a" });
	await press(setup, { name: "y" });
	const confirmed = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Other sessions revoked and confirmed.") &&
			!frame.includes("Firefox")
	);
	expect(confirmed).toContain("This device");
	expect(core.sessions.map((session) => session.id)).toEqual([
		"current-session",
	]);
	expect(
		core.requests.filter((request) => request.method === "DELETE")
	).toEqual([
		{
			authorization: "Bearer account-token",
			method: "DELETE",
			origin: AUTH_BACKEND_URL,
			path: "/api/sessions",
		},
	]);
});

test("Settings Sessions keeps a remote device visible when revoke fails and refreshes on retry", async () => {
	const core = installSessionCore({
		failNextRevoke: true,
		initialSessions: fixtureSessions(),
	});
	const setup = await renderApp();
	await openSessions(setup);
	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) => frame.includes("› Firefox"));
	await press(setup, { name: "x" });
	const failed = await waitForFrame(setup, (frame) =>
		frame.includes("Couldn't revoke this session:")
	);
	expect(failed).toContain("Firefox");
	expect(core.sessions.map((session) => session.id)).toEqual([
		"current-session",
		"remote-session",
	]);
	await press(setup, { name: "r" });
	const refreshed = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Firefox") &&
			!frame.includes("Couldn't revoke this session:")
	);
	expect(refreshed).toContain("Chrome");
	expect(refreshed).toContain("This device");
	expect(
		core.requests.filter((request) => request.method === "DELETE")
	).toEqual([
		{
			authorization: "Bearer account-token",
			method: "DELETE",
			origin: AUTH_BACKEND_URL,
			path: "/api/sessions/remote-session",
		},
	]);
});

test("Settings Sessions retries a failed list read and does not call Better Auth while signed out", async () => {
	const core = installSessionCore({
		failFirstListRead: true,
		initialSessions: fixtureSessions(),
	});
	const setup = await renderApp();
	await waitForFrame(setup, (frame) => frame.includes("› Message"));
	await press(setup, { name: "k", ctrl: true });
	for (const character of "settings") {
		await press(setup, { name: character });
	}
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Node connection is managed")
	);
	await selectSessions(setup);
	await waitForFrame(setup, (frame) =>
		frame.includes("Couldn't load sessions:")
	);
	await press(setup, { name: "r" });
	const loaded = await waitForFrame(
		setup,
		(frame) => frame.includes("Chrome") && frame.includes("Firefox")
	);
	expect(loaded).toContain("Sessions & devices");
	expect(
		core.requests.filter(
			(request) => request.method === "GET" && request.path === "/api/sessions"
		)
	).toHaveLength(2);
	expect(core.requests.some((request) => request.method === "DELETE")).toBe(
		false
	);

	await act(async () => {
		setup.renderer.destroy();
		await Promise.resolve();
	});
	const signedOutCore = installSessionCore({
		status: { authenticated: false },
	});
	const signedOutSetup = await renderApp();
	await openSessions(signedOutSetup);
	await waitForFrame(signedOutSetup, (frame) =>
		frame.includes("Sign in from Settings → Account")
	);
	await press(signedOutSetup, { name: "x" });
	await press(signedOutSetup, { name: "a" });
	expect(
		signedOutCore.requests.some(
			(request) => request.origin === AUTH_BACKEND_URL
		)
	).toBe(false);
	expect(
		signedOutCore.requests.some((request) => request.method === "DELETE")
	).toBe(false);
});

test("Settings Sessions protects the older flagged device and allows revoking the newer first row", async () => {
	const core = installSessionCore({ initialSessions: newerRemoteSessions() });
	const setup = await renderApp();
	await openSessions(setup);
	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) => frame.includes("› Chrome"));
	await press(setup, { name: "x" });
	await waitForFrame(setup, (frame) =>
		frame.includes("This device's session can't be revoked here.")
	);
	expect(
		core.requests.filter((request) => request.method === "DELETE")
	).toHaveLength(0);
	await press(setup, { name: "up" });
	await press(setup, { name: "x" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Session revoked and confirmed.") &&
			!frame.includes("Firefox")
	);
	expect(core.sessions.map((session) => session.id)).toEqual([
		"current-session",
	]);
	expect(
		core.requests
			.filter((request) => request.method === "DELETE")
			.map((request) => request.path)
	).toEqual(["/api/sessions/remote-session"]);
});

test("Settings revoke others preserves the flagged device rather than the newest device", async () => {
	const core = installSessionCore({ initialSessions: newerRemoteSessions() });
	const setup = await renderApp();
	await openSessions(setup);
	await press(setup, { name: "a" });
	await press(setup, { name: "y" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Other sessions revoked and confirmed.") &&
			!frame.includes("Firefox")
	);
	expect(core.sessions.map((session) => session.id)).toEqual([
		"current-session",
	]);
	expect(
		core.requests
			.filter((request) => request.method === "DELETE")
			.map((request) => request.path)
	).toEqual(["/api/sessions"]);
});

test.each([
	undefined,
	"true",
	1,
])("Settings does not invent current identity from invalid flag %p", async (flag) => {
	const sessions = fixtureSessions();
	const first = sessions[0];
	if (first) {
		first.isCurrent = flag;
	}
	const core = installSessionCore({ initialSessions: sessions });
	const setup = await renderApp();
	const initial = await openSessions(setup);
	expect(initial).not.toContain("This device");
	await press(setup, { name: "a" });
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) =>
		frame.includes("did not identify this device's session")
	);
	expect(
		core.requests.filter((request) => request.method === "DELETE")
	).toHaveLength(0);
	expect(core.sessions.map((session) => session.id)).toEqual([
		"current-session",
		"remote-session",
	]);
});
