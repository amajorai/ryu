/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { act } from "react";
import { z } from "zod";
import { App } from "../App.tsx";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import {
	type FixtureJson,
	type FixtureRecord,
	fixtureRecordSchema,
	parseFixtureJson,
} from "../proof/cli-fixture-contract.ts";
import { renderTerminalSvg } from "../proof/render-terminal-svg.ts";
import { testRender } from "./cli-test-render.ts";

const FIREWALL = {
	inspector: {
		enabled: false,
		model: "fixture-classifier",
		mode: "both",
		min_chars: 40,
		timeout_ms: 1500,
		action: "block",
	},
	evaluators: [],
	locked_fields: ["enabled"],
	alert: "silent",
	unknown_future_field: { keep: true },
	enabled: false,
	scan_inbound: true,
	scan_outbound: false,
	log_detections: true,
	redact_pii: false,
	redact_secrets: true,
	policy: "block",
	custom_patterns: [{ name: "keep", regex: "fixture", kind: "pii" }],
};

const CUSTOM_EVALUATOR = {
	id: "fixture-custom",
	builtin: false,
	name: "Fixture",
	description: "Fixture regex evaluator",
	category: "custom",
	target: "input",
	capabilities: { inline: true, offline: false },
	impl: { kind: "regex", patterns: ["fixture"] },
	inline: { action: "block" },
	enforced: true,
	higherIsBetter: true,
};

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
type Setup = Awaited<ReturnType<typeof testRender>>;
let testSetup: Setup | null = null;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let isolatedHome: string | null = null;

afterEach(async () => {
	globalThis.fetch = realFetch;
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
	if (isolatedHome) {
		rmSync(isolatedHome, { force: true, recursive: true });
		isolatedHome = null;
	}
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = originalUserProfile;
	}
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
	maxFrames = 100
): Promise<string> {
	let frame = setup.captureCharFrame();
	for (let pass = 0; pass < maxFrames && !predicate(frame); pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
		frame = setup.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(
			`Gateway advanced render did not match ${predicate.toString()}: ${frame}`
		);
	}
	return frame;
}

async function openGateway(setup: Setup): Promise<void> {
	await waitForFrame(
		setup,
		(frame) => frame.includes("Agent") && frame.includes("⌄")
	);
	await press(setup, { name: "k", ctrl: true });
	for (const character of "gateway") {
		await press(setup, { name: character });
	}
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("Overview"));
	await press(setup, { name: "down" });
	await press(setup, { name: "down" });
	await press(setup, { name: "j" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Advanced safety policy")
	);
}

function useConsoleProfile(): void {
	isolatedHome = mkdtempSync(join(tmpdir(), "ryu-cli-gateway-guardrails-"));
	process.env.HOME = isolatedHome;
	delete process.env.USERPROFILE;
	mkdirSync(join(isolatedHome, ".ryu"), { recursive: true });
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath(isolatedHome)
	);
}

async function renderApp(target: ApiTarget = LOCAL_TARGET): Promise<Setup> {
	const setup = await testRender(<App target={target} />, {
		width: 180,
		height: 48,
	});
	testSetup = setup;
	await setup.renderOnce();
	return setup;
}

