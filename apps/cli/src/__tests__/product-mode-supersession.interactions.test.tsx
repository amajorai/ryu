/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
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

interface DeferredBotAuthentication {
	settled: boolean;
	signal: AbortSignal | null;
}
interface ProductModeRequestObservation {
	aborted: boolean;
	method: string;
	path: string;
}

const TARGET = { url: "http://127.0.0.1:7980", token: null };
const originalFetch = globalThis.fetch;
const originalEnvironment = {
	RYU_CLI_CONFIG_DIR: process.env.RYU_CLI_CONFIG_DIR,
	RYU_AUTH_URL: process.env.RYU_AUTH_URL,
};
type RenderedApp = Awaited<ReturnType<typeof testRender>>;
let renderedApp: RenderedApp | null = null;
let testHome: string | null = null;

afterEach(async () => {
	await act(async () => renderedApp?.renderer.destroy());
	renderedApp = null;
	globalThis.fetch = originalFetch;
	for (const [key, value] of Object.entries(originalEnvironment)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	if (testHome) {
		rmSync(testHome, { recursive: true, force: true });
		testHome = null;
	}
});

async function mountApp(): Promise<RenderedApp> {
	let result: RenderedApp | null = null;
	await act(async () => {
		const renderer = await testRender(<App target={TARGET} />, {
			width: 140,
			height: 36,
		});
		result = renderer;
		await renderer.renderOnce();
	});
	if (!result) {
		throw new Error("OpenTUI did not render the CLI App");
	}
	renderedApp = result;
	return result;
}

async function press(
	renderer: RenderedApp,
	name: string,
	modifiers: { ctrl?: boolean; shift?: boolean } = {}
): Promise<void> {
	const input = renderer.renderer.keyInput;
	await act(async () => {
		input.emit(
			"keypress",
			new KeyEvent({
				name,
				sequence: name.length === 1 ? name : "",
				ctrl: modifiers.ctrl ?? false,
				shift: modifiers.shift ?? false,
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
		throw new Error(`CLI did not reach the expected state:\n${frame}`);
	}
	return frame;
}

function hasMode(frame: string, mode: "Agent" | "OS"): boolean {
	return frame
		.split("\n")
		.some(
			(line) =>
				line.includes("Ryu") && line.includes(mode) && line.includes("⌄")
		);
}

test("OS supersedes pending Bot authentication without a stale target, realm or cloud write", async () => {
	const home = mkdtempSync(join(tmpdir(), "ryu-cli-mode-supersession-"));
	testHome = home;
	process.env.RYU_CLI_CONFIG_DIR = join(home, ".ryu");
	process.env.RYU_AUTH_URL = "http://localhost:3000";
	mkdirSync(join(home, ".ryu"), { recursive: true });
	const preferencePath = productModePreferencePath(home);
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		preferencePath
	);

	let deferNextAuth = false;
	const deferred: DeferredBotAuthentication = {
		signal: null,
		settled: false,
	};
	let completeAuth = (_response: Response): void => {
		throw new Error("Bot authentication request was not started");
	};
	const requests: ProductModeRequestObservation[] = [];
	const unexpectedRequests: string[] = [];
	const startupResponses = new Map<
		string,
		z.infer<typeof appResponseValueSchema>
	>([
		["/api/auth/status", { authenticated: false, token: null }],
		["/api/auth/accounts", { activeUserId: null, accounts: [] }],
		["/api/plugins", { apps: [] }],
		["/api/plugins/contributions", { views: [], slash_commands: [] }],
		["/workflows", { workflows: [] }],
		["/api/agents", { agents: [] }],
		["/api/teams", { teams: [] }],
		["/api/spaces", { spaces: [] }],
		["/api/meetings", { meetings: [] }],
		["/api/conversations", { conversations: [] }],
		["/api/health", { status: "ok" }],
		[
			"/api/update/check",
			{
				current: "0.4.0",
				latest: "0.4.0",
				update_available: false,
				html_url: null,
			},
		],
		["/api/preferences/terminal-theme", { value: JSON.stringify("dark") }],
		["/api/preferences/theme", { value: JSON.stringify("dark") }],
		[
			"/api/preferences/auto-updates",
			{ value: JSON.stringify({ enabled: false }) },
		],
	]);
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const request = input instanceof Request ? input : null;
			const url = new URL(request?.url ?? String(input));
			const headers = new Headers(init?.headers ?? request?.headers);
			requests.push({
				path: url.pathname,
				method: init?.method ?? "GET",
				aborted: init?.signal?.aborted === true,
			});
			const method =
				init?.method ?? (input instanceof Request ? input.method : "GET");
			const startupRead =
				url.origin === TARGET.url &&
				method === "GET" &&
				!url.search &&
				startupResponses.has(url.pathname) &&
				init?.body == null &&
				request?.body == null &&
				headers.get("authorization") === null &&
				headers.get("x-ryu-user-jwt") === null;
			const cancelledBillingRead =
				url.origin === "http://localhost:3000" &&
				method === "GET" &&
				url.pathname === "/api/billing/subscription-status" &&
				!url.search &&
				init?.signal?.aborted === true;
			if (!(startupRead || cancelledBillingRead)) {
				const reasons = [
					url.origin === TARGET.url
						? null
						: "unexpected origin (unless explicitly cancelled billing)",
					method === "GET" ? null : "expected GET",
					url.search ? "unexpected query" : null,
					startupResponses.has(url.pathname) ? null : "unknown route",
					init?.body != null || request?.body != null
						? "unexpected body"
						: null,
					headers.get("authorization") === null
						? null
						: "unexpected node authorization",
					headers.get("x-ryu-user-jwt") === null
						? null
						: "unexpected delegated identity",
				].filter(Boolean);
				const description = `${method} ${url.href}: ${reasons.join(", ")}`;
				unexpectedRequests.push(description);
				throw new Error(`Unexpected CLI fixture request: ${description}`);
			}
			if (url.pathname === "/api/auth/status" && deferNextAuth) {
				deferNextAuth = false;
				deferred.signal = init?.signal ?? null;
				// Deliberately deliver this response even after cancellation: the
				// production caller must reject a completion from the old selection.
				return await new Promise<Response>((resolve) => {
					completeAuth = (response) => {
						deferred.settled = true;
						resolve(response);
					};
				});
			}
			if (init?.signal?.aborted) {
				throw new DOMException("The operation was aborted", "AbortError");
			}
			return Response.json(startupResponses.get(url.pathname));
		},
		{ preconnect: originalFetch.preconnect }
	);

	let renderer = await mountApp();
	await waitForFrame(renderer, (frame) => hasMode(frame, "Agent"));
	await press(renderer, "m", { ctrl: true, shift: true });
	await waitForFrame(renderer, (frame) =>
		frame.includes("Choose the terminal surface")
	);
	await press(renderer, "up");
	deferNextAuth = true;
	await press(renderer, "return");
	await waitForFrame(renderer, (frame) =>
		frame.includes("Checking access and switching")
	);
	expect(deferred.signal).not.toBeNull();
	expect(deferred.signal?.aborted).toBe(false);
	expect(deferred.settled).toBe(false);

	// The actual picker permits a new choice while its prior check is pending.
	await press(renderer, "down");
	await press(renderer, "down");
	await press(renderer, "return");
	const selectedOs = await waitForFrame(
		renderer,
		(frame) => hasMode(frame, "OS") && frame.includes("App Launcher")
	);
	expect(selectedOs).toContain(TARGET.url);
	expect(deferred.signal?.aborted).toBe(true);
	const osPreference = await Bun.file(preferencePath).json();
	expect(osPreference).toMatchObject({
		mode: "os",
		surfaces: { os: "/app-launcher", console: "/chat" },
	});

	await act(async () => {
		completeAuth(
			Response.json({ authenticated: true, token: "obsolete-account" })
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await renderer.flush({ maxPasses: 12 });
	});
	expect(deferred.settled).toBe(true);
	expect(unexpectedRequests).toEqual([]);
	expect(
		requests.filter(
			(request) => request.path === "/api/billing/subscription-status"
		)
	).toEqual([
		{ path: "/api/billing/subscription-status", method: "GET", aborted: true },
	]);
	const afterOldResponse = renderer.captureCharFrame();
	expect(hasMode(afterOldResponse, "OS")).toBe(true);
	expect(afterOldResponse).toContain("App Launcher");
	expect(afterOldResponse).toContain(TARGET.url);
	expect(afterOldResponse).not.toContain("Chat with Ryu");
	expect(await Bun.file(preferencePath).json()).toEqual(osPreference);
	expect(requests.filter((request) => request.method === "PUT")).toEqual([]);
	expect(requests.some((request) => request.path.includes("cloud_chat"))).toBe(
		false
	);

	await press(renderer, "m", { ctrl: true, shift: true });
	const reopened = await waitForFrame(
		renderer,
		(frame) =>
			frame.includes("Choose the terminal surface") && hasMode(frame, "OS")
	);
	expect(reopened).not.toContain("Checking access and switching");
	await press(renderer, "escape");
	await act(async () => renderer.renderer.destroy());
	renderedApp = null;
	renderer = await mountApp();
	const restarted = await waitForFrame(
		renderer,
		(frame) => hasMode(frame, "OS") && frame.includes("App Launcher")
	);
	expect(restarted).toContain(TARGET.url);
	expect(await Bun.file(preferencePath).json()).toEqual(osPreference);
	expect(unexpectedRequests).toEqual([]);
});
