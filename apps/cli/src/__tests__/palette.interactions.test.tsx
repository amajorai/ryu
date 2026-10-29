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
import { clearPaletteRecents } from "../palette/CommandPalette.tsx";
import { testRender } from "./cli-test-render.ts";

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;
let testHome: string | null = null;
type RenderedApp = Awaited<ReturnType<typeof testRender>>;
let setup: RenderedApp | null = null;

afterEach(async () => {
	clearPaletteRecents();
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

interface KeyInput {
	ctrl?: boolean;
	name: string;
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
		await renderer.renderOnce();
	});
}

// press() renders inside its act scope, which can run before React commits the
// key's state update, so a frame captured right after it may lag one key. Render
// again after the commit so a key-by-key walk never skips a state.
async function pressAndCapture(
	renderer: RenderedApp,
	key: KeyInput
): Promise<string> {
	await press(renderer, key);
	await renderer.renderOnce();
	return renderer.captureCharFrame();
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
		throw new Error(
			`Command palette did not reach the expected state:\n${frame}`
		);
	}
	return frame;
}

// The sidebar's mode selector, or the status bar's mode label when a narrow
// terminal auto-hides the sidebar.
function hasConsoleMode(frame: string): boolean {
	return frame
		.split("\n")
		.some(
			(line) =>
				(line.includes("Ryu") &&
					line.includes("Agent") &&
					line.includes("⌄")) ||
				line.trimStart().startsWith("AGENT ·")
		);
}

test("Backspace edits the command-palette query and restores the matching destination", async () => {
	testHome = mkdtempSync(join(tmpdir(), "ryu-cli-palette-backspace-"));
	process.env.RYU_CLI_CONFIG_DIR = join(testHome, ".ryu");
	mkdirSync(join(testHome, ".ryu"), { recursive: true });
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console"),
		productModePreferencePath(testHome)
	);
	const agentReads: string[] = [];
	const provide = async (
		input: Parameters<typeof realFetch>[0]
	): ReturnType<typeof realFetch> => {
		const url = new URL(String(input));
		if (url.pathname === "/api/auth/status") {
			return Response.json({ authenticated: false, token: null });
		}
		if (url.pathname === "/api/agents") {
			agentReads.push(url.pathname);
			return Response.json({ agents: [] });
		}
		return Response.json({});
	};
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});

	const renderer = await testRender(<App target={LOCAL_TARGET} />, {
		height: 36,
		width: 140,
	});
	setup = renderer;
	await renderer.renderOnce();
	await waitForFrame(renderer, hasConsoleMode);

	await press(renderer, { ctrl: true, name: "k" });
	for (const character of "go to agentsx") {
		await press(renderer, { name: character });
	}
	const noMatch = await waitForFrame(renderer, (frame) =>
		frame.includes("No matches")
	);
	expect(noMatch).toContain("go to agentsx");

	await press(renderer, { name: "backspace" });
	const recovered = await waitForFrame(
		renderer,
		(frame) => frame.includes("› Go to Agents") && !frame.includes("No matches")
	);
	expect(recovered).toContain("go to agents");
	await press(renderer, { name: "return" });
	const agents = await waitForFrame(
		renderer,
		(frame) => frame.includes("Agents") && frame.includes("0 configured")
	);
	expect(agents).toContain("n new");
	for (let pass = 0; pass < 20 && agentReads.length === 0; pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await renderer.renderOnce();
	}
	expect(agentReads.length).toBeGreaterThan(0);
	expect(
		await Bun.file(productModePreferencePath(testHome)).json()
	).toMatchObject({
		mode: "console",
		surfaces: { console: "/agents" },
	});
});

async function renderConsolePalette(
	prefix: string,
	size: { height: number; width: number } = { height: 36, width: 140 }
): Promise<RenderedApp> {
	testHome = mkdtempSync(join(tmpdir(), prefix));
	process.env.RYU_CLI_CONFIG_DIR = join(testHome, ".ryu");
	mkdirSync(join(testHome, ".ryu"), { recursive: true });
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console"),
		productModePreferencePath(testHome)
	);
	globalThis.fetch = Object.assign(
		() => new Promise<Response>(() => undefined),
		{ preconnect: realFetch.preconnect }
	);
	const renderer = await testRender(<App target={LOCAL_TARGET} />, size);
	setup = renderer;
	await renderer.renderOnce();
	await waitForFrame(renderer, hasConsoleMode);
	await press(renderer, { ctrl: true, name: "k" });
	return renderer;
}

test("the space key types into the palette query", async () => {
	const renderer = await renderConsolePalette("ryu-cli-palette-space-");
	for (const character of ["n", "e", "w", "space", "c", "h", "a", "t"]) {
		await press(renderer, { name: character });
	}
	const frame = await waitForFrame(
		renderer,
		(current) =>
			current.includes("› New chat") && current.includes("⌕ new chat")
	);
	expect(frame).toContain("⌕ new chat");
	expect(frame).toContain("Enter run");
});

test("the unfiltered palette groups rows and shows right-aligned shortcuts", async () => {
	const renderer = await renderConsolePalette("ryu-cli-palette-groups-");
	const initial = await waitForFrame(renderer, (frame) =>
		frame.includes("Jump to")
	);
	expect(initial).toContain("Navigation");
	expect(initial).not.toContain("Suggested");
	expect(initial).toContain("› Go to Chat");
	expect(initial).toContain("Esc close");

	// Running an entry makes it a Suggested row the next time the palette opens.
	for (const character of "tools") {
		await press(renderer, { name: character });
	}
	await waitForFrame(renderer, (frame) => frame.includes("› Go to Tools"));
	await press(renderer, { name: "return" });
	await waitForFrame(renderer, (frame) => !frame.includes("Esc close"));
	await press(renderer, { ctrl: true, name: "k" });
	const suggested = await waitForFrame(renderer, (frame) =>
		frame.includes("Suggested")
	);
	const lines = suggested.split("\n");
	const headerLine = lines.findIndex((line) => line.includes("Suggested"));
	expect(lines[headerLine + 1]).toContain("› Go to Tools");

	// Header rows are not selectable: Down walks entry rows only, from the
	// Navigation section straight into the Actions section.
	let actions = renderer.captureCharFrame();
	for (let step = 0; step < 40 && !actions.includes("› New chat"); step += 1) {
		actions = await pressAndCapture(renderer, { name: "down" });
		expect(actions).toMatch(/│ › /);
	}
	expect(actions).toContain("Actions");
	const newChatLine = actions
		.split("\n")
		.find((line) => line.includes("› New chat"));
	expect(newChatLine).toMatch(/› New chat\s{4,}Ctrl\+T/);
});

test("a short terminal windows grouped rows so the whole panel stays on screen", async () => {
	const renderer = await renderConsolePalette("ryu-cli-palette-short-", {
		height: 20,
		width: 60,
	});
	await waitForFrame(renderer, (frame) => frame.includes("Jump to"));
	// Walk to the last entry so the Navigation -> Actions boundary (header and
	// spacer lines) scrolls through the window.
	let frame = renderer.captureCharFrame();
	for (let step = 0; step < 40 && !frame.includes("› Quit"); step += 1) {
		frame = await pressAndCapture(renderer, { name: "down" });
		const lines = frame.split("\n");
		const footer = lines.findIndex((line) => line.includes("Esc close"));
		expect(footer).toBeGreaterThan(-1);
		// The Modal's bottom border directly under the footer is still drawn.
		expect(lines[footer + 1]).toContain("╰");
	}
	expect(frame).toContain("› Quit");
	expect(frame).toMatch(/› Quit\s+Ctrl\+C/);
});
