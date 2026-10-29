/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import {
	type appRequestValueSchema,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import { z } from "zod";
import { App } from "../App.tsx";
import {
	defaultProductModePreference,
	productModePreferencePath,
	readProductModePreference,
	withProductMode,
	withStartupRealm,
	writeProductModePreference,
} from "../core/productMode.ts";
import { renderTerminalSvg } from "../proof/render-terminal-svg.ts";
import { testRender } from "./cli-test-render.ts";

// Preference set requests are published as the complete {value:string} envelope.
const preferenceWriteFields = z.looseObject({ value: z.string() });
const preferenceWriteObservation = z.custom<
	z.infer<typeof preferenceWriteFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		preferenceWriteFields.safeParse(value).success
);
interface PreferenceWriteObservation {
	body: z.infer<typeof preferenceWriteObservation>;
	headers: Headers;
	host: string;
}
function installResponse(
	provide: (
		...args: Parameters<typeof realFetch>
	) => ReturnType<typeof realFetch>
): void {
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});
}

const TARGET = { url: "http://127.0.0.1:7980", token: null };
const EVIDENCE_DIRECTORY = join(
	import.meta.dir,
	"../../../../docs/proof/test-coverage-sweep-20260924/evidence"
);
const realFetch = globalThis.fetch;
const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;

const originalAuthUrl = process.env.RYU_AUTH_URL;
let testHome: string | null = null;
let temporaryProofDirectory: string | null = null;
type RenderedApp = Awaited<ReturnType<typeof testRender>>;
let setup: RenderedApp | null = null;

afterEach(async () => {
	if (temporaryProofDirectory) {
		rmSync(temporaryProofDirectory, { force: true, recursive: true });
		temporaryProofDirectory = null;
	}
	globalThis.fetch = realFetch;
	if (originalConfigDir === undefined) {
		delete process.env.RYU_CLI_CONFIG_DIR;
	} else {
		process.env.RYU_CLI_CONFIG_DIR = originalConfigDir;
	}
	if (originalAuthUrl === undefined) {
		delete process.env.RYU_AUTH_URL;
	} else {
		process.env.RYU_AUTH_URL = originalAuthUrl;
	}
	if (testHome) {
		rmSync(testHome, { force: true, recursive: true });
		testHome = null;
	}
	await act(async () => {
		setup?.renderer.destroy();
		await Promise.resolve();
	});
	setup = null;
});

function isolateHome(): string {
	testHome = mkdtempSync(join(tmpdir(), "ryu-cli-product-mode-ui-"));
	process.env.RYU_CLI_CONFIG_DIR = join(testHome, ".ryu");
	return testHome;
}

async function renderApp(width = 120, height = 36): Promise<RenderedApp> {
	let rendered: RenderedApp | null = null;
	await act(async () => {
		const next = await testRender(<App target={TARGET} />, { height, width });
		rendered = next;
		await next.renderOnce();
	});
	if (!rendered) {
		throw new Error("OpenTUI did not render the CLI app");
	}
	setup = rendered;
	return rendered;
}

interface KeyInput {
	ctrl?: boolean;
	name: string;
	shift?: boolean;
}

