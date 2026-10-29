/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
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

const firewallSchema = z
	.object({
		enabled: z.boolean(),
		scan_inbound: z.boolean(),
		scan_outbound: z.boolean(),
		log_detections: z.boolean(),
		redact_pii: z.boolean(),
		redact_secrets: z.boolean(),
		policy: z.string(),
		custom_patterns: z.array(
			z.object({ name: z.string(), regex: z.string(), kind: z.string() })
		),
	})
	.catchall(z.json());
const firewallWriteSchema = z
	.object({ firewall: firewallSchema })
	.catchall(z.json());
const FIREWALL = {
	enabled: false,
	scan_inbound: true,
	scan_outbound: false,
	log_detections: true,
	redact_pii: false,
	redact_secrets: true,
	policy: "block",
	custom_patterns: [{ name: "keep", regex: "fixture", kind: "pii" }],
};

test("Gateway node policy drives every scanning and redaction toggle and moves selection upward without a write", async () => {
	let firewall = { ...FIREWALL };
	const writes: { firewall: typeof FIREWALL }[] = [];
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const path = new URL(input instanceof Request ? input.url : String(input))
				.pathname;
			if (path === "/api/gateway/config") {
				if (init?.method === "PUT") {
					const body = fixtureRecordSchema.parse(
						parseFixtureJson(String(init.body))
					);
					writes.push(firewallWriteSchema.parse(body));
					firewall = firewallSchema.parse(body.firewall);
					return Response.json({ ok: true });
				}
				return Response.json({ firewall });
			}
			if (path === "/api/gateway/status") {
				return Response.json({ reachable: true });
			}
			if (path === "/api/preferences/exec-approval-mode") {
				return Response.json({ value: "enforce" });
			}
			if (path === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			return Response.json({});
		},
		realFetch
	);
	useConsoleProfile();
	const setup = await renderApp();
	await openGateway(setup);
	await waitForFrame(setup, (frame) => frame.includes("Firewall: Off"));
	for (const [label, expected] of [
		["Scan inbound", "Off"],
		["Scan outbound", "On"],
		["Log detections", "Off"],
		["Redact PII", "On"],
		["Redact secrets", "Off"],
	]) {
		await press(setup, { name: "down" });
		await press(setup, { name: "return" });
		await waitForFrame(
			setup,
			(frame) =>
				frame.includes(`${label}: ${expected}`) &&
				frame.includes("Saved and read back")
		);
	}
	expect(writes.map((entry) => entry.firewall)).toEqual([
		{ ...FIREWALL, scan_inbound: false },
		{ ...FIREWALL, scan_inbound: false, scan_outbound: true },
		{
			...FIREWALL,
			scan_inbound: false,
			scan_outbound: true,
			log_detections: false,
		},
		{
			...FIREWALL,
			scan_inbound: false,
			scan_outbound: true,
			log_detections: false,
			redact_pii: true,
		},
		{
			...FIREWALL,
			scan_inbound: false,
			scan_outbound: true,
			log_detections: false,
			redact_pii: true,
			redact_secrets: false,
		},
	]);
	await press(setup, { name: "up" });
	await waitForFrame(setup, (frame) => frame.includes("› Redact PII: On"));
	expect(writes).toHaveLength(5);
	await press(setup, { name: "escape" });
	await openGateway(setup);
	const reopened = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Scan inbound: Off") &&
			frame.includes("Redact secrets: Off")
	);
	expect(reopened).toContain("Redact PII: On");
	expect(reopened).toContain("Scan outbound: On");
	expect(reopened).toContain("Log detections: Off");
	expect(writes).toHaveLength(5);
}, 30_000);

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

interface RequestRecord {
	method: string;
	path: string;
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
		throw new Error(`Gateway Guardrails render did not match: ${frame}`);
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

async function renderApp(): Promise<Setup> {
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 180,
		height: 48,
	});
	testSetup = setup;
	await setup.renderOnce();
	return setup;
}

