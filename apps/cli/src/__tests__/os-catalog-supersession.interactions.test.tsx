/* @jsxImportSource @opentui/react */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const ALPHA = { url: "http://127.0.0.1:7980", token: "alpha-node-token" };
const BETA = { url: "http://127.0.0.1:7981", token: "beta-node-token" };
const originalFetch = globalThis.fetch;
const originalEnvironment = {
	RYU_CLI_CONFIG_DIR: process.env.RYU_CLI_CONFIG_DIR,
};
type RenderedApp = Awaited<ReturnType<typeof testRender>>;
let setup: RenderedApp | null = null;
let testHome: string | null = null;

// The nodes' loopback connections go to this file's fetch stub, not sockets.
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
	for (const [key, value] of Object.entries(originalEnvironment)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	if (testHome) {
		rmSync(testHome, { recursive: true, force: true });
	}
	testHome = null;
});

function isolateOsProfile(): string {
	const home = mkdtempSync(join(tmpdir(), "ryu-cli-os-catalog-"));
	testHome = home;
	process.env.RYU_CLI_CONFIG_DIR = join(home, ".ryu");
	mkdirSync(join(home, ".ryu"), { recursive: true });
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "os", "/app-launcher"),
		productModePreferencePath(home)
	);
	writeFileSync(
		join(home, ".ryu", "nodes.json"),
		JSON.stringify({
			default: "Alpha node",
			nodes: [
				{ name: "Alpha node", ...ALPHA },
				{ name: "Beta node", ...BETA },
			],
		})
	);
	return home;
}

async function renderApp(): Promise<RenderedApp> {
	let result: RenderedApp | null = null;
	await act(async () => {
		const renderer = await testRender(<App target={ALPHA} />, {
			width: 140,
			height: 42,
		});
		result = renderer;
		await renderer.renderOnce();
	});
	if (!result) {
		throw new Error("OpenTUI did not render the CLI App");
	}
	setup = result;
	return result;
}