async function press(renderer: RenderedApp, key: KeyInput): Promise<void> {
	const keyInput = renderer.renderer.keyInput;
	await act(async () => {
		keyInput.emit(
			"keypress",
			new KeyEvent({
				name: key.name,
				sequence: key.name.length === 1 ? key.name : "",
				ctrl: key.ctrl ?? false,
				shift: key.shift ?? false,
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
		await renderer.renderOnce();
	});
}

async function waitForFrame(
	renderer: RenderedApp,
	predicate: (frame: string) => boolean
): Promise<string> {
	let frame = renderer.captureCharFrame();
	await act(async () => {
		for (let pass = 0; pass < 40 && !predicate(frame); pass += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await renderer.renderOnce();
			frame = renderer.captureCharFrame();
		}
	});
	if (!predicate(frame)) {
		throw new Error(`Product mode UI did not reach expected state:\n${frame}`);
	}
	return frame;
}

function hasMode(frame: string, mode: "Bot" | "Agent" | "OS"): boolean {
	return frame
		.split("\n")
		.some(
			(line) =>
				line.includes("Ryu") && line.includes(mode) && line.includes("⌄")
		);
}

function hasConsolePickerOption(frame: string): boolean {
	return frame.includes("Core overview and Gateway controls.");
}

async function openSettings(renderer: RenderedApp): Promise<string> {
	await press(renderer, { ctrl: true, name: "k" });
	for (const character of "settings") {
		await press(renderer, { name: character });
	}
	await press(renderer, { name: "return" });
	return waitForFrame(renderer, (frame) => frame.includes("Startup realm"));
}

test("General startup realm refuses an unwritable directory without changing selection and retries after recovery", async () => {
	const home = isolateHome();
	const directory = join(home, ".ryu");
	const savedDirectory = join(home, "saved-cli-state");
	const path = productModePreferencePath(home);
	const preference = withProductMode(
		defaultProductModePreference(),
		"console",
		"/home"
	);
	writeProductModePreference(preference, path);
	const unknown: string[] = [];
	const startupSurfaceReads: string[] = [];
	const reads = new Map<string, z.infer<typeof appRequestValueSchema>>([
		["/api/auth/status", { authenticated: false, token: null }],
		["/api/auth/accounts", { accounts: [], activeUserId: null }],
		["/api/health", { status: "ok" }],
		["/api/plugins", { apps: [] }],
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
			const headers = new Headers(init?.headers ?? request?.headers);
			const method = init?.method ?? request?.method ?? "GET";
			if (
				url.origin !== TARGET.url ||
				method !== "GET" ||
				url.search ||
				!reads.has(url.pathname) ||
				init?.body != null ||
				request?.body != null ||
				headers.has("authorization") ||
				headers.has("x-ryu-user-jwt")
			) {
				unknown.push(`${method} ${url.href}`);
				throw new Error(
					`Unexpected startup realm fixture request: ${method} ${url.href}`
				);
			}
			if (
				url.pathname === "/workflows" ||
				url.pathname === "/api/system/status"
			) {
				startupSurfaceReads.push(`${method} ${url.pathname}`);
			}
			return Response.json(reads.get(url.pathname));
		},
		{ preconnect: realFetch.preconnect }
	);
	let renderer = await renderApp(140, 40);
	await waitForFrame(renderer, (frame) => hasMode(frame, "Agent"));
	expect(await openSettings(renderer)).toContain("› Last used");
	const before = readProductModePreference(path);
	// Keep exact persisted data for readback. A regular-file parent produces a
	// deterministic IO refusal even when tests run with privileged permissions.
	renameSync(directory, savedDirectory);
	writeFileSync(directory, "owned test obstruction\n");
	await press(renderer, { name: "right" });
	const refused = await waitForFrame(renderer, (frame) =>
		frame.includes("Could not save startup realm")
	);
	expect(refused).toContain("› Last used");
	// OpenTUI inserts pane borders/sidebar text between wrapped visual lines.
	// Require the complete retry instruction, allowing that one terminal wrap.
	expect(refused).toMatch(/select the(?:\s+|[^\n]*\n[^\n]*)realm again\./);
	expect(refused).not.toContain("› Bot");
	expect(
		readProductModePreference(join(savedDirectory, "cli-product-mode.json"))
	).toEqual(before);
	// The settings overlay covers the mode picker. Close it to inspect the
	// actual shell mode, then reopen the same setting with its refusal retained.
	await press(renderer, { name: "escape" });
	await waitForFrame(
		renderer,
		(frame) => !frame.includes("Startup realm") && hasMode(frame, "Agent")
	);
	const reopened = await openSettings(renderer);
	expect(reopened).toContain("› Last used");
	expect(reopened).toContain("Could not save startup realm");
	rmSync(directory);
	renameSync(savedDirectory, directory);
	expect(readProductModePreference(path)).toEqual(before);
	await press(renderer, { name: "right" });
	const recovered = await waitForFrame(
		renderer,
		(frame) =>
			frame.includes("› Bot") && !frame.includes("Could not save startup realm")
	);
	expect(recovered).toContain("› Bot");
	expect(readProductModePreference(path)).toEqual({
		...before,
		startupRealm: "bot",
	});
	await press(renderer, { name: "escape" });
	await waitForFrame(
		renderer,
		(frame) => !frame.includes("Startup realm") && hasMode(frame, "Agent")
	);
	await act(async () => {
		renderer.renderer.destroy();
	});
	setup = null;
	renderer = await renderApp(140, 40);
	await waitForFrame(renderer, (frame) => hasMode(frame, "Bot"));
	expect(await openSettings(renderer)).toContain("› Bot");
	expect(readProductModePreference(path)).toMatchObject({
		startupRealm: "bot",
		mode: "console",
	});
	expect(unknown).toEqual([]);
	// Initial sidebar + Chat, Console Home status, then the remounted Bot Chat.
	expect(startupSurfaceReads).toEqual([
		"GET /workflows",
		"GET /workflows",
		"GET /api/system/status",
		"GET /workflows",
	]);
});

test("General settings persist an independent startup realm and launch it on the next run", async () => {
	const home = isolateHome();
	mkdirSync(join(home, ".ryu"), { recursive: true });
	writeProductModePreference(
		defaultProductModePreference(),
		productModePreferencePath(home)
	);
	const calls: string[] = [];
	installResponse(async (input) => {
		const url = new URL(String(input));
		calls.push(url.pathname);
		if (url.pathname === "/api/auth/status") {
			return Response.json({ authenticated: false, token: null });
		}
		return Response.json({ apps: [] });
	});

	const renderer = await renderApp();
	await waitForFrame(renderer, (frame) => hasMode(frame, "Bot"));
	const beforeSettings = calls.filter(
		(path) => path !== "/api/auth/accounts"
	).length;
	const settings = await openSettings(renderer);
	expect(settings).toContain("› Last used");
	const clickRealm = async (label: string) => {
		const frame = renderer.captureCharFrame();
		const rows = frame.split("\n");
		const rowIndex = rows.findIndex((row) =>
			["Last used", "Bot", "Agent", "OS"].every((value) => row.includes(value))
		);
		const columnIndex = rows[rowIndex]?.indexOf(label) ?? -1;
		expect(rowIndex).toBeGreaterThanOrEqual(0);
		expect(columnIndex).toBeGreaterThanOrEqual(0);
		await act(async () => {
			await renderer.mockMouse.click(columnIndex, rowIndex);
		});
	};
	await clickRealm("Bot");
	expect(await Bun.file(productModePreferencePath(home)).json()).toMatchObject({
		mode: "bot",
		startupRealm: "bot",
	});
	await clickRealm("Agent");
	expect(await Bun.file(productModePreferencePath(home)).json()).toMatchObject({
		mode: "bot",
		startupRealm: "console",
	});
	await clickRealm("OS");
	await waitForFrame(
		renderer,
		(frame) =>
			frame.includes("› OS") && frame.includes("applies on next launch")
	);
	await press(renderer, { name: "right" });
	await waitForFrame(renderer, (frame) => frame.includes("› Last used"));
	await press(renderer, { name: "left" });
	expect(calls.filter((path) => path !== "/api/auth/accounts")).toHaveLength(
		beforeSettings
	);
	expect(await Bun.file(productModePreferencePath(home)).json()).toMatchObject({
		mode: "bot",
		startupRealm: "os",
	});

	await press(renderer, { name: "escape" });
	await waitForFrame(renderer, (frame) => !frame.includes("Startup realm"));
	await act(async () => {
		renderer.renderer.destroy();
		await Promise.resolve();
	});
	calls.length = 0;
	const restarted = await renderApp();
	const osFrame = await waitForFrame(
		restarted,
		(frame) => hasMode(frame, "OS") && frame.includes("App Launcher")
	);
	expect(hasMode(osFrame, "OS")).toBe(true);
	expect(osFrame).toContain("http://127.0.0.1:7980");
});

test("an explicit Console startup realm overrides the saved mode and keeps Console's landing", async () => {
	const home = isolateHome();
	mkdirSync(join(home, ".ryu"), { recursive: true });
	const preference = withStartupRealm(
		defaultProductModePreference(),
		"console"
	);
	preference.surfaces.console = "/chat";
	writeProductModePreference(preference, productModePreferencePath(home));
	installResponse(async (input) => {
		if (new URL(String(input)).pathname === "/api/auth/status") {
			return Response.json({ authenticated: false, token: null });
		}
		return Response.json({});
	});

	const renderer = await renderApp();
	const consoleFrame = await waitForFrame(
		renderer,
		(frame) =>
			hasMode(frame, "Agent") &&
			frame.includes("http://127.0.0.1:7980") &&
			frame.includes("Ask anything")
	);
	expect(consoleFrame).toContain("Ask anything");
	expect(await Bun.file(productModePreferencePath(home)).json()).toMatchObject({
		mode: "bot",
		startupRealm: "console",
		surfaces: { console: "/chat" },
	});
});

test("mode picker switches to Bot while preserving local chat on a plan-limited account", async () => {
	const home = isolateHome();
	mkdirSync(join(home, ".ryu"), { recursive: true });
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console"),
		productModePreferencePath(home)
	);
	const calls: string[] = [];
	installResponse(async (input) => {
		const url = new URL(String(input));
		calls.push(url.pathname);
		if (url.pathname === "/api/auth/status") {
			return Response.json({ authenticated: false, token: null });
		}
		return Response.json({});
	});

	const renderer = await renderApp();
	await waitForFrame(renderer, (frame) => hasMode(frame, "Agent"));
	await press(renderer, { ctrl: true, name: "m", shift: true });
	await waitForFrame(renderer, (frame) =>
		frame.includes("Choose the terminal surface")
	);
	await press(renderer, { name: "up" });
	await press(renderer, { name: "return" });
	const botFrame = await waitForFrame(
		renderer,
		(frame) =>
			hasMode(frame, "Bot") &&
			frame.includes("Account &") &&
			frame.includes("Settings") &&
			frame.includes("Ryu")
	);
	expect(hasMode(botFrame, "Bot")).toBe(true);
	expect(botFrame).toContain("http://127.0.0.1:7980");
	expect(botFrame).toContain(
		"Managed Bot routing requires a signed-in account"
	);
	expect(botFrame).not.toContain("/model");
	expect(botFrame).not.toContain("Checking access and switching");
	expect(calls.filter((path) => path === "/api/auth/status")).toHaveLength(2);
	expect(calls).not.toContain("/api/billing/subscription-status");

	const stored = await Bun.file(productModePreferencePath(home)).json();
	expect(stored).toMatchObject({ mode: "bot", surfaces: { bot: "/chat" } });

	await act(async () => {
		renderer.renderer.destroy();
		await Promise.resolve();
	});
	const restarted = await renderApp();
	const restartedBot = await waitForFrame(
		restarted,
		(frame) => hasMode(frame, "Bot") && frame.includes("New chat")
	);
	expect(hasMode(restartedBot, "Bot")).toBe(true);
	expect(restartedBot).toContain("http://127.0.0.1:7980");
});

test("Console startup reuses the existing Chat landing tab", async () => {
	const home = isolateHome();
	mkdirSync(join(home, ".ryu"), { recursive: true });
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath(home)
	);
	installResponse(async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/auth/status") {
			return Response.json({ authenticated: false, token: null });
		}
		return Response.json({});
	});

	const renderer = await renderApp();
	const frame = await waitForFrame(
		renderer,
		(value) => hasMode(value, "Agent") && value.includes("Ask anything")
	);
	const tabRow = frame
		.split("\n")
		.find((line) => line.includes("Ryu") && line.includes("New chat"));
	expect(tabRow).toBeDefined();
	expect(tabRow?.match(/New chat/g)).toHaveLength(1);
});