interface FixtureConfig {
	[key: string]: FixtureJson | undefined;
}
interface FixturePreferences {
	[key: string]: string | null;
}
interface Call {
	authorization: string | null;
	body: FixtureRecord;
	method: string;
	path: string;
}
function installFixture() {
	const config: FixtureConfig = {
		firewall: structuredClone(FIREWALL),
		firewall_org_overlays: {
			"org-existing": { alert: "email", future: "keep" },
		},
		firewall_agent_overlays: {},
		routing: { future: "sibling" },
	};
	let catalog: FixtureJson[] = [{ id: "builtin", builtin: true }];
	let pending: FixtureJson[] = [];
	const preferences: FixturePreferences = {
		"claude-gateway-routing": null,
		"codex-gateway-routing": "true",
		"agent-gateway-routing": JSON.stringify({ "keep-agent": true }),
	};
	const writes: Call[] = [];
	const state = {
		denied: false,
		readDenied: false,
		failOnce: false,
		restartAllowed: true,
		role: "owner",
		normalize: false,
		mismatch: false,
	};
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const path = new URL(input instanceof Request ? input.url : String(input))
				.pathname;
			const method = init?.method ?? "GET";
			const body = init?.body
				? fixtureRecordSchema.parse(parseFixtureJson(String(init.body)))
				: {};
			if (method === "PUT" || method === "POST") {
				writes.push({
					path,
					method,
					body,
					authorization: new Headers(init?.headers).get("authorization"),
				});
				if (state.denied) {
					return Response.json({ error: "forbidden" }, { status: 403 });
				}
				if (state.failOnce) {
					state.failOnce = false;
					return Response.json({ error: "try again" }, { status: 503 });
				}
				if (path === "/api/gateway/config") {
					if (body.custom_evaluators) {
						pending = z.array(z.json()).parse(body.custom_evaluators);
					} else {
						Object.assign(config, body);
						if (state.normalize && body.firewall_agent_overlays) {
							config.firewall_agent_overlays = Object.fromEntries(
								Object.entries(
									fixtureRecordSchema.parse(body.firewall_agent_overlays)
								).map(([id, value]) => [
									id,
									{
										...fixtureRecordSchema.parse(value),
										log_detections: null,
										custom_patterns: [],
									},
								])
							);
						}
						if (state.mismatch) {
							config.firewall_org_overlays = { stale: {} };
						}
					}
				} else if (path === "/api/gateway/restart") {
					if (!state.restartAllowed) {
						return Response.json({ success: false });
					}
					catalog = [{ id: "builtin", builtin: true }, ...pending];
					return Response.json({ success: true });
				} else if (path.startsWith("/api/preferences/")) {
					preferences[path.split("/").at(-1)!] = z
						.string()
						.nullable()
						.parse(body.value);
				} else {
					throw new Error(`Unexpected write ${path}`);
				}
				return Response.json({ ok: true });
			}
			if (path === "/api/gateway/config") {
				return state.readDenied
					? Response.json({ error: "forbidden" }, { status: 403 })
					: Response.json(config);
			}
			if (path === "/api/gateway/evaluators") {
				return Response.json({ evaluators: catalog });
			}
			if (path === "/api/gateway/status") {
				return Response.json({ reachable: true });
			}
			if (path === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			if (
				path.startsWith("/api/preferences/") &&
				path.split("/").at(-1)! in preferences
			) {
				return Response.json({ value: preferences[path.split("/").at(-1)!] });
			}
			if (path === "/api/auth/status") {
				return Response.json({ authenticated: true, token: "fixture-account" });
			}
			if (path === "/api/control-plane/nodes") {
				return Response.json({
					nodes: [
						{
							name: "Fixture",
							orgId: "fixture-org",
							url: "https://managed.example.test",
							userJwt: "fixture-user",
						},
					],
				});
			}
			if (path === "/api/control-plane/me/permissions") {
				return Response.json({
					permissions:
						state.role === "member"
							? ["gateway.view", "agent.run"]
							: ["gateway.view", "gateway.configure", "agent.run"],
				});
			}
			return Response.json({});
		},
		realFetch
	);
	return { config, preferences, writes, state };
}
async function editJson(setup: Setup, value: FixtureJson) {
	await press(setup, { name: "e" });
	await waitForFrame(setup, (frame) => frame.includes("Enter review"));
	await press(setup, { name: "u", ctrl: true });
	await act(async () => {
		await setup.mockInput.typeText(
			z.string().safeParse(value).data ?? JSON.stringify(value),
			1
		);
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });
}
test("Advanced Gateway full node safety JSON retries identical request and reloads persisted readback", async () => {
	const fixture = installFixture();
	useConsoleProfile();
	const setup = await renderApp();
	await openGateway(setup);
	await waitForFrame(setup, (frame) => frame.includes("Node firewall: served"));
	const next = {
		...FIREWALL,
		inspector: { ...FIREWALL.inspector, enabled: true },
		custom_patterns: [{ name: "account", regex: "ACC-[0-9]+", kind: "pii" }],
		evaluators: [{ id: "fixture-binding", enabled: true }],
		locked_fields: ["enabled", "inspector", "alert"],
		alert: "email",
	};
	await editJson(setup, next);
	await waitForFrame(setup, (frame) =>
		frame.includes("Replace the entire firewall section?")
	);
	expect(fixture.writes).toHaveLength(0);
	fixture.state.failOnce = true;
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) => frame.includes("Could not save:"));
	expect(fixture.config.firewall).toEqual(FIREWALL);
	await press(setup, { name: "y" });
	const frame = await waitForFrame(setup, (frame) =>
		frame.includes("Policy saved and confirmed")
	);
	expect(
		fixture.writes.map((call) => ({
			path: call.path,
			method: call.method,
			body: call.body,
		}))
	).toEqual([
		{ path: "/api/gateway/config", method: "PUT", body: { firewall: next } },
		{ path: "/api/gateway/config", method: "PUT", body: { firewall: next } },
	]);
	expect(fixture.config.routing).toEqual({ future: "sibling" });
	expect(fixture.config.firewall).toEqual(next);
	const proof = process.env.RYU_CLI_ADVANCED_PROOF;
	if (proof) {
		writeFileSync(`${proof}.txt`, frame);
		writeFileSync(`${proof}.svg`, renderTerminalSvg(setup.captureSpans()));
		writeFileSync(
			`${proof}.requests.json`,
			JSON.stringify(fixture.writes, null, 2)
		);
	}
	await press(setup, { name: "escape" });
	await openGateway(setup);
	await press(setup, { name: "e" });
	await waitForFrame(
		setup,
		(frame) => frame.includes("account") && frame.includes("Enter review")
	);
	expect(fixture.writes).toHaveLength(2);
}, 30_000);
test("Advanced Gateway invalid JSON, unsupported overlay fields and cancel never write", async () => {
	const fixture = installFixture();
	useConsoleProfile();
	const setup = await renderApp();
	await openGateway(setup);
	await waitForFrame(setup, (frame) => frame.includes("Node firewall: served"));
	await editJson(setup, "{");
	await waitForFrame(setup, (frame) => frame.includes("Invalid policy JSON"));
	expect(fixture.writes).toHaveLength(0);
	await press(setup, { name: "tab" });
	await editJson(setup, {
		...FIREWALL,
		inspector: { ...FIREWALL.inspector, model: "  " },
	});
	await waitForFrame(setup, (frame) => frame.includes("nonblank model ID"));
	expect(fixture.writes).toHaveLength(0);
	await press(setup, { name: "tab" });
	await press(setup, { name: "down" });
	await editJson(setup, { org: { wrap_untrusted_tool_results: true } });
	await waitForFrame(setup, (frame) => frame.includes("Invalid policy JSON"));
	expect(fixture.writes).toHaveLength(0);
	await press(setup, { name: "tab" });
	await editJson(setup, { org: { alert: "email" } });
	await waitForFrame(setup, (frame) => frame.includes("y save replacement"));
	await press(setup, { name: "n" });
	await press(setup, { name: "tab" });
	expect(fixture.writes).toHaveLength(0);
}, 30_000);
test("Advanced Gateway conflict protects newer policy and rejected map writes retain identical retry", async () => {
	const fixture = installFixture();
	useConsoleProfile();
	const setup = await renderApp();
	await openGateway(setup);
	await waitForFrame(setup, (frame) =>
		frame.includes("Organization overlays: served")
	);
	await press(setup, { name: "down" });
	const next = {
		"org-existing": {
			alert: "fanout",
			future: "keep",
			inspector: null,
			locked_fields: ["alert"],
		},
	};
	await editJson(setup, next);
	fixture.config.firewall_org_overlays = { concurrent: { enabled: true } };
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Concurrent policy change")
	);
	expect(fixture.writes).toHaveLength(0);
	await press(setup, { name: "n" });
	await press(setup, { name: "tab" });
	await press(setup, { name: "r" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Organization overlays: served")
	);
	await editJson(setup, next);
	fixture.state.denied = true;
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) => frame.includes("Could not save:"));
	expect(fixture.config.firewall_org_overlays).toEqual({
		concurrent: { enabled: true },
	});
	fixture.state.denied = false;
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Policy saved and confirmed")
	);
	expect(fixture.writes).toHaveLength(2);
	expect(fixture.writes[0]?.body).toEqual(fixture.writes[1]?.body);
	expect(fixture.config.firewall_org_overlays).toEqual(next);
	expect(fixture.config.firewall_agent_overlays).toEqual({});
}, 30_000);
test("Advanced Gateway refuses unserved sections and denied reads until successful reload", async () => {
	const fixture = installFixture();
	fixture.config.firewall_agent_overlays = undefined;
	fixture.state.readDenied = true;
	useConsoleProfile();
	const setup = await renderApp();
	await openGateway(setup);
	await waitForFrame(setup, (frame) =>
		frame.includes("Could not load advanced policy")
	);
	await press(setup, { name: "e" });
	expect(fixture.writes).toHaveLength(0);
	fixture.state.readDenied = false;
	await press(setup, { name: "r" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Agent overlays: unsupported")
	);
	await press(setup, { name: "down" });
	await press(setup, { name: "down" });
	await press(setup, { name: "e" });
	expect(setup.captureCharFrame()).not.toContain("Enter review");
	expect(fixture.writes).toHaveLength(0);
}, 30_000);
test("Advanced Gateway custom evaluators save complete catalog and restart before confirming activation", async () => {
	const fixture = installFixture();
	useConsoleProfile();
	const setup = await renderApp();
	await openGateway(setup);
	await waitForFrame(setup, (frame) =>
		frame.includes("Custom evaluator catalog: served")
	);
	for (let index = 0; index < 3; index++) {
		await press(setup, { name: "down" });
	}
	const next = [{ ...CUSTOM_EVALUATOR, description: "Edited evaluator" }];
	await editJson(setup, next);
	await waitForFrame(setup, (frame) => frame.includes("also restarts"));
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Policy saved and confirmed")
	);
	expect(
		fixture.writes.map((call) => ({
			path: call.path,
			method: call.method,
			body: call.body,
		}))
	).toEqual([
		{
			path: "/api/gateway/config",
			method: "PUT",
			body: { custom_evaluators: next },
		},
		{ path: "/api/gateway/restart", method: "POST", body: {} },
	]);
}, 30_000);

