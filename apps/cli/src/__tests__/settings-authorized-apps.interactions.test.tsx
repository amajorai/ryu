/* @jsxImportSource @opentui/react */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { act } from "react";
import { App } from "../App.tsx";
import { renderTerminalSvg } from "../proof/render-terminal-svg.ts";
import { testRender } from "./cli-test-render.ts";

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
const proofDirectory = mkdtempSync(join(tmpdir(), "ryu-cli-oauth-proof-"));
afterAll(() => rmSync(proofDirectory, { recursive: true, force: true }));
type Setup = Awaited<ReturnType<typeof testRender>>;
let testSetup: Setup | null = null;

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
});

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

// Core's /api/auth/status publisher always serializes all five fields.
function coreAuthStatus(token: string | null) {
	return {
		authenticated: token !== null,
		pending: false,
		token,
		userCode: null,
		verificationUri: null,
	};
}

async function waitForFrame(
	setup: Setup,
	predicate: (frame: string) => boolean,
	maxFrames = 40
): Promise<string> {
	let frame = setup.captureCharFrame();
	for (let pass = 0; pass < maxFrames && !predicate(frame); pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
		frame = setup.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Settings Profile render did not match: ${frame}`);
	}
	return frame;
}

async function openSettings(setup: Setup): Promise<void> {
	await press(setup, { name: "k", ctrl: true });
	for (const character of "settings") {
		await press(setup, { name: character });
	}
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Node connection is managed")
	);
}

async function focusProfilePanel(setup: Setup): Promise<void> {
	for (let step = 0; step < 6; step += 1) {
		await press(setup, { name: "down" });
	}
	// Memory owns Up/Down for its rows; use the documented panel shortcut to
	// continue to Profile without changing a Memory preference.
	for (let step = 0; step < 4; step += 1) {
		await press(setup, { name: "j" });
	}
}

test("production Settings lists authorized apps, cancels, retries denied revoke, and confirms readback", async () => {
	let apps = [
		{
			clientId: "fixture/app",
			clientName: "Fixture Calendar",
			scopes: "calendar:read",
		},
	];
	let denied = true;
	const writes: Array<{ path: string; authorization: string | null }> = [];
	globalThis.fetch = Object.assign(
		async (
			input: Parameters<typeof realFetch>[0],
			init?: Parameters<typeof realFetch>[1]
		): ReturnType<typeof realFetch> => {
			const url = new URL(String(input));
			if (url.pathname === "/api/auth/status") {
				return Response.json(coreAuthStatus("account-fixture-token"));
			}
			if (url.pathname === "/api/auth/get-session") {
				return Response.json({
					user: { name: "Fixture", email: "fixture@example.test" },
				});
			}
			if (url.pathname === "/api/preferences/user-personalization") {
				return Response.json({ value: "{}" });
			}
			if (url.pathname === "/api/oauth-apps") {
				return Response.json({ apps });
			}
			if (init?.method === "DELETE") {
				writes.push({
					path: url.pathname,
					authorization: new Headers(init.headers).get("authorization"),
				});
				if (denied) {
					return Response.json({ error: "Forbidden" }, { status: 403 });
				}
				apps = [];
				return Response.json({ success: true });
			}
			return Response.json({});
		},
		{ preconnect: realFetch.preconnect }
	);
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 44,
	});
	testSetup = setup;
	await openSettings(setup);
	await focusProfilePanel(setup);
	for (let i = 0; i < 3; i++) {
		await press(setup, { name: "j" });
	}
	await waitForFrame(setup, (frame) => frame.includes("Fixture Calendar"));
	await press(setup, { name: "x" });
	await waitForFrame(setup, (frame) => frame.includes("y confirm"));
	await press(setup, { name: "n" });
	expect(writes).toHaveLength(0);
	await press(setup, { name: "x" });
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) => frame.includes("Could not revoke"));
	expect(apps).toHaveLength(1);
	denied = false;
	await press(setup, { name: "y" });
	const frame = await waitForFrame(setup, (frame) =>
		frame.includes("Authorization revoked and confirmed.")
	);
	expect(frame).toContain("No authorized applications.");
	expect(writes).toEqual([
		{
			path: "/api/oauth-apps/fixture%2Fapp",
			authorization: "Bearer account-fixture-token",
		},
		{
			path: "/api/oauth-apps/fixture%2Fapp",
			authorization: "Bearer account-fixture-token",
		},
	]);
	await Bun.write(join(proofDirectory, "oauth-revoked.txt"), frame);
});
test("signed-out Settings never calls account OAuth API", async () => {
	const calls: string[] = [];
	globalThis.fetch = Object.assign(
		async (
			input: Parameters<typeof realFetch>[0]
		): ReturnType<typeof realFetch> => {
			const url = new URL(String(input));
			calls.push(url.pathname);
			return Response.json(
				url.pathname === "/api/auth/status" ? coreAuthStatus(null) : {}
			);
		},
		{ preconnect: realFetch.preconnect }
	);
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 44,
	});
	testSetup = setup;
	await openSettings(setup);
	await focusProfilePanel(setup);
	for (let i = 0; i < 3; i++) {
		await press(setup, { name: "j" });
	}
	await waitForFrame(setup, (frame) => frame.includes("manage applications."));
	await press(setup, { name: "x" });
	expect(calls).not.toContain("/api/oauth-apps");
});

test("Authorized Apps arrows select bounded rows and reload retries a failed read with authenticated readback", async () => {
	let apps = [
		{
			clientId: "first/app",
			clientName: "First Calendar",
			scopes: "calendar:read",
		},
		{
			clientId: "second/app",
			clientName: "Second Notes",
			scopes: "notes:read",
		},
	];
	let denyRead = false;
	const calls: Array<{
		path: string;
		method: string;
		authorization: string | null;
	}> = [];
	globalThis.fetch = Object.assign(
		async (
			input: Parameters<typeof realFetch>[0],
			init?: Parameters<typeof realFetch>[1]
		): ReturnType<typeof realFetch> => {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			calls.push({
				path: url.pathname,
				method,
				authorization: new Headers(init?.headers).get("authorization"),
			});
			if (url.pathname === "/api/auth/status") {
				return Response.json(coreAuthStatus("oauth-selection-token"));
			}
			if (url.pathname === "/api/auth/get-session") {
				return Response.json({
					user: { name: "Fixture", email: "fixture@example.test" },
				});
			}
			if (url.pathname === "/api/preferences/user-personalization") {
				return Response.json({ value: "{}" });
			}
			if (url.pathname === "/api/oauth-apps") {
				if (denyRead) {
					return Response.json({ error: "Read denied" }, { status: 403 });
				}
				return Response.json({ apps });
			}
			if (
				method === "DELETE" &&
				url.pathname === "/api/oauth-apps/second%2Fapp"
			) {
				apps = apps.filter((app) => app.clientId !== "second/app");
				return Response.json({ success: true });
			}
			return Response.json({});
		},
		{ preconnect: realFetch.preconnect }
	);
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 44,
	});
	testSetup = setup;
	await openSettings(setup);
	await focusProfilePanel(setup);
	for (let index = 0; index < 3; index++) {
		await press(setup, { name: "j" });
	}
	await waitForFrame(setup, (frame) => frame.includes("› First Calendar"));
	await press(setup, { name: "up" });
	expect(setup.captureCharFrame()).toContain("› First Calendar");
	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) => frame.includes("› Second Notes"));
	await press(setup, { name: "down" });
	expect(setup.captureCharFrame()).toContain("› Second Notes");
	await press(setup, { name: "up" });
	await waitForFrame(setup, (frame) => frame.includes("› First Calendar"));
	await press(setup, { name: "down" });
	const readsBefore = calls.filter(
		(call) => call.path === "/api/oauth-apps"
	).length;
	denyRead = true;
	await press(setup, { name: "r" });
	await waitForFrame(setup, (frame) =>
		frame.includes("/api/oauth-apps failed: 403")
	);
	await press(setup, { name: "x" });
	await press(setup, { name: "y" });
	expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
	denyRead = false;
	await press(setup, { name: "r" });
	await waitForFrame(setup, (frame) => frame.includes("› Second Notes"));
	expect(calls.filter((call) => call.path === "/api/oauth-apps")).toHaveLength(
		readsBefore + 2
	);
	await press(setup, { name: "x" });
	await waitForFrame(setup, (frame) => frame.includes("Revoke Second Notes?"));
	await press(setup, { name: "y" });
	const frame = await waitForFrame(setup, (frame) =>
		frame.includes("Authorization revoked and confirmed.")
	);
	expect(frame).toContain("› First Calendar");
	expect(frame).not.toContain("Second Notes");
	expect(calls.filter((call) => call.method === "DELETE")).toEqual([
		{
			path: "/api/oauth-apps/second%2Fapp",
			method: "DELETE",
			authorization: "Bearer oauth-selection-token",
		},
	]);
	const writeIndex = calls.findIndex((call) => call.method === "DELETE");
	expect(calls.slice(writeIndex + 1)).toContainEqual({
		path: "/api/oauth-apps",
		method: "GET",
		authorization: "Bearer oauth-selection-token",
	});
	expect(apps.map((app) => app.clientId)).toEqual(["first/app"]);
	await Bun.write(
		join(proofDirectory, "oauth-selection-reload-confirmed.txt"),
		frame
	);
	await Bun.write(
		join(proofDirectory, "oauth-selection-reload-confirmed.svg"),
		renderTerminalSvg(setup.captureSpans())
	);
}, 30_000);