test("mode picker mouse activation opens the selected terminal surface", async () => {
	const home = isolateHome();
	mkdirSync(join(home, ".ryu"), { recursive: true });
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath(home)
	);
	installResponse(async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/auth/status") {
			return Response.json({ authenticated: false, token: null });
		}
		return Response.json({ apps: [] });
	});

	const renderer = await renderApp();
	await waitForFrame(renderer, (frame) => hasMode(frame, "Agent"));
	await press(renderer, { ctrl: true, name: "m", shift: true });
	const picker = await waitForFrame(renderer, (frame) =>
		frame.includes("Choose the terminal surface")
	);
	const rows = picker.split("\n");
	const osRow = rows.findIndex(
		(line) =>
			line.includes("OS") && line.includes("Launch terminal-compatible Apps")
	);
	const osColumn = rows[osRow]?.indexOf("OS") ?? -1;
	expect(osRow).toBeGreaterThanOrEqual(0);
	expect(osColumn).toBeGreaterThanOrEqual(0);
	await act(async () => {
		await renderer.mockMouse.click(osColumn, osRow);
	});
	const osFrame = await waitForFrame(
		renderer,
		(frame) => hasMode(frame, "OS") && frame.includes("App Launcher")
	);
	expect(hasMode(osFrame, "OS")).toBe(true);
	expect(osFrame).toContain("http://127.0.0.1:7980");
	expect(await Bun.file(productModePreferencePath(home)).json()).toMatchObject({
		mode: "os",
		surfaces: { os: "/app-launcher" },
	});
});

