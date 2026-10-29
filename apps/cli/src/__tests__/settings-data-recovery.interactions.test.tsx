/* @jsxImportSource @opentui/react */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import type { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
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
import {
	credentialFreeCoreProbe,
	useFetchBackedLoopback,
} from "./core-identity-fixture.ts";

interface SettingsCatalogReadObservation {
	authorization: string | null;
	status: number;
}

const target = {
	url: "http://127.0.0.1:7980",
	token: "settings-data-synthetic-node",
};
const originalFetch = globalThis.fetch;
const originalEnvironment = {
	RYU_CLI_CONFIG_DIR: process.env.RYU_CLI_CONFIG_DIR,
	RYU_AUTH_URL: process.env.RYU_AUTH_URL,
};
type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | null = null;
let ownedHome: string | null = null;

// The node's loopback connections go to this file's fetch stub, not sockets.
let restoreLoopback: (() => void) | null = null;
beforeAll(() => {
	restoreLoopback = useFetchBackedLoopback();
});
afterAll(() => {
	restoreLoopback?.();
});

afterEach(async () => {
	await act(async () => setup?.renderer.destroy());
	setup = null;
	globalThis.fetch = originalFetch;
	for (const [name, value] of Object.entries(originalEnvironment)) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
	if (ownedHome) {
		rmSync(ownedHome, { recursive: true, force: true });
		ownedHome = null;
	}
});

async function press(
	rendered: Setup,
	name: string,
	ctrl = false
): Promise<void> {
	const input = rendered.renderer.keyInput;
	await act(async () => {
		input.emit(
			"keypress",
			new KeyEvent({
				name,
				sequence: name.length === 1 ? name : "",
				ctrl,
				shift: false,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: name.length === 1 ? name : "",
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await rendered.renderOnce();
	});
}

async function waitForFrame(
	rendered: Setup,
	predicate: (frame: string) => boolean
): Promise<string> {
	let frame = rendered.captureCharFrame();
	const deadline = performance.now() + 2000;
	await act(async () => {
		while (!predicate(frame) && performance.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await rendered.renderOnce();
			frame = rendered.captureCharFrame();
		}
	});
	if (!predicate(frame)) {
		throw new Error(
			`Settings data recovery did not reach expected frame:\n${frame}`
		);
	}
	return frame;
}

interface PanelCase {
	body: z.infer<typeof appResponseValueSchema>;
	detail: string;
	label: string;
	navSteps: number;
	path: string;
	visible: string;
}

// navSteps count General → panel in the CLI Settings nav (Island is not a CLI
// panel).
const panelCases: PanelCase[] = [
	{
		label: "Features",
		path: "/api/plugins",
		navSteps: 1,
		body: {
			apps: [
				{
					id: "com.ryu.current-proof",
					name: "Current node recovered app",
					version: "0.4.0",
					installed: true,
					installed_version: "0.4.0",
					enabled: true,
					permission_grants: [],
					runnables: [],
					built_in: false,
					local_only: false,
					sidecar_name: null,
					windows_first: false,
				},
			],
		},
		visible: "Current node recovered app",
		detail: "enabled",
	},
	{
		label: "Meetings",
		path: "/api/meetings",
		navSteps: 6,
		body: {
			meetings: [
				{
					id: "meeting-current",
					source: "manual",
					started_at: "2026-10-05T10:00:00Z",
					updated_at: "2026-10-05T10:00:00Z",
					title: "Current recovered meeting",
					created_at: "2026-10-05T10:00:00Z",
					participants: ["a", "b"],
					status: "done",
					app: "Zoom",
				},
			],
		},
		visible: "Current recovered meeting",
		detail: "2 participants",
	},
	{
		label: "Tasks",
		path: "/api/quests",
		navSteps: 7,
		body: {
			quests: [
				{
					id: "quest-current",
					title: "Current recovered task",
					completion_condition: "verified readback",
					status: "open",
					kind: "task",
					pinned: true,
					created_at: "2026-10-05T10:00:00Z",
					updated_at: "2026-10-05T10:00:00Z",
				},
			],
		},
		visible: "Current recovered task",
		detail: "open · pinned",
	},
	{
		label: "Storage",
		path: "/api/data-path",
		navSteps: 19,
		body: {
			current: "/synthetic/current-recovered-data",
			default: "/synthetic/default-data",
			is_custom: true,
			size_bytes: 2048,
			free_space_bytes: 1_073_741_824,
		},
		visible: "/synthetic/current-recovered-data",
		detail: "2.0 KB",
	},
	{
		label: "Danger Zone",
		path: "/api/data/counts",
		navSteps: 21,
		body: {
			chats: 3,
			spaces: 0,
			memory: 0,
			monitors: 0,
			meetings: 0,
			categories: [
				{
					id: "current-chats",
					title: "Current recovered chat records",
					detail: "Read-only deletion boundary",
					count: 3,
					noun: "chats",
					confirm_word: "Chats",
					plugin: null,
				},
			],
		},
		visible: "Current recovered chat records",
		detail: "3 chats",
	},
];

async function navigateFromGeneral(
	rendered: Setup,
	steps: number
): Promise<void> {
	const input = rendered.renderer.keyInput;
	// A real burst of navigation keys commits the chosen panel once. This avoids
	// booting unrelated editable/account panes whose contracts have separate suites.
	await act(async () => {
		for (let index = 0; index < steps; index += 1) {
			input.emit(
				"keypress",
				new KeyEvent({
					name: "j",
					sequence: "j",
					ctrl: false,
					shift: false,
					meta: false,
					option: false,
					eventType: "press",
					repeated: false,
					number: false,
					raw: "j",
					source: "raw",
				})
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
		await rendered.renderOnce();
	});
}

for (const panel of panelCases) {
	test(`actual Settings ${panel.label} retries a refused read while the overlay owns input without writes or duplicate reads`, async () => {
		ownedHome = mkdtempSync(join(tmpdir(), "ryu-cli-settings-data-"));
		process.env.RYU_CLI_CONFIG_DIR = join(ownedHome, ".ryu");
		process.env.RYU_AUTH_URL = "http://localhost:3000";
		mkdirSync(join(ownedHome, ".ryu"));
		writeProductModePreference(
			withProductMode(defaultProductModePreference(), "console", "/home"),
			productModePreferencePath(ownedHome)
		);
		const unknown: string[] = [];
		const catalogCalls: SettingsCatalogReadObservation[] = [];
		let catalogPhase: "startup" | "refused" | "retry" = "startup";
		const reads = new Map<string, z.infer<typeof appResponseValueSchema>>([
			[
				"/api/auth/status",
				{
					authenticated: false,
					pending: false,
					token: null,
					userCode: null,
					verificationUri: null,
				},
			],
			["/api/auth/accounts", { accounts: [], activeUserId: null }],
			["/api/health", { status: "ok" }],
			["/api/plugins/contributions", { views: [], slash_commands: [] }],
			["/api/agents", { agents: [] }],
			["/api/teams", { teams: [] }],
			["/api/spaces", { spaces: [] }],
			["/api/meetings", { meetings: [] }],
			["/api/conversations", { conversations: [] }],
			["/workflows", { workflows: [] }],
			[
				"/api/system/status",
				{
					engine: { active: null, running: false },
					gateway: { reachable: true },
					sidecars: [],
					mesh: null,
				},
			],
			["/api/preferences/terminal-theme", { value: JSON.stringify("dark") }],
			["/api/preferences/theme", { value: JSON.stringify("dark") }],
			[
				"/api/preferences/auto-updates",
				{ value: JSON.stringify({ enabled: false }) },
			],
			[
				"/api/update/check",
				{
					current: "0.4.0",
					latest: "0.4.0",
					update_available: false,
					html_url: null,
				},
			],
		]);
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const request = input instanceof Request ? input : null;
				const url = new URL(request?.url ?? String(input));
				const method = init?.method ?? request?.method ?? "GET";
				const headers = new Headers(init?.headers ?? request?.headers);
				// A loopback Core is probed with no credential and must answer the
				// identity challenge before it is sent the node token.
				const probe = credentialFreeCoreProbe(url, method, headers, target);
				if (probe) {
					return probe;
				}
				const valid =
					url.origin === target.url &&
					method === "GET" &&
					!url.search &&
					init?.body == null &&
					request?.body == null &&
					headers.get("authorization") === `Bearer ${target.token}` &&
					!headers.has("x-ryu-user-jwt");
				if (
					!valid ||
					(url.pathname !== panel.path &&
						url.pathname !== "/api/plugins" &&
						!reads.has(url.pathname))
				) {
					unknown.push(`${method} ${url.href}`);
					throw new Error(
						`Unexpected settings data transport: ${method} ${url.href}`
					);
				}
				if (url.pathname !== panel.path) {
					return Response.json(
						url.pathname === "/api/plugins"
							? { apps: [] }
							: reads.get(url.pathname)
					);
				}
				if (catalogPhase === "startup") {
					return Response.json(
						reads.get(panel.path) ??
							(panel.path === "/api/plugins" ? { apps: [] } : panel.body)
					);
				}
				const status = catalogPhase === "refused" ? 500 : 200;
				catalogCalls.push({
					authorization: headers.get("authorization"),
					status,
				});
				return status === 500
					? Response.json({ error: "settings panel refused" }, { status })
					: Response.json(panel.body);
			},
			{ preconnect: originalFetch.preconnect }
		);
		await act(async () => {
			setup = await testRender(<App target={target} />, {
				width: 140,
				height: 38,
			});
			await setup.renderOnce();
		});
		const rendered = setup;
		if (!rendered) {
			throw new Error("CLI App did not mount");
		}
		await waitForFrame(
			rendered,
			(frame) => frame.includes("Ryu") && frame.includes("Agent")
		);
		await press(rendered, "k", true);
		for (const character of "settings") {
			await press(rendered, character);
		}
		await press(rendered, "return");
		await waitForFrame(rendered, (frame) => frame.includes("Startup realm"));
		catalogPhase = "refused";
		await navigateFromGeneral(rendered, panel.navSteps);
		const refused = await waitForFrame(
			rendered,
			(frame) => frame.includes("500") && frame.includes(panel.label)
		);
		expect(refused).toContain("Esc close");
		expect(refused).toContain(panel.path);
		expect(catalogCalls).toEqual([
			{ authorization: `Bearer ${target.token}`, status: 500 },
		]);
		catalogPhase = "retry";
		await press(rendered, "r");
		const recovered = await waitForFrame(rendered, (frame) =>
			frame.includes(panel.visible)
		);
		expect(recovered).toContain(panel.detail);
		expect(recovered).not.toContain("500");
		expect(recovered).toContain(panel.label);
		expect(catalogCalls).toEqual([
			{ authorization: `Bearer ${target.token}`, status: 500 },
			{ authorization: `Bearer ${target.token}`, status: 200 },
		]);
		await press(rendered, "escape");
		await waitForFrame(rendered, (frame) => !frame.includes("Esc close"));
		expect(catalogCalls).toHaveLength(2);
		expect(unknown).toEqual([]);
	});
}