function installGatewayStatus(responses: readonly Response[]) {
	const requests: RequestRecord[] = [];
	let index = 0;
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const method = init?.method ?? "GET";
			requests.push({ method, path: url.pathname });
			if (url.pathname === "/api/gateway/status") {
				const response = responses[Math.min(index, responses.length - 1)];
				index += 1;
				return (
					response ??
					Response.json({ error: "missing fixture response" }, { status: 500 })
				);
			}
			if (url.pathname === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			if (url.pathname === "/api/gateway/config") {
				return Response.json({ firewall: FIREWALL });
			}
			if (url.pathname === "/api/preferences/exec-approval-mode") {
				return Response.json({ value: "enforce" });
			}
			return Response.json({});
		},
		realFetch
	);
	return requests;
}

test("Gateway Guardrails shows offline firewall and DLP configuration as read-only Core status", async () => {
	const requests = installGatewayStatus([
		Response.json({
			reachable: false,
			url: "http://127.0.0.1:7981",
			effective_config: {
				firewall: { enabled: true },
				dlp: { enabled: false },
			},
		}),
	]);
	useConsoleProfile();
	const setup = await renderApp();
	await openGateway(setup);
	const frame = await waitForFrame(
		setup,
		(value) =>
			value.includes("Firewall rules and PII/DLP redaction") &&
			value.includes("read-only — edit gateway policy in the desktop app")
	);
	expect(frame).toMatch(/firewall\s+● enabled/);
	expect(frame).toMatch(/dlp\s+○ disabled/);
	expect(
		requests.filter((request) => request.path === "/api/gateway/status")
	).toEqual([{ method: "GET", path: "/api/gateway/status" }]);
	expect(requests.some((request) => request.method === "PUT")).toBe(false);
}, 30_000);

test("Gateway Guardrails shows an error after denied status access and retries the read without a write", async () => {
	const requests = installGatewayStatus([
		Response.json(
			{ error: "gateway status is not authorized" },
			{ status: 403 }
		),
		Response.json({
			reachable: true,
			effective_config: {
				firewall: { enabled: false },
				pii: { enabled: true },
			},
		}),
	]);
	useConsoleProfile();
	const setup = await renderApp();
	await openGateway(setup);
	const denied = await waitForFrame(setup, (frame) =>
		frame.includes("gateway unreachable")
	);
	expect(denied).toContain("press r to retry");
	await press(setup, { name: "r" });
	const recovered = await waitForFrame(
		setup,
		(frame) => frame.includes("Node policy") && frame.includes("Firewall: Off")
	);
	expect(recovered).toContain("Redact secrets: On");
	expect(
		requests.filter((request) => request.path === "/api/gateway/status")
	).toEqual([
		{ method: "GET", path: "/api/gateway/status" },
		{ method: "GET", path: "/api/gateway/status" },
	]);
	expect(requests.some((request) => request.method === "PUT")).toBe(false);
}, 30_000);