test("mode picker Down and Enter select OS and open the App Launcher", async () => {
	const home = isolateHome();
	mkdirSync(join(home, ".ryu"), { recursive: true });
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath(home)
	);
	installResponse(async (input) => {
		if (new URL(String(input)).pathname === "/api/auth/status") {
			return Response.json({ authenticated: false, token: null });
		}
		return Response.json({});
	});

	const renderer = await renderApp();
	await waitForFrame(renderer, (frame) => hasMode(frame, "Agent"));
	await press(renderer, { ctrl: true, name: "m", shift: true });
	await waitForFrame(renderer, (frame) =>
		frame.includes("Choose the terminal surface")
	);
	await press(renderer, { name: "down" });
	await waitForFrame(renderer, (frame) => frame.includes("› OS"));
	await press(renderer, { name: "return" });
	const launcher = await waitForFrame(
		renderer,
		(frame) => hasMode(frame, "OS") && frame.includes("App Launcher")
	);
	expect(hasMode(launcher, "OS")).toBe(true);
	expect(await Bun.file(productModePreferencePath(home)).json()).toMatchObject({
		mode: "os",
		surfaces: { os: "/app-launcher" },
	});
});

test("Console palette arrows move the selected route and persist the landing", async () => {
	const home = isolateHome();
	mkdirSync(join(home, ".ryu"), { recursive: true });
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath(home)
	);
	installResponse(async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/auth/status") {
			return Response.json({ authenticated: false, token: null });
		}
		if (url.pathname === "/api/agents") {
			return Response.json({ agents: [] });
		}
		return Response.json({});
	});

	const renderer = await renderApp();
	await waitForFrame(renderer, (frame) => hasMode(frame, "Agent"));
	await press(renderer, { ctrl: true, name: "k" });
	for (const character of "go to") {
		await press(renderer, { name: character });
	}
	await waitForFrame(renderer, (frame) => frame.includes("› Go to Chat"));
	await press(renderer, { name: "down" });
	const selectedAgents = await waitForFrame(renderer, (frame) =>
		frame.includes("› Go to Agents")
	);
	expect(selectedAgents).toContain("Go to Chat");
	await press(renderer, { name: "return" });
	const agents = await waitForFrame(
		renderer,
		(frame) => frame.includes("Agents") && !frame.includes("Go to Agents")
	);
	expect(agents).toContain("Agents");
	expect(await Bun.file(productModePreferencePath(home)).json()).toMatchObject({
		mode: "console",
		surfaces: { console: "/agents" },
	});
});

test("unmount aborts a pending mode check before it can persist a stale selection", async () => {
	const home = isolateHome();
	process.env.RYU_AUTH_URL = "http://localhost:3000";
	mkdirSync(join(home, ".ryu"), { recursive: true });
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath(home)
	);
	let authReads = 0;
	let modeAuthStarted = false;
	let resolverInstalled = false;
	let resolveModeAuth: (response: Response) => void = (_response) => {
		throw new Error("Mode auth response resolver was not installed");
	};
	let sawAbortedBillingRequest = false;
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/auth/status") {
			authReads += 1;
			if (authReads === 1) {
				return Response.json({
					authenticated: true,
					token: "account-session",
				});
			}
			modeAuthStarted = true;
			return await new Promise<Response>((resolve) => {
				resolveModeAuth = resolve;
				resolverInstalled = true;
			});
		}
		if (url.pathname === "/api/waitlist/me") {
			return Response.json({ status: "approved" });
		}
		if (url.pathname === "/api/billing/subscription-status") {
			sawAbortedBillingRequest = init?.signal?.aborted === true;
			return Response.json({ entitlement: { managedInference: false } });
		}
		return Response.json({});
	});

	const renderer = await renderApp();
	await waitForFrame(renderer, (frame) => hasMode(frame, "Agent"));
	await press(renderer, { ctrl: true, name: "m", shift: true });
	await waitForFrame(renderer, (frame) =>
		frame.includes("Choose the terminal surface")
	);
	await press(renderer, { name: "up" });
	await press(renderer, { name: "return" });
	expect(modeAuthStarted).toBe(true);

	await act(async () => {
		renderer.renderer.destroy();
		setup = null;
		await Promise.resolve();
	});
	expect(resolverInstalled).toBe(true);
	resolveModeAuth(
		Response.json({ authenticated: true, token: "account-session" })
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(sawAbortedBillingRequest).toBe(true);
	expect(await Bun.file(productModePreferencePath(home)).json()).toMatchObject({
		mode: "console",
		surfaces: { console: "/chat" },
	});
});

