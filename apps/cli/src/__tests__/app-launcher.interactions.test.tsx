/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { resolveSurface } from "../workspace/router.ts";
import { testRender } from "./cli-test-render.ts";

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
const realFetch = globalThis.fetch;
const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;

let testHome: string | null = null;
type RenderedApp = Awaited<ReturnType<typeof testRender>>;
let setup: RenderedApp | null = null;

afterEach(async () => {
	globalThis.fetch = realFetch;
	if (originalConfigDir === undefined) {
		delete process.env.RYU_CLI_CONFIG_DIR;
	} else {
		process.env.RYU_CLI_CONFIG_DIR = originalConfigDir;
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
	testHome = mkdtempSync(join(tmpdir(), "ryu-cli-app-launcher-ui-"));
	process.env.RYU_CLI_CONFIG_DIR = join(testHome, ".ryu");
	return testHome;
}

async function renderApp(width = 140, height = 42): Promise<RenderedApp> {
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
		throw new Error(`App Launcher did not reach expected state:\n${frame}`);
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

function appManifest() {
	return {
		built_in: false,
		companion: { label: "Example app" },
		enabled: true,
		id: "com.example.app",
		installed: true,
		installed_version: "1.0.0",
		local_only: false,
		name: "Example app",
		permission_grants: [],
		runnables: [],
		sidecar_name: null,
		version: "1.0.0",
		windows_first: false,
	};
}

test("OS launcher is palette-reachable, retries Core, and keeps a selected row visible past 12 results", async () => {
	const home = isolateHome();
	mkdirSync(join(home, ".ryu"), { recursive: true });
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console"),
		productModePreferencePath(home)
	);
	expect(resolveSurface("/app-launcher")?.id).toBe("app-launcher");

	let appReads = 0;
	installResponse(async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/auth/status") {
			return Response.json({ authenticated: false, token: null });
		}
		if (url.pathname === "/api/plugins") {
			appReads += 1;
			if (appReads < 3) {
				return Response.json({ error: "temporary offline" }, { status: 503 });
			}
			return Response.json({ apps: [appManifest()] });
		}
		if (url.pathname === "/api/plugins/contributions") {
			return Response.json({
				views: Array.from({ length: 13 }, (_, index) => ({
					id: `view-${String(index).padStart(2, "0")}`,
					plugin: "com.example.app",
					title: `View ${String(index).padStart(2, "0")}`,
					view: "unsupported-fixture-kind",
				})),
			});
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
	await press(renderer, { name: "return" });
	await waitForFrame(
		renderer,
		(frame) => hasMode(frame, "OS") && frame.includes("App Launcher")
	);
	const firstFailure = await waitForFrame(renderer, (frame) =>
		frame.includes("Core Apps unavailable")
	);
	expect(firstFailure).toContain("r retries");

	await press(renderer, { ctrl: true, name: "k" });
	for (const character of "home") {
		await press(renderer, { name: character });
	}
	const palette = await waitForFrame(renderer, (frame) =>
		frame.includes("Go to Home")
	);
	expect(palette).toContain("Go to Home");
	await press(renderer, { name: "return" });
	await waitForFrame(renderer, (frame) =>
		frame.includes("Your local overview")
	);
	await press(renderer, { ctrl: true, name: "k" });
	for (const character of "app launcher") {
		await press(renderer, { name: character });
	}
	const launcherPalette = await waitForFrame(renderer, (frame) =>
		frame.includes("Go to App Launcher")
	);
	expect(launcherPalette).toContain("Go to App Launcher");
	await press(renderer, { name: "return" });
	const offline = await waitForFrame(renderer, (frame) =>
		frame.includes("Core Apps unavailable")
	);
	expect(offline).toContain("r retries");
	await press(renderer, { name: "r" });
	await waitForFrame(
		renderer,
		(frame) => frame.includes("View 00") && frame.includes("Plugins & Sidecars")
	);
	expect(appReads).toBe(3);

	for (let index = 0; index < 22; index += 1) {
		await press(renderer, { name: "down" });
	}
	const lastRow = await waitForFrame(renderer, (frame) =>
		frame
			.split("\n")
			.some((line) => line.includes("›") && line.includes("View 12"))
	);
	expect(lastRow).toContain("View 12");
	await press(renderer, { name: "return" });
	const launched = await waitForFrame(
		renderer,
		(frame) => frame.includes("View 12") && frame.includes("com.example.app")
	);
	expect(launched).toContain("View 12");
	expect(launched).toContain("com.example.app");
	expect(await Bun.file(productModePreferencePath(home)).json()).toMatchObject({
		mode: "os",
		surfaces: { os: "/plugin-view/com.example.app/view-12" },
	});
});

test("App Launcher search opens its Plugins & Sidecars shortcut in the Store", async () => {
	const home = isolateHome();
	mkdirSync(join(home, ".ryu"), { recursive: true });
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console"),
		productModePreferencePath(home)
	);
	installResponse(async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/auth/status") {
			return Response.json({ authenticated: false, token: null });
		}
		if (url.pathname === "/api/plugins") {
			return Response.json({ apps: [] });
		}
		if (url.pathname === "/api/plugins/contributions") {
			return Response.json({ views: [] });
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
	await press(renderer, { name: "return" });
	await waitForFrame(
		renderer,
		(frame) => hasMode(frame, "OS") && frame.includes("App Launcher")
	);
	await press(renderer, { name: "p" });
	await press(renderer, { name: "l" });
	await press(renderer, { name: "u" });
	await press(renderer, { name: "g" });
	await press(renderer, { name: "i" });
	await press(renderer, { name: "n" });
	await press(renderer, { name: "s" });
	const shortcut = await waitForFrame(renderer, (frame) =>
		frame.includes("Plugins & Sidecars")
	);
	expect(shortcut).toContain("Browse and manage Plugins and Sidecars.");
	await press(renderer, { name: "return" });
	const store = await waitForFrame(
		renderer,
		(frame) => frame.includes("Plugins") && frame.includes("Sidecars")
	);
	expect(store).toContain("Plugins");
	expect(await Bun.file(productModePreferencePath(home)).json()).toMatchObject({
		mode: "os",
		surfaces: { os: "/store" },
	});
});
