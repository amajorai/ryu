/* @jsxImportSource @opentui/react */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { act } from "react";
import { App } from "../App.tsx";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import {
	fixtureRecordSchema,
	parseFixtureJson,
} from "../proof/cli-fixture-contract.ts";
import { testRender } from "./cli-test-render.ts";

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
type Setup = Awaited<ReturnType<typeof testRender>>;
let testSetup: Setup | null = null;

const originalRyuDir = process.env.RYU_DIR;
let fixtureDirectory = "";
beforeEach(() => {
	fixtureDirectory = mkdtempSync(join(tmpdir(), "ryu-cli-connections-"));
	process.env.RYU_DIR = fixtureDirectory;
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath()
	);
});
afterEach(async () => {
	rmSync(fixtureDirectory, { recursive: true, force: true });
	if (originalRyuDir === undefined) {
		delete process.env.RYU_DIR;
	} else {
		process.env.RYU_DIR = originalRyuDir;
	}
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

async function waitForFrame(
	setup: Setup,
	predicate: (frame: string) => boolean,
	maxFrames = 60
): Promise<string> {
	let frame = setup.captureCharFrame();
	for (let pass = 0; pass < maxFrames && !predicate(frame); pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
		frame = setup.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Settings Connections render did not match: ${frame}`);
	}
	return frame;
}

async function openConnections(setup: Setup): Promise<void> {
	await press(setup, { name: "k", ctrl: true });
	for (const character of "settings") {
		await press(setup, { name: character });
	}
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Node connection is managed")
	);
	// General → Connections is thirteen panel steps now that Island is not a
	// CLI panel.
	for (let index = 0; index < 13; index += 1) {
		await press(setup, { name: "j" });
	}
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Loading Composio connections") ||
			frame.includes("Could not load connections:") ||
			frame.includes("Composio is not configured") ||
			frame.includes("Gmail (gmail)")
	);
}

test("Settings Connections retries Core failures, starts with the chosen action ceiling, and polls persisted readback", async () => {
	let composioStatusReads = 0;
	let initiateAttempts = 0;
	let statusAttempts = 0;
	let connectionActive = false;
	const requests: Array<{ body?: unknown; method: string; path: string }> = [];
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const method = init?.method ?? "GET";
			const body = init?.body
				? fixtureRecordSchema.parse(parseFixtureJson(String(init.body)))
				: undefined;
			requests.push({ body, method, path: url.pathname });
			if (url.pathname === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			if (url.pathname === "/api/composio/status") {
				composioStatusReads += 1;
				if (composioStatusReads === 1) {
					return Response.json(
						{ error: "temporary status outage" },
						{ status: 503 }
					);
				}
				return Response.json({
					configured: true,
					base_url: "https://connect.example.test",
				});
			}
			if (url.pathname === "/api/composio/toolkits") {
				return Response.json({
					data: [
						{ slug: "gmail", name: "Gmail", description: "Email" },
						{ slug: "slack", name: "Slack", description: "Messaging" },
					],
				});
			}
			if (url.pathname === "/api/composio/connections" && method === "GET") {
				return Response.json({
					data: connectionActive
						? [
								{
									id: "conn-42",
									toolkit: "gmail",
									status: "ACTIVE",
									active: true,
									access_level: "read_only",
								},
							]
						: [],
				});
			}
			if (
				url.pathname === "/api/composio/connections/initiate" &&
				method === "POST"
			) {
				initiateAttempts += 1;
				if (initiateAttempts === 1) {
					return Response.json(
						{ error: "temporary initiate outage" },
						{ status: 502 }
					);
				}
				return Response.json({
					access_level: "read_only",
					connection_id: "conn-42",
					redirect_url: "https://connect.example.test/authorize/conn-42",
					status: "INITIATED",
				});
			}
			if (
				url.pathname === "/api/composio/connections/conn-42" &&
				method === "GET"
			) {
				statusAttempts += 1;
				if (statusAttempts === 1) {
					return Response.json(
						{ error: "temporary poll outage" },
						{ status: 503 }
					);
				}
				connectionActive = true;
				return Response.json({ id: "conn-42", status: "ACTIVE", active: true });
			}
			return Response.json({});
		},
		realFetch
	);

	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	testSetup = setup;
	await setup.renderOnce();
	await waitForFrame(setup, (frame) => frame.includes("Message"));
	await openConnections(setup);
	await waitForFrame(setup, (frame) =>
		frame.includes("Could not load connections:")
	);
	expect(composioStatusReads).toBe(1);

	await press(setup, { name: "r" });
	const loaded = await waitForFrame(setup, (frame) =>
		frame.includes("Gmail (gmail)")
	);
	expect(loaded).toContain("New connection access: Risk-based");
	expect(
		requests.filter((item) => item.path === "/api/composio/toolkits")
	).toHaveLength(1);
	expect(
		requests.filter(
			(item) =>
				item.path === "/api/composio/connections" && item.method === "GET"
		)
	).toHaveLength(1);

	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) => frame.includes("› Slack (slack)"));
	await press(setup, { name: "up" });
	await waitForFrame(setup, (frame) => frame.includes("› Gmail (gmail)"));
	for (const label of [
		"Read-only",
		"Write",
		"Full",
		"Risk-based",
		"Read-only",
	]) {
		await press(setup, { name: "v" });
		await waitForFrame(setup, (frame) =>
			frame.includes(`New connection access: ${label}`)
		);
	}
	await press(setup, { name: "c" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Could not start the connection:")
	);
	await press(setup, { name: "c" });
	const initiated = await waitForFrame(setup, (frame) =>
		frame.includes("https://connect.example.test/authorize/conn-42")
	);
	expect(initiated).toContain("Gmail authorization · INITIATED");
	expect(
		requests
			.filter(
				(item) =>
					item.path === "/api/composio/connections/initiate" &&
					item.method === "POST"
			)
			.map((item) => item.body)
	).toEqual([
		{ access_level: "read_only", toolkit: "gmail" },
		{ access_level: "read_only", toolkit: "gmail" },
	]);

	await press(setup, { name: "p" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Could not check the connection:")
	);
	await press(setup, { name: "p" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Gmail (gmail) · connected · Read-only")
	);
	expect(initiated).toContain("https://connect.example.test/authorize/conn-42");
	expect(
		requests.filter(
			(item) =>
				item.path === "/api/composio/connections/conn-42" &&
				item.method === "GET"
		)
	).toHaveLength(2);
	expect(connectionActive).toBe(true);
	await press(setup, { name: "c" });
	expect(initiateAttempts).toBe(2);
});

test("Settings Connections never initiates when Composio is not configured on the active Core node", async () => {
	let initiated = 0;
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.pathname === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			if (url.pathname === "/api/composio/status") {
				return Response.json({ configured: false });
			}
			if (
				url.pathname === "/api/composio/connections/initiate" &&
				init?.method === "POST"
			) {
				initiated += 1;
			}
			return Response.json({});
		},
		realFetch
	);

	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	testSetup = setup;
	await setup.renderOnce();
	await waitForFrame(setup, (frame) => frame.includes("Message"));
	await openConnections(setup);
	const unavailable = await waitForFrame(setup, (frame) =>
		frame.includes("Composio is not configured")
	);
	expect(unavailable).toContain("Gateway → Keys");
	await press(setup, { name: "c" });
	await press(setup, { name: "r" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Composio is not configured")
	);
	expect(initiated).toBe(0);
});

test("Settings Connections rejects a non-HTTPS redirect returned by Core", async () => {
	const requests: Array<{ body?: unknown; method: string; url: string }> = [];
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			requests.push({
				body: init?.body
					? fixtureRecordSchema.parse(parseFixtureJson(String(init.body)))
					: undefined,
				method: init?.method ?? "GET",
				url: url.toString(),
			});
			if (url.pathname === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			if (url.pathname === "/api/composio/status") {
				return Response.json({ configured: true });
			}
			if (url.pathname === "/api/composio/toolkits") {
				return Response.json({ data: [{ slug: "gmail", name: "Gmail" }] });
			}
			if (
				url.pathname === "/api/composio/connections" &&
				(init?.method ?? "GET") === "GET"
			) {
				return Response.json({ data: [] });
			}
			if (
				url.pathname === "/api/composio/connections/initiate" &&
				init?.method === "POST"
			) {
				return Response.json({
					connection_id: "conn-unsafe",
					redirect_url: "javascript:alert(1)",
					status: "INITIATED",
				});
			}
			return Response.json({});
		},
		realFetch
	);

	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	testSetup = setup;
	await setup.renderOnce();
	await waitForFrame(setup, (frame) => frame.includes("Message"));
	await openConnections(setup);
	await waitForFrame(setup, (frame) => frame.includes("Gmail (gmail)"));
	await press(setup, { name: "c" });
	// The Settings card can wrap this sentence between terminal rows. Read its
	// interior cells so the surrounding sidebar does not interrupt the message.
	const cardText = (frame: string): string =>
		frame
			.split("\n")
			.map((line) => (line.split("│")[1] ?? "").split("█").at(-1) ?? "")
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
	const error =
		"Could not start the connection: Core returned a non-HTTPS connection URL.";
	const rejected = await waitForFrame(setup, (frame) =>
		cardText(frame).includes(error)
	);
	expect(cardText(rejected)).toContain(error);
	expect(rejected).not.toContain("javascript:alert(1)");
	expect(rejected).not.toContain("Open this URL to authorize");
	expect(rejected).toContain("Gmail (gmail) · not connected");
	expect(requests.filter((entry) => entry.method !== "GET")).toEqual([
		{
			body: { access_level: "risk_based", toolkit: "gmail" },
			method: "POST",
			url: "http://127.0.0.1:7980/api/composio/connections/initiate",
		},
	]);
	const connectionRequests = requests.filter((entry) =>
		entry.url.includes("/api/composio/")
	);
	await press(setup, { name: "p" });
	expect(
		requests.filter((entry) => entry.url.includes("/api/composio/"))
	).toEqual(connectionRequests);
	expect(
		requests.every((entry) => entry.url.startsWith(LOCAL_TARGET.url))
	).toBe(true);
});