test("Console revalidates a managed-node switch and hides its workspace from a member", async () => {
	const home = isolateHome();
	process.env.RYU_AUTH_URL = "http://localhost:3000";
	mkdirSync(join(home, ".ryu"), { recursive: true });
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console"),
		productModePreferencePath(home)
	);
	installResponse(async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/auth/status") {
			return Response.json({ authenticated: true, token: "account-session" });
		}
		if (url.pathname === "/api/control-plane/nodes") {
			return Response.json({
				nodes: [
					{
						name: "Primary",
						orgId: "org-1",
						url: "https://managed.example.test",
						userJwt: "scoped-managed-session",
					},
				],
			});
		}
		if (url.pathname === "/api/control-plane/me/permissions") {
			return Response.json({ permissions: ["gateway.view", "agent.run"] });
		}
		return Response.json({});
	});

	const renderer = await renderApp(130, 36);
	await waitForFrame(renderer, (frame) => hasMode(frame, "Agent"));
	await press(renderer, { ctrl: true, name: "n" });
	await waitForFrame(renderer, (frame) => frame.includes("cloud-Primary"));
	await press(renderer, { name: "down" });
	await press(renderer, { name: "return" });
	const denied = await waitForFrame(
		renderer,
		(frame) =>
			hasMode(frame, "Bot") &&
			frame.includes("https://managed.example.test") &&
			frame.includes("Agent is available on this managed node")
	);
	expect(hasMode(denied, "Bot")).toBe(true);
	expect(denied).toContain("https://managed.example.test");
	expect(denied).toContain("role grants Gateway configuration");
	expect(hasConsolePickerOption(denied)).toBe(false);
	expect(denied).not.toContain("Core unreachable");
	// The managed node answers /api/health, so the guided connection card for
	// an unreachable Core must not appear on the denied frame either.
	expect(denied).not.toContain("isn't reachable at");
	expect(denied).not.toContain("isn't running at");
	await press(renderer, { name: "escape" });
	const recoveredBot = await waitForFrame(
		renderer,
		(frame) =>
			hasMode(frame, "Bot") &&
			frame.includes("https://managed.example.test") &&
			frame.includes("pinned to Ryu")
	);
	expect(hasMode(recoveredBot, "Bot")).toBe(true);
	expect(recoveredBot).toContain("https://managed.example.test");
	expect(recoveredBot).toContain("pinned to Ryu");
	expect(await Bun.file(join(home, ".ryu", "nodes.json")).exists()).toBe(false);
});

test("Console appears in the mode picker only after owner access is verified without writing preferences", async () => {
	const home = isolateHome();
	process.env.RYU_AUTH_URL = "http://localhost:3000";
	const modePreferencePath = productModePreferencePath(home);
	mkdirSync(join(home, ".ryu"), { recursive: true });
	const initialPreference = withProductMode(
		defaultProductModePreference(),
		"console",
		"/home"
	);
	writeProductModePreference(initialPreference, modePreferencePath);
	let role: "member" | "owner" = "member";
	const requests: { method: string; path: string }[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		requests.push({
			method: init?.method ?? "GET",
			path: url.pathname,
		});
		if (url.pathname === "/api/auth/status") {
			return Response.json({ authenticated: true, token: "account-session" });
		}
		if (url.pathname === "/api/billing/subscription-status") {
			return Response.json({ entitlement: { managedInference: false } });
		}
		if (url.pathname === "/api/control-plane/nodes") {
			return Response.json({
				nodes: [
					{
						name: "Primary",
						orgId: "org-1",
						url: "https://managed.example.test",
						userJwt: "scoped-managed-session",
					},
				],
			});
		}
		if (url.pathname === "/api/control-plane/me/permissions") {
			return Response.json({
				permissions:
					role === "member"
						? ["gateway.view", "agent.run"]
						: ["gateway.view", "gateway.configure", "agent.run"],
			});
		}
		return Response.json({});
	});

	const renderer = await renderApp(130, 36);
	await waitForFrame(renderer, (frame) => hasMode(frame, "Agent"));
	await press(renderer, { ctrl: true, name: "n" });
	await waitForFrame(renderer, (frame) => frame.includes("cloud-Primary"));
	await press(renderer, { name: "down" });
	const deniedCheckStart = requests.length;
	await press(renderer, { name: "return" });
	const deniedPicker = await waitForFrame(
		renderer,
		(frame) =>
			hasMode(frame, "Bot") &&
			frame.includes("https://managed.example.test") &&
			frame.includes("Agent is available on this managed node") &&
			!frame.includes("Checking Agent access…")
	);
	expect(deniedPicker).toContain("Bot");
	expect(deniedPicker).toContain("OS");
	expect(hasConsolePickerOption(deniedPicker)).toBe(false);
	expect(hasMode(deniedPicker, "Bot")).toBe(true);
	expect(deniedPicker).toContain("https://managed.example.test");
	mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
	writeFileSync(
		join(EVIDENCE_DIRECTORY, "cli-console-mode-member-denied.frame.txt"),
		deniedPicker
	);
	writeFileSync(
		join(EVIDENCE_DIRECTORY, "cli-console-mode-member-denied.svg"),
		renderTerminalSvg(renderer.captureSpans())
	);
	const deniedRequests = requests.slice(deniedCheckStart);
	for (const path of [
		"/api/auth/status",
		"/api/control-plane/nodes",
		"/api/control-plane/me/permissions",
	]) {
		expect(deniedRequests.some((request) => request.path === path)).toBe(true);
	}
	expect(deniedRequests.every((request) => request.method === "GET")).toBe(
		true
	);
	expect(await Bun.file(modePreferencePath).json()).toMatchObject({
		mode: "console",
	});

	role = "owner";
	const ownerActivationStart = requests.length;
	await press(renderer, { name: "r" });
	const ownerConsole = await waitForFrame(
		renderer,
		(frame) => hasMode(frame, "Agent") && frame.includes("managed.example.test")
	);
	expect(ownerConsole).toContain("managed.example.test");
	expect(
		requests
			.slice(ownerActivationStart)
			.every((request) => request.method === "GET")
	).toBe(true);
	expect(await Bun.file(modePreferencePath).json()).toMatchObject({
		mode: "console",
	});

	const ownerPreferenceBeforePicker = await Bun.file(modePreferencePath).text();
	const ownerCheckStart = requests.length;
	await press(renderer, { ctrl: true, shift: true, name: "m" });
	const ownerPicker = await waitForFrame(
		renderer,
		(frame) =>
			frame.includes("Choose the terminal surface") &&
			hasConsolePickerOption(frame) &&
			hasMode(frame, "Agent")
	);
	expect(ownerPicker).toContain("OS");
	expect(ownerPicker).toContain("managed.example.test");
	writeFileSync(
		join(EVIDENCE_DIRECTORY, "cli-console-mode-owner-allowed.frame.txt"),
		ownerPicker
	);
	writeFileSync(
		join(EVIDENCE_DIRECTORY, "cli-console-mode-owner-allowed.svg"),
		renderTerminalSvg(renderer.captureSpans())
	);
	expect(
		requests.slice(ownerCheckStart).every((request) => request.method === "GET")
	).toBe(true);
	expect(await Bun.file(modePreferencePath).text()).toBe(
		ownerPreferenceBeforePicker
	);
});