test("Advanced Gateway managed owner/admin access is rechecked before writes and membership loss prevents mutation", async () => {
	const fixture = installFixture();
	useConsoleProfile();
	const setup = await renderApp({
		url: "https://managed.example.test",
		token: "fixture-node-token",
	});
	await openGateway(setup);
	await waitForFrame(setup, (frame) => frame.includes("Node firewall: served"));
	await editJson(setup, { ...FIREWALL, alert: "email" });
	fixture.state.role = "member";
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Owner or admin access is required")
	);
	expect(fixture.writes).toHaveLength(0);
	fixture.state.role = "admin";
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Policy saved and confirmed")
	);
	expect(fixture.writes).toHaveLength(1);
	expect(fixture.writes[0]?.authorization).toBe("Bearer fixture-node-token");
}, 30_000);
test("Advanced Gateway normalized agent overlays confirm authored fields, while retained removed IDs fail readback", async () => {
	const fixture = installFixture();
	useConsoleProfile();
	const setup = await renderApp();
	await openGateway(setup);
	await waitForFrame(setup, (frame) =>
		frame.includes("Agent overlays: served")
	);
	await press(setup, { name: "down" });
	await press(setup, { name: "down" });
	fixture.state.normalize = true;
	await editJson(setup, {
		"fixture-agent": { policy: "block", inspector: null },
	});
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Policy saved and confirmed")
	);
	expect(fixture.config.firewall_agent_overlays).toEqual({
		"fixture-agent": {
			policy: "block",
			inspector: null,
			log_detections: null,
			custom_patterns: [],
		},
	});
	await press(setup, { name: "up" });
	await editJson(setup, {});
	fixture.state.mismatch = true;
	await press(setup, { name: "y" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("did not match normalized") &&
			frame.includes("Reload to inspect")
	);
	expect(setup.captureCharFrame()).not.toContain("Policy saved and confirmed");
}, 30_000);
test("Advanced Gateway canonical egress preferences retry identical writes and preserve map IDs through node readback", async () => {
	const fixture = installFixture();
	useConsoleProfile();
	const setup = await renderApp();
	await openGateway(setup);
	await waitForFrame(setup, (frame) =>
		frame.includes("Claude egress preference: served")
	);
	for (let index = 0; index < 4; index++) {
		await press(setup, { name: "down" });
	}
	await editJson(setup, false);
	fixture.state.failOnce = true;
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) => frame.includes("Could not save:"));
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Policy saved and confirmed")
	);
	expect(
		fixture.writes.map((call) => ({ path: call.path, body: call.body }))
	).toEqual([
		{
			path: "/api/preferences/claude-gateway-routing",
			body: { value: "false" },
		},
		{
			path: "/api/preferences/claude-gateway-routing",
			body: { value: "false" },
		},
	]);
	await press(setup, { name: "down" });
	await editJson(setup, false);
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Policy saved and confirmed")
	);
	expect(fixture.preferences["codex-gateway-routing"]).toBe("false");
	await press(setup, { name: "down" });
	const map = { "keep-agent": true, "fixture-agent": false };
	await editJson(setup, map);
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Policy saved and confirmed")
	);
	expect(JSON.parse(fixture.preferences["agent-gateway-routing"]!)).toEqual(
		map
	);
	expect(fixture.writes.at(-1)?.body).toEqual({ value: JSON.stringify(map) });
}, 30_000);
test("Advanced Gateway custom evaluator failed restart cannot claim activated catalog and retry restarts the same saved definitions", async () => {
	const fixture = installFixture();
	useConsoleProfile();
	const setup = await renderApp();
	await openGateway(setup);
	await waitForFrame(setup, (frame) =>
		frame.includes("Custom evaluator catalog: served")
	);
	for (let index = 0; index < 3; index++) {
		await press(setup, { name: "down" });
	}
	const value = [CUSTOM_EVALUATOR];
	await editJson(setup, value);
	fixture.state.restartAllowed = false;
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) => frame.includes("restart not confirmed"));
	expect(setup.captureCharFrame()).not.toContain("Policy saved and confirmed");
	fixture.state.restartAllowed = true;
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Policy saved and confirmed")
	);
	expect(
		fixture.writes
			.filter((call) => call.method === "PUT")
			.map((call) => call.body)
	).toEqual([{ custom_evaluators: value }, { custom_evaluators: value }]);
}, 30_000);