async function press(
	renderer: RenderedApp,
	name: string,
	ctrl = false
): Promise<void> {
	const input = renderer.renderer.keyInput;
	await act(async () => {
		input.emit(
			"keypress",
			new KeyEvent({
				name,
				ctrl,
				sequence: name.length === 1 ? name : "",
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
		throw new Error(`OS catalog did not reach expected state:\n${frame}`);
	}
	return frame;
}

function manifest(node: "alpha" | "beta", enabled = true, installed = true) {
	return {
		built_in: false,
		companion: { label: `${node} app` },
		enabled,
		id: `com.example.${node}`,
		installed,
		installed_version: "1.0.0",
		local_only: false,
		name: `${node} app`,
		permission_grants: [],
		runnables: [],
		sidecar_name: null,
		version: "1.0.0",
		windows_first: false,
	};
}

function contributions(node: "alpha" | "beta") {
	return {
		slash_commands: [],
		views: [
			{
				id: "catalog",
				plugin: `com.example.${node}`,
				title: node === "alpha" ? "Alpha catalog" : "Beta catalog",
				view: "list-detail",
				spec: {
					view: "list-detail",
					items: [
						{ id: `${node}-entry`, title: `${node} persisted catalog entry` },
					],
				},
			},
		],
	};
}

function installFixture(
	catalog: (node: "alpha" | "beta") => Response | Promise<Response>,
	contributionFeed = contributions
) {
	const unexpected: string[] = [];
	const catalogRequests: { node: string; authorization: string | null }[] = [];
	const contributionRequests: { node: string; authorization: string | null }[] =
		[];
	const reads = new Map<string, z.infer<typeof appResponseValueSchema>>([
		["/api/auth/status", { authenticated: false, token: null }],
		["/api/auth/accounts", { activeUserId: null, accounts: [] }],
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
		["/workflows", { workflows: [] }],
		["/api/agents", { agents: [] }],
		["/api/teams", { teams: [] }],
		["/api/spaces", { spaces: [] }],
		["/api/meetings", { meetings: [] }],
		["/api/conversations", { conversations: [] }],
	]);
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const request = input instanceof Request ? input : null;
			const url = new URL(request?.url ?? String(input));
			const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
			const headers = new Headers(init?.headers ?? request?.headers);
			const node =
				url.origin === ALPHA.url
					? "alpha"
					: url.origin === BETA.url
						? "beta"
						: null;
			const knownPath =
				reads.has(url.pathname) ||
				url.pathname === "/api/plugins" ||
				url.pathname === "/api/plugins/contributions";
			const expectedToken = node === "alpha" ? ALPHA.token : BETA.token;
			// A loopback Core is probed with no credential and must answer the
			// identity challenge before it is sent the node token.
			const probe = node
				? credentialFreeCoreProbe(
						url,
						method,
						headers,
						node === "alpha" ? ALPHA : BETA
					)
				: null;
			if (probe) {
				return probe;
			}
			const hasBody = init?.body != null || request?.body != null;
			if (
				!node ||
				method !== "GET" ||
				url.search ||
				!knownPath ||
				hasBody ||
				headers.get("authorization") !== `Bearer ${expectedToken}` ||
				headers.get("x-ryu-user-jwt") !== null
			) {
				const reasons = [
					node ? null : "unknown origin",
					method === "GET" ? null : "expected GET",
					url.search ? "unexpected query" : null,
					knownPath ? null : "unknown route",
					hasBody ? "unexpected body" : null,
					headers.get("authorization") === `Bearer ${expectedToken}`
						? null
						: "node authorization mismatch",
					headers.get("x-ryu-user-jwt") === null
						? null
						: "unexpected delegated identity",
				].filter(Boolean);
				const description = `${method} ${url.href}: ${reasons.join(", ")}`;
				unexpected.push(description);
				throw new Error(`Unexpected OS fixture request: ${description}`);
			}
			if (url.pathname === "/api/plugins") {
				catalogRequests.push({
					node,
					authorization: headers.get("authorization"),
				});
				return await catalog(node);
			}
			if ((init?.signal ?? request?.signal)?.aborted) {
				throw new DOMException("Cancelled", "AbortError");
			}
			if (url.pathname === "/api/plugins/contributions") {
				contributionRequests.push({
					node,
					authorization: headers.get("authorization"),
				});
				return Response.json(contributionFeed(node));
			}
			return Response.json(reads.get(url.pathname));
		},
		{ preconnect: originalFetch.preconnect }
	);
	return { unexpected, catalogRequests, contributionRequests };
}

for (const revocation of ["disabled", "uninstalled"] as const) {
	test(`OS refresh removes a ${revocation} app and Enter cannot reopen its previously selected view`, async () => {
		const home = isolateOsProfile();
		let enabled = true;
		const fixture = installFixture((node) =>
			Response.json({
				apps: [
					manifest(
						node,
						revocation === "disabled" ? enabled : true,
						revocation === "uninstalled" ? enabled : true
					),
				],
			})
		);
		const renderer = await renderApp();
		await waitForFrame(renderer, (frame) => frame.includes("Alpha catalog"));
		for (const character of "alpha") {
			await press(renderer, character);
		}
		await waitForFrame(renderer, (frame) =>
			frame
				.split("\n")
				.some((line) => line.includes("›") && line.includes("Alpha catalog"))
		);
		const before = await Bun.file(productModePreferencePath(home)).json();
		enabled = false;
		await press(renderer, "r");
		const revoked = await waitForFrame(renderer, (frame) =>
			frame.includes("No launchable views match.")
		);
		expect(revoked).not.toContain("Alpha catalog");
		expect(fixture.catalogRequests).toHaveLength(2);
		await press(renderer, "return");
		expect(renderer.captureCharFrame()).toContain("No launchable views match.");
		expect(await Bun.file(productModePreferencePath(home)).json()).toEqual(
			before
		);
		for (let index = 0; index < 5; index += 1) {
			await press(renderer, "backspace");
		}
		for (const character of "chat") {
			await press(renderer, character);
		}
		await waitForFrame(renderer, (frame) =>
			frame
				.split("\n")
				.some((line) => line.includes("›") && line.includes("Chat"))
		);
		await press(renderer, "return");
		await waitForFrame(renderer, (frame) => frame.includes("Ask anything"));
		expect(
			await Bun.file(productModePreferencePath(home)).json()
		).toMatchObject({ mode: "os", surfaces: { os: "/chat" } });
		expect(fixture.unexpected).toEqual([]);
	});
}

test("OS node switch rejects a late previous-node catalog and opens only the new node's real view", async () => {
	const home = isolateOsProfile();
	let deferAlpha = false;
	let releaseAlpha = (_response: Response): void => {
		throw new Error("Alpha catalog request was not deferred");
	};
	let pending = false;
	const fixture = installFixture((node) => {
		if (node === "alpha" && deferAlpha) {
			deferAlpha = false;
			pending = true;
			return new Promise<Response>((resolve) => {
				releaseAlpha = resolve;
			});
		}
		return Response.json({ apps: [manifest(node)] });
	});
	const renderer = await renderApp();
	await waitForFrame(renderer, (frame) => frame.includes("Alpha catalog"));
	deferAlpha = true;
	await press(renderer, "r");
	expect(pending).toBe(true);
	await press(renderer, "n", true);
	await waitForFrame(
		renderer,
		(frame) =>
			frame.includes("Beta node") && !frame.includes("Loading managed nodes")
	);
	await press(renderer, "down");
	await press(renderer, "return");
	await waitForFrame(
		renderer,
		(frame) =>
			frame.includes(new URL(BETA.url).host) &&
			frame.includes("Beta catalog") &&
			!frame.includes("Alpha catalog")
	);
	await act(async () => {
		releaseAlpha(Response.json({ apps: [manifest("alpha")] }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await renderer.flush({ maxPasses: 12 });
	});
	const afterLateResponse = renderer.captureCharFrame();
	expect(afterLateResponse).toContain("Beta catalog");
	expect(afterLateResponse).not.toContain("Alpha catalog");
	expect(afterLateResponse).toContain(new URL(BETA.url).host);
	expect(fixture.catalogRequests).toEqual([
		{ node: "alpha", authorization: "Bearer alpha-node-token" },
		{ node: "alpha", authorization: "Bearer alpha-node-token" },
		{ node: "beta", authorization: "Bearer beta-node-token" },
	]);
	for (const character of "beta") {
		await press(renderer, character);
	}
	await waitForFrame(renderer, (frame) =>
		frame
			.split("\n")
			.some((line) => line.includes("›") && line.includes("Beta catalog"))
	);
	await press(renderer, "return");
	const opened = await waitForFrame(renderer, (frame) =>
		frame.includes("beta persisted catalog entry")
	);
	expect(opened).toContain("com.example.beta");
	expect(opened).not.toContain("alpha persisted catalog entry");
	expect(await Bun.file(productModePreferencePath(home)).json()).toMatchObject({
		mode: "os",
		surfaces: { os: "/plugin-view/com.example.beta/catalog" },
	});
	expect(await Bun.file(join(home, ".ryu", "nodes.json")).json()).toMatchObject(
		{ default: "Beta node" }
	);
	expect(fixture.unexpected).toEqual([]);
});

test("OS node switch fences old app actions while the new catalog is pending or denied, then retries only its admitted app", async () => {
	const home = isolateOsProfile();
	let betaReads = 0;
	let allowBeta = false;
	let releaseBeta = (_response: Response): void => {
		throw new Error("Beta catalog was not held");
	};
	const fixture = installFixture(
		(node) => {
			if (node === "beta" && ++betaReads === 1) {
				return new Promise<Response>((resolve) => {
					releaseBeta = resolve;
				});
			}
			if (node === "beta" && !allowBeta) {
				return Response.json(
					{ error: "Beta catalog permission denied" },
					{ status: 403 }
				);
			}
			return Response.json({ apps: [manifest(node)] });
		},
		(node) =>
			node === "alpha"
				? contributions(node)
				: {
						...contributions(node),
						// A contribution is a view declaration, not installed/enabled catalog
						// authority. B declares both views; its admitted catalog permits Beta.
						views: [
							...contributions("alpha").views,
							...contributions("beta").views,
						],
					}
	);
	const renderer = await renderApp();
	await waitForFrame(renderer, (frame) => frame.includes("Alpha catalog"));
	for (const character of "alpha") {
		await press(renderer, character);
	}
	await waitForFrame(renderer, (frame) =>
		frame
			.split("\n")
			.some((line) => line.includes("›") && line.includes("Alpha catalog"))
	);
	await press(renderer, "n", true);
	await waitForFrame(
		renderer,
		(frame) =>
			frame.includes("Beta node") && !frame.includes("Loading managed nodes")
	);
	await press(renderer, "down");
	await press(renderer, "return");
	await waitForFrame(
		renderer,
		(frame) =>
			frame.includes(new URL(BETA.url).host) && frame.includes("Loading Apps")
	);
	await act(async () => {
		await renderer.flush({ maxPasses: 12 });
	});
	expect(betaReads).toBe(1);
	expect(fixture.contributionRequests).toEqual([
		{ node: "alpha", authorization: "Bearer alpha-node-token" },
		{ node: "beta", authorization: "Bearer beta-node-token" },
	]);
	const beforeEnter = await Bun.file(productModePreferencePath(home)).json();
	await press(renderer, "return");
	const pending = renderer.captureCharFrame();
	expect(pending).toContain("App Launcher");
	expect(pending).not.toContain("Alpha catalog");
	expect(pending).not.toContain("alpha persisted catalog entry");
	expect(await Bun.file(productModePreferencePath(home)).json()).toEqual(
		beforeEnter
	);
	await act(async () => {
		releaseBeta(
			Response.json(
				{ error: "Beta catalog permission denied" },
				{ status: 403 }
			)
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await renderer.flush({ maxPasses: 12 });
	});
	await waitForFrame(renderer, (frame) =>
		frame.includes("Core Apps unavailable")
	);
	await press(renderer, "return");
	const denied = renderer.captureCharFrame();
	expect(denied).toContain("Core Apps unavailable");
	expect(denied).not.toContain("Alpha catalog");
	expect(denied).not.toContain("alpha persisted catalog entry");
	expect(await Bun.file(productModePreferencePath(home)).json()).toEqual(
		beforeEnter
	);
	// Built-in terminal routes remain usable even when app admission fails.
	for (let index = 0; index < 5; index += 1) {
		await press(renderer, "backspace");
	}
	for (const character of "chat") {
		await press(renderer, character);
	}
	await press(renderer, "return");
	await waitForFrame(renderer, (frame) => frame.includes("Ask anything"));
	expect(await Bun.file(productModePreferencePath(home)).json()).toMatchObject({
		mode: "os",
		surfaces: { os: "/chat" },
	});
	// Return to the actual launcher through the shell palette, retry admission,
	// and open the new node's enabled view with persisted route readback.
	await press(renderer, "k", true);
	for (const character of "app launcher") {
		await press(renderer, character);
	}
	await waitForFrame(renderer, (frame) => frame.includes("Go to App Launcher"));
	await press(renderer, "return");
	await waitForFrame(
		renderer,
		(frame) =>
			frame.includes("App Launcher") && frame.includes("Core Apps unavailable")
	);
	for (let index = 0; index < 4; index += 1) {
		await press(renderer, "backspace");
	}
	allowBeta = true;
	await press(renderer, "r");
	await waitForFrame(
		renderer,
		(frame) => frame.includes("Beta catalog") && !frame.includes("Loading Apps")
	);
	for (const character of "beta") {
		await press(renderer, character);
	}
	await press(renderer, "return");
	const opened = await waitForFrame(renderer, (frame) =>
		frame.includes("beta persisted catalog entry")
	);
	expect(opened).toContain("com.example.beta");
	expect(opened).not.toContain("alpha persisted catalog entry");
	expect(await Bun.file(productModePreferencePath(home)).json()).toMatchObject({
		mode: "os",
		surfaces: { os: "/plugin-view/com.example.beta/catalog" },
	});
	expect(fixture.catalogRequests[0]).toEqual({
		node: "alpha",
		authorization: "Bearer alpha-node-token",
	});
	expect(fixture.catalogRequests.slice(1)).not.toHaveLength(0);
	expect(
		fixture.catalogRequests
			.slice(1)
			.every(
				(request) =>
					request.node === "beta" &&
					request.authorization === "Bearer beta-node-token"
			)
	).toBe(true);
	expect(await Bun.file(join(home, ".ryu", "nodes.json")).json()).toMatchObject(
		{ default: "Beta node" }
	);
	expect(fixture.unexpected).toEqual([]);
});