test("Bot mode picker retries a failed managed cloud-lane write and reads back the saved selection", async () => {
	const home = isolateHome();
	process.env.RYU_AUTH_URL = "http://localhost:3000";
	mkdirSync(join(home, ".ryu"), { recursive: true });
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console"),
		productModePreferencePath(home)
	);
	const writes: PreferenceWriteObservation[] = [];
	const selectionReads: string[] = [];
	let putAttempts = 0;
	let persistedSelection = "";
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/auth/status") {
			return Response.json({ authenticated: true, token: "account-session" });
		}
		if (url.pathname === "/api/billing/subscription-status") {
			return Response.json({ entitlement: { managedInference: true } });
		}
		if (url.pathname === "/api/control-plane/nodes") {
			return Response.json({
				nodes: [
					{
						name: "Primary",
						orgId: "org-1",
						url: "https://managed.example.test",
						userJwt: "scoped-managed-session",
					},
				],
			});
		}
		if (
			url.pathname === "/api/preferences/default-cloud-agent-selection" &&
			url.hostname === "managed.example.test"
		) {
			if (init?.method === "PUT") {
				putAttempts += 1;
				writes.push({
					body: preferenceWriteObservation.parse(JSON.parse(String(init.body))),
					headers: new Headers(init.headers),
					host: url.host,
				});
				if (putAttempts === 1) {
					return Response.json(
						{ error: "temporary preference outage" },
						{ status: 503 }
					);
				}
				persistedSelection = String(writes.at(-1)?.body.value ?? "");
				return Response.json({ ok: true });
			}
			const value = persistedSelection ?? "";
			selectionReads.push(value);
			return Response.json({ value });
		}
		return Response.json({});
	});

	const renderer = await renderApp();
	await waitForFrame(renderer, (frame) => hasMode(frame, "Agent"));
	await press(renderer, { ctrl: true, shift: true, name: "m" });
	await waitForFrame(renderer, (frame) =>
		frame.includes("Choose the terminal surface")
	);
	await press(renderer, { name: "up" });
	await press(renderer, { name: "return" });
	const bot = await waitForFrame(
		renderer,
		(frame) => hasMode(frame, "Bot") && frame.includes("Chat with Ryu")
	);
	expect(bot).toContain("Chat with Ryu");
	expect(writes).toHaveLength(1);
	expect(writes[0]).toMatchObject({
		host: "managed.example.test",
		body: {
			value: JSON.stringify({
				access_mode: "",
				agent_id: "ryu",
				effort: "",
				model: "openrouter/auto",
				provider: "managed-openrouter",
				thinking_level: "",
			}),
		},
	});
	expect(writes[0]?.headers.get("x-ryu-user-jwt")).toBe(
		"scoped-managed-session"
	);
	expect(writes[0]?.headers.get("authorization")).toBe(
		"Bearer scoped-managed-session"
	);
	expect(await Bun.file(productModePreferencePath(home)).json()).toMatchObject({
		mode: "bot",
		surfaces: { bot: "/chat" },
	});

	await press(renderer, { ctrl: true, shift: true, name: "m" });
	const retryPicker = await waitForFrame(
		renderer,
		(frame) =>
			frame.includes("Managed chat is eligible") &&
			frame.includes("Press r to retry the managed chat setup.")
	);
	expect(retryPicker).toContain("Press r to retry the managed chat setup.");
	await press(renderer, { name: "r" });
	await waitForFrame(renderer, (frame) => hasMode(frame, "Bot"));
	expect(putAttempts).toBe(2);
	expect(writes[1]).toEqual(writes[0]);
	await press(renderer, { ctrl: true, shift: true, name: "m" });
	await waitForFrame(renderer, (frame) =>
		frame.includes("Choose the terminal surface")
	);
	await press(renderer, { name: "return" });
	await waitForFrame(renderer, (frame) => hasMode(frame, "Bot"));
	expect(selectionReads).toEqual([
		"",
		"",
		persistedSelection,
		JSON.stringify({
			access_mode: "",
			agent_id: "ryu",
			effort: "",
			model: "openrouter/auto",
			provider: "managed-openrouter",
			thinking_level: "",
		}),
	]);
	expect(putAttempts).toBe(2);
	expect(await Bun.file(productModePreferencePath(home)).json()).toMatchObject({
		mode: "bot",
		surfaces: { bot: "/chat" },
	});
});