test("Gateway policy retries the identical failed mutation, preserves sibling config, and reads persisted changes after reopen", async () => {
	let firewall = { ...FIREWALL };
	let approval = "enforce";
	const writes: { path: string; body: FixtureRecord }[] = [];
	let failFirst = true;
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const path = new URL(input instanceof Request ? input.url : String(input))
				.pathname;
			if (init?.method === "PUT") {
				const body = fixtureRecordSchema.parse(
					parseFixtureJson(String(init.body))
				);
				writes.push({ path, body });
				if (path === "/api/gateway/config") {
					if (failFirst) {
						failFirst = false;
						return Response.json({ error: "retry" }, { status: 503 });
					}
					firewall = firewallSchema.parse(body.firewall);
				} else if (path === "/api/preferences/exec-approval-mode") {
					approval = z.string().parse(body.value);
				} else {
					throw new Error(`Unexpected mutation ${path}`);
				}
				return Response.json({ ok: true });
			}
			if (path === "/api/gateway/status") {
				return Response.json({ reachable: true });
			}
			if (path === "/api/gateway/config") {
				return Response.json({ firewall });
			}
			if (path === "/api/preferences/exec-approval-mode") {
				return Response.json({ value: approval });
			}
			if (path === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			return Response.json({});
		},
		realFetch
	);
	useConsoleProfile();
	const setup = await renderApp();
	await openGateway(setup);
	await waitForFrame(setup, (frame) => frame.includes("Firewall: Off"));
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("Could not save policy"));
	expect(firewall.enabled).toBe(false);
	await press(setup, { name: "return" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Saved and read back") && frame.includes("Firewall: On")
	);
	expect(writes).toEqual([
		{
			path: "/api/gateway/config",
			body: { firewall: { ...FIREWALL, enabled: true } },
		},
		{
			path: "/api/gateway/config",
			body: { firewall: { ...FIREWALL, enabled: true } },
		},
	]);
	for (let index = 0; index < 7; index += 1) {
		await press(setup, { name: "down" });
	}
	await press(setup, { name: "return" });
	const frame = await waitForFrame(
		setup,
		(value) =>
			value.includes("Command approval: Off") &&
			value.includes("Saved and read back")
	);
	expect(writes.at(-1)).toEqual({
		path: "/api/preferences/exec-approval-mode",
		body: { value: "off" },
	});
	expect(firewall.custom_patterns).toEqual(FIREWALL.custom_patterns);
	const proof = process.env.RYU_CLI_POLICY_PROOF;
	if (proof) {
		writeFileSync(`${proof}.txt`, frame);
		writeFileSync(`${proof}.svg`, renderTerminalSvg(setup.captureSpans()));
		writeFileSync(`${proof}.requests.json`, JSON.stringify(writes, null, 2));
	}
	await press(setup, { name: "escape" });
	await openGateway(setup);
	await waitForFrame(
		setup,
		(value) =>
			value.includes("Firewall: On") && value.includes("Command approval: Off")
	);
	expect(writes).toHaveLength(3);
}, 30_000);

test("Gateway policy keeps denied reads disabled, retries them, and retains rejected writes until successful readback", async () => {
	let firewall = { ...FIREWALL };
	let readDenied = true;
	let writeDenied = true;
	const writes: FixtureJson[] = [];
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const path = new URL(input instanceof Request ? input.url : String(input))
				.pathname;
			if (path === "/api/gateway/config") {
				if (init?.method === "PUT") {
					const body = fixtureRecordSchema.parse(
						parseFixtureJson(String(init.body))
					);
					writes.push(body);
					if (writeDenied) {
						return Response.json({ error: "forbidden" }, { status: 403 });
					}
					firewall = firewallSchema.parse(body.firewall);
					return Response.json({ ok: true });
				}
				return readDenied
					? Response.json({ error: "forbidden" }, { status: 403 })
					: Response.json({ firewall });
			}
			if (path === "/api/gateway/status") {
				return Response.json({ reachable: true });
			}
			if (path === "/api/preferences/exec-approval-mode") {
				return Response.json({ value: "enforce" });
			}
			if (path === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			return Response.json({});
		},
		realFetch
	);
	useConsoleProfile();
	const setup = await renderApp();
	await openGateway(setup);
	await waitForFrame(setup, (frame) => frame.includes("Could not load policy"));
	await press(setup, { name: "return" });
	expect(writes).toEqual([]);
	readDenied = false;
	await press(setup, { name: "r" });
	await waitForFrame(setup, (frame) => frame.includes("Firewall: Off"));
	for (let index = 0; index < 6; index += 1) {
		await press(setup, { name: "down" });
	}
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("Could not save policy"));
	expect(firewall.policy).toBe("block");
	writeDenied = false;
	await press(setup, { name: "return" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Policy: warn_and_continue") &&
			frame.includes("Saved and read back")
	);
	expect(writes).toEqual([
		{ firewall: { ...FIREWALL, policy: "warn_and_continue" } },
		{ firewall: { ...FIREWALL, policy: "warn_and_continue" } },
	]);
}, 30_000);