test("Bot rejects an acknowledged but unpersisted cloud lane and retries the same selection before preserving it", async () => {
	const home = isolateHome();
	const proofRoot = process.env.RYU_CLI_TEST_PROOF_DIR ?? tmpdir();
	mkdirSync(proofRoot, { recursive: true });
	const proofDirectory = mkdtempSync(
		join(proofRoot, "cli-cloud-lane-readback-")
	);
	if (!process.env.RYU_CLI_TEST_PROOF_DIR) {
		temporaryProofDirectory = proofDirectory;
	}
	process.env.RYU_AUTH_URL = "http://localhost:3000";
	mkdirSync(join(home, ".ryu"), { recursive: true });
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console"),
		productModePreferencePath(home)
	);
	const value = JSON.stringify({
		access_mode: "",
		agent_id: "ryu",
		effort: "",
		model: "openrouter/auto",
		provider: "managed-openrouter",
		thinking_level: "",
	});
	const requests: { method: string; value: string }[] = [];
	const targets: {
		host: string;
		authorization: string | null;
		userJwt: string | null;
	}[] = [];
	let putAttempts = 0;
	let persistedSelection = "";
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/auth/status") {
			return Response.json({ authenticated: true, token: "account-session" });
		}
		if (url.pathname === "/api/billing/subscription-status") {
			return Response.json({ entitlement: { managedInference: true } });
		}
		if (url.pathname === "/api/control-plane/nodes") {
			return Response.json({
				nodes: [
					{
						name: "Primary",
						orgId: "org-1",
						url: "https://managed.example.test",
						userJwt: "scoped-managed-session",
					},
				],
			});
		}
		if (url.pathname === "/api/preferences/default-cloud-agent-selection") {
			const headers = new Headers(init?.headers);
			targets.push({
				host: url.host,
				authorization: headers.get("authorization"),
				userJwt: headers.get("x-ryu-user-jwt"),
			});
			if (init?.method === "PUT") {
				const body = preferenceWriteObservation.parse(
					JSON.parse(String(init.body))
				);
				requests.push({ method: "PUT", value: body.value });
				putAttempts += 1;
				if (putAttempts > 1) {
					persistedSelection = body.value;
				}
				return Response.json({ ok: true });
			}
			requests.push({ method: "GET", value: persistedSelection });
			return Response.json({ value: persistedSelection });
		}
		return Response.json({});
	});

	const renderer = await renderApp();
	await waitForFrame(renderer, (frame) => hasMode(frame, "Agent"));
	await press(renderer, { ctrl: true, shift: true, name: "m" });
	await waitForFrame(renderer, (frame) =>
		frame.includes("Choose the terminal surface")
	);
	await press(renderer, { name: "up" });
	await press(renderer, { name: "return" });
	await waitForFrame(
		renderer,
		(frame) => hasMode(frame, "Bot") && frame.includes("Chat with Ryu")
	);
	expect(requests).toEqual([
		{ method: "GET", value: "" },
		{ method: "PUT", value },
		{ method: "GET", value: "" },
	]);
	const preferenceAfterFailedSetup = await Bun.file(
		productModePreferencePath(home)
	).json();
	expect(preferenceAfterFailedSetup).toMatchObject({
		mode: "bot",
		surfaces: { bot: "/chat" },
	});
	expect(JSON.stringify(preferenceAfterFailedSetup)).not.toContain(
		"scoped-managed-session"
	);

	await press(renderer, { ctrl: true, shift: true, name: "m" });
	const failedSetup = await waitForFrame(renderer, (frame) =>
		frame.includes("Press r to retry the managed chat setup.")
	);
	expect(failedSetup).toContain("Managed chat is eligible");
	expect(failedSetup).toContain("could not be saved");
	writeFileSync(join(proofDirectory, "failed-setup.frame.txt"), failedSetup);
	writeFileSync(
		join(proofDirectory, "failed-setup.svg"),
		renderTerminalSvg(renderer.captureSpans())
	);
	expect(
		await Bun.file(join(proofDirectory, "failed-setup.frame.txt")).text()
	).toBe(failedSetup);
	await press(renderer, { name: "r" });
	await waitForFrame(
		renderer,
		(frame) => hasMode(frame, "Bot") && frame.includes("Chat with Ryu")
	);
	expect(requests).toEqual([
		{ method: "GET", value: "" },
		{ method: "PUT", value },
		{ method: "GET", value: "" },
		{ method: "GET", value: "" },
		{ method: "PUT", value },
		{ method: "GET", value },
	]);
	expect(persistedSelection).toBe(value);
	await press(renderer, { ctrl: true, shift: true, name: "m" });
	const readyPicker = await waitForFrame(renderer, (frame) =>
		frame.includes("Choose the terminal surface")
	);
	expect(readyPicker).not.toContain("Press r to retry the managed chat setup.");
	writeFileSync(join(proofDirectory, "retry-confirmed.frame.txt"), readyPicker);
	writeFileSync(
		join(proofDirectory, "retry-confirmed.svg"),
		renderTerminalSvg(renderer.captureSpans())
	);
	expect(
		await Bun.file(join(proofDirectory, "retry-confirmed.frame.txt")).text()
	).toBe(readyPicker);
	await press(renderer, { name: "return" });
	const preservedChat = await waitForFrame(
		renderer,
		(frame) => hasMode(frame, "Bot") && frame.includes("Chat with Ryu")
	);
	expect(requests).toEqual([
		{ method: "GET", value: "" },
		{ method: "PUT", value },
		{ method: "GET", value: "" },
		{ method: "GET", value: "" },
		{ method: "PUT", value },
		{ method: "GET", value },
		{ method: "GET", value },
	]);
	expect(putAttempts).toBe(2);
	writeFileSync(
		join(proofDirectory, "selection-preserved.frame.txt"),
		preservedChat
	);
	writeFileSync(
		join(proofDirectory, "selection-preserved.svg"),
		renderTerminalSvg(renderer.captureSpans())
	);
	expect(
		await Bun.file(join(proofDirectory, "selection-preserved.frame.txt")).text()
	).toBe(preservedChat);
	for (const target of targets) {
		expect(target).toEqual({
			host: "managed.example.test",
			authorization: "Bearer scoped-managed-session",
			userJwt: "scoped-managed-session",
		});
	}
	expect(await Bun.file(productModePreferencePath(home)).json()).toEqual(
		preferenceAfterFailedSetup
	);
});

for (const failure of [
	"503",
	"network",
	"missing-value",
	"non-string-value",
] as const) {
	test(`Bot preserves an unreadable existing cloud lane after ${failure} and retries its read without writing`, async () => {
		const home = isolateHome();
		process.env.RYU_AUTH_URL = "http://localhost:3000";
		mkdirSync(join(home, ".ryu"), { recursive: true });
		writeProductModePreference(
			withProductMode(defaultProductModePreference(), "console"),
			productModePreferencePath(home)
		);
		const selectedLane = JSON.stringify({
			agent_id: "custom-agent",
			provider: "anthropic",
			model: "claude-sonnet",
			effort: "high",
			thinking_level: "",
			access_mode: "",
		});
		const requests: string[] = [];
		let selectionReads = 0;
		let persistedSelection = selectedLane;
		installResponse(async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname === "/api/auth/status") {
				return Response.json({ authenticated: true, token: "account-session" });
			}
			if (url.pathname === "/api/billing/subscription-status") {
				return Response.json({ entitlement: { managedInference: true } });
			}
			if (url.pathname === "/api/control-plane/nodes") {
				return Response.json({
					nodes: [
						{
							name: "Primary",
							orgId: "org-1",
							url: "https://managed.example.test",
							userJwt: "scoped-managed-session",
						},
					],
				});
			}
			if (url.pathname === "/api/preferences/default-cloud-agent-selection") {
				requests.push(init?.method ?? "GET");
				if (init?.method === "PUT") {
					persistedSelection = preferenceWriteObservation.parse(
						JSON.parse(String(init.body))
					).value;
					return Response.json({ ok: true });
				}
				selectionReads += 1;
				if (selectionReads === 1) {
					if (failure === "missing-value") {
						return Response.json({});
					}
					if (failure === "non-string-value") {
						return Response.json({ value: null });
					}
					if (failure === "network") {
						throw new TypeError(
							"connection interrupted before selection could be read"
						);
					}
					return Response.json(
						{ error: "preference temporarily unreadable" },
						{ status: 503 }
					);
				}
				return Response.json({ value: persistedSelection });
			}
			return Response.json({});
		});
		const renderer = await renderApp();
		await waitForFrame(renderer, (frame) => hasMode(frame, "Agent"));
		await press(renderer, { ctrl: true, shift: true, name: "m" });
		await waitForFrame(renderer, (frame) =>
			frame.includes("Choose the terminal surface")
		);
		await press(renderer, { name: "up" });
		await press(renderer, { name: "return" });
		await waitForFrame(
			renderer,
			(frame) => hasMode(frame, "Bot") && frame.includes("Chat with Ryu")
		);
		expect(requests).toEqual(["GET"]);
		expect(persistedSelection).toBe(selectedLane);
		await press(renderer, { ctrl: true, shift: true, name: "m" });
		const failedSetup = await waitForFrame(renderer, (frame) =>
			frame.includes("Press r to retry the managed chat setup.")
		);
		expect(failedSetup).toContain("Managed chat is eligible");
		await press(renderer, { name: "r" });
		await waitForFrame(
			renderer,
			(frame) => hasMode(frame, "Bot") && frame.includes("Chat with Ryu")
		);
		expect(requests).toEqual(["GET", "GET"]);
		expect(persistedSelection).toBe(selectedLane);
		await press(renderer, { ctrl: true, shift: true, name: "m" });
		const readyPicker = await waitForFrame(renderer, (frame) =>
			frame.includes("Choose the terminal surface")
		);
		expect(readyPicker).not.toContain(
			"Press r to retry the managed chat setup."
		);
		expect(
			await Bun.file(productModePreferencePath(home)).json()
		).toMatchObject({ mode: "bot", surfaces: { bot: "/chat" } });
	});
}
