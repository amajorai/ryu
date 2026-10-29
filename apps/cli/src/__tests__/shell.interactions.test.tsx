/* @jsxImportSource @opentui/react */
// Workspace keyboard tests: tab lifecycle (Ctrl+T new, Ctrl+W close,
// Ctrl+Shift+T restore) drives the TabStrip, and the palette exposes the bridged
// "New chat" action. These drive real key events through the OpenTUI test
// renderer and assert on the captured character frame.

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
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
import { ALL_KEYMAP } from "../core/keymap.ts";
import { nodesPath } from "../core/nodes.ts";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import { testRender } from "./cli-test-render.ts";

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;
const realFetch = globalThis.fetch;

let isolatedHome: string | null = null;

afterEach(async () => {
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
	globalThis.fetch = realFetch;
	if (originalConfigDir === undefined) {
		delete process.env.RYU_CLI_CONFIG_DIR;
	} else {
		process.env.RYU_CLI_CONFIG_DIR = originalConfigDir;
	}
	if (configDir) {
		rmSync(configDir, { recursive: true, force: true });
		configDir = undefined;
	}
	if (isolatedHome) {
		rmSync(isolatedHome, { force: true, recursive: true });
		isolatedHome = null;
	}
});

const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;
let configDir: string | undefined;
beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "ryu-shell-state-"));
	process.env.RYU_CLI_CONFIG_DIR = configDir;
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath()
	);
});
// This is a whole native serialized JSON object observation, not an AgentInput
// DTO. The fixture keeps native String coercion of individual fields unchanged.
const nativeJsonObjectFields = z.record(z.string(), appResponseValueSchema);
const nativeJsonObjectObservation = z.custom<
	z.infer<typeof nativeJsonObjectFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		nativeJsonObjectFields.safeParse(value).success
);
interface CreateRequestObservation {
	body: z.infer<typeof nativeJsonObjectObservation>;
	method: string;
	url: string;
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
function requireSetup() {
	if (!testSetup) {
		throw new Error("Expected active terminal renderer");
	}
	return testSetup;
}

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };

function hasMode(frame: string, mode: "BOT" | "AGENT" | "OS"): boolean {
	const label = mode[0] + mode.slice(1).toLowerCase();
	return frame
		.split("\n")
		.some(
			(line) =>
				line.includes("Ryu") && line.includes(label) && line.includes("⌄")
		);
}

function stubLocalAppStartup(
	agents: { id: string; name: string }[] = []
): void {
	installResponse(async (input) => {
		const path = new URL(String(input)).pathname;
		if (path === "/api/auth/status") {
			return Response.json({ authenticated: false, token: null });
		}
		if (path === "/api/health") {
			return Response.json({ status: "ok" });
		}
		if (path === "/api/agents") {
			return Response.json({ agents });
		}
		if (path === "/api/teams") {
			return Response.json({ teams: [] });
		}
		if (path === "/api/spaces") {
			return Response.json({ spaces: [] });
		}
		if (path === "/api/meetings") {
			return Response.json({ meetings: [] });
		}
		if (path === "/workflows") {
			return Response.json({ workflows: [] });
		}
		if (path === "/api/conversations") {
			return Response.json({ conversations: [] });
		}
		if (path === "/api/plugins/contributions") {
			return Response.json({ contributions: [] });
		}
		return Response.json({});
	});
}

interface KeyOverride {
	ctrl?: boolean;
	meta?: boolean;
	name: string;
	option?: boolean;
	shift?: boolean;
}

async function press(
	setup: Awaited<ReturnType<typeof testRender>>,
	key: KeyOverride,
	mode: "BOT" | "AGENT" | "OS" = "AGENT"
): Promise<void> {
	await frameSatisfying(setup, (frame) => hasMode(frame, mode));
	await emitKey(setup, key);
}

/** Emit one key without waiting for the sidebar's mode row (a hidden sidebar
 * never shows it). */
async function emitKey(
	setup: Awaited<ReturnType<typeof testRender>>,
	key: KeyOverride
): Promise<void> {
	const keyInput = setup.renderer.keyInput;
	await act(async () => {
		keyInput.emit(
			"keypress",
			new KeyEvent({
				name: key.name,
				sequence: key.name.length === 1 ? key.name : "",
				ctrl: key.ctrl ?? false,
				shift: key.shift ?? false,
				meta: key.meta ?? false,
				option: key.option ?? false,
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

// A keystroke schedules a React state update whose result only reaches the
// captured character frame after the render commits. A single renderOnce()
// USUALLY catches it, but under full-suite load (GC pressure, shared event loop)
// the tab-restore frame occasionally lags one commit, which is the act()-race
// flake. Poll renderOnce until the frame satisfies `predicate` (or a bounded
// number of frames elapse), then return that settled frame so the assertion is
// deterministic rather than timing-dependent.
async function frameSatisfying(
	setup: Awaited<ReturnType<typeof testRender>>,
	predicate: (frame: string) => boolean,
	maxFrames = 30
): Promise<string> {
	let frame = setup.captureCharFrame();
	for (let i = 0; i < maxFrames && !predicate(frame); i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await setup.renderOnce();
			frame = setup.captureCharFrame();
		});
	}
	return frame;
}

// Raw count of the "New chat" tab-title glyph across the whole frame. The sidebar
// contributes a constant baseline, so the test asserts on relative deltas: each
// open chat tab adds one occurrence in the TabStrip.
function countNewChat(frame: string): number {
	return frame.split("New chat").length - 1;
}

function paneTabCounts(frame: string): [number, number] {
	const row = frame
		.split("\n")
		.find((line) => line.includes("Ryu") && line.includes("New chat"));
	if (!row) {
		return [0, 0];
	}
	const tabStrip = row.slice(row.indexOf("Ryu") + "Ryu".length);
	const [firstPane = "", ...otherPanes] = tabStrip.split("│");
	return [countNewChat(firstPane), countNewChat(otherPanes.join("│"))];
}

test("Ctrl+T opens a tab, Ctrl+W closes it, Ctrl+Shift+T restores it", async () => {
	stubLocalAppStartup();
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 34,
	});
	await frameSatisfying(testSetup, (frame) => hasMode(frame, "AGENT"));
	await testSetup.flush({ maxPasses: 30 });
	const base = countNewChat(testSetup.captureCharFrame());

	await press(testSetup, { name: "t", ctrl: true });
	const opened = await frameSatisfying(
		testSetup,
		(frame) => countNewChat(frame) === base + 1
	);
	expect(countNewChat(opened)).toBe(base + 1);

	await press(testSetup, { name: "w", ctrl: true });
	const closed = await frameSatisfying(
		testSetup,
		(frame) => countNewChat(frame) === base
	);
	expect(countNewChat(closed)).toBe(base);

	await press(testSetup, { name: "t", ctrl: true, shift: true });
	const restored = await frameSatisfying(
		testSetup,
		(frame) => countNewChat(frame) === base + 1
	);
	expect(restored).not.toContain("Error:");
	expect(countNewChat(restored)).toBe(base + 1);
});

test("Alt+Left and Alt+Right focus their pane before Ctrl+T opens a tab", async () => {
	stubLocalAppStartup();
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 34,
	});
	await frameSatisfying(testSetup, (frame) => hasMode(frame, "AGENT"));
	await testSetup.flush({ maxPasses: 30 });
	await press(testSetup, { name: "s", ctrl: true, option: true });
	await frameSatisfying(testSetup, (frame) =>
		paneTabCounts(frame).every((count) => count === 1)
	);

	await press(testSetup, { name: "left", option: true });
	await press(testSetup, { name: "t", ctrl: true });
	const leftFocused = await frameSatisfying(
		testSetup,
		(frame) => JSON.stringify(paneTabCounts(frame)) === JSON.stringify([2, 1])
	);
	expect(paneTabCounts(leftFocused)).toEqual([2, 1]);

	await press(testSetup, { name: "right", option: true });
	await press(testSetup, { name: "t", ctrl: true });
	const rightFocused = await frameSatisfying(
		testSetup,
		(frame) => JSON.stringify(paneTabCounts(frame)) === JSON.stringify([2, 2])
	);
	expect(paneTabCounts(rightFocused)).toEqual([2, 2]);
});

const STATUS_HINTS = new Set([
	"^K palette",
	"^N node",
	"^⇧M mode",
	"^T new",
	"^W close",
	"^C×2 quit",
	"^A agent",
	"F1 keys",
	"^B sidebar",
]);

test("a narrow 60x20 status bar shows only whole key-label hints", async () => {
	stubLocalAppStartup();
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 60,
		height: 20,
	});
	const frame = await frameSatisfying(testSetup, (candidate) =>
		candidate.includes("^A agent")
	);
	const bar = frame.trimEnd().split("\n").at(-1)?.trim() ?? "";
	const [left, ...hints] = bar.split(/\s{2,}/);
	expect(left?.startsWith("AGENT")).toBe(true);
	expect(hints.length).toBeGreaterThan(0);
	for (const hint of hints) {
		expect(STATUS_HINTS.has(hint)).toBe(true);
	}
	expect(hints).toContain("^K palette");
	expect(hints).toContain("^C×2 quit");
	// The chat surface's hints outrank the lower-priority globals.
	expect(hints).toContain("^A agent");
	expect(hints.length).toBeLessThan(STATUS_HINTS.size);
});

test("an 80x24 status bar shows the full node url ahead of secondary hints", async () => {
	stubLocalAppStartup();
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 24,
	});
	const frame = await frameSatisfying(testSetup, (candidate) =>
		candidate.includes("^A agent")
	);
	const bar = frame.trimEnd().split("\n").at(-1)?.trim() ?? "";
	const [left, ...hints] = bar.split(/\s{2,}/);
	expect(left).toBe(`AGENT · ${LOCAL_TARGET.url}`);
	for (const hint of hints) {
		expect(STATUS_HINTS.has(hint)).toBe(true);
	}
	expect(hints).toEqual(["^A agent", "^K palette", "F1 keys", "^C×2 quit"]);
});

test("an open overlay hides the focused pane's status hints", async () => {
	stubLocalAppStartup();
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 120,
		height: 44,
	});
	const lastLine = (frame: string) => frame.trimEnd().split("\n").at(-1) ?? "";
	await frameSatisfying(testSetup, (frame) =>
		lastLine(frame).includes("^A agent")
	);
	await press(testSetup, { name: "k", ctrl: true });
	for (const character of "settings") {
		await press(testSetup, { name: character });
	}
	await press(testSetup, { name: "return" });
	const settings = await frameSatisfying(
		testSetup,
		(frame) => frame.includes("Esc close") && !lastLine(frame).includes("^A")
	);
	expect(settings).toContain("Esc close");
	expect(lastLine(settings)).not.toContain("^A agent");
	expect(lastLine(settings)).toContain("^K palette");
});

// Mounts the shell on the chat surface with renderer.destroy stubbed so a quit
// is counted rather than tearing the test renderer down mid-test. Like
// src/index.tsx, the renderer's own exit-on-Ctrl+C is off so only the shell's
// layered handler can quit.
async function renderShellCountingQuits(): Promise<{
	quits: () => number;
	restore: () => void;
	setup: Awaited<ReturnType<typeof testRender>>;
}> {
	stubLocalAppStartup();
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		exitOnCtrlC: false,
		width: 120,
		height: 30,
	});
	testSetup = setup;
	await frameSatisfying(setup, (frame) => hasMode(frame, "AGENT"));
	await setup.flush({ maxPasses: 30 });
	const renderer = setup.renderer;
	const destroy = renderer.destroy;
	let calls = 0;
	renderer.destroy = () => {
		calls += 1;
	};
	return {
		setup,
		quits: () => calls,
		restore: () => {
			renderer.destroy = destroy;
		},
	};
}

test("Ctrl+C arms the exit and a second press within 2s quits", async () => {
	const { setup, quits, restore } = await renderShellCountingQuits();
	await press(setup, { name: "c", ctrl: true });
	const armed = await frameSatisfying(setup, (frame) =>
		frame.includes("Press Ctrl+C again")
	);
	expect(armed).toContain("Press Ctrl+C again to quit");
	expect(quits()).toBe(0);
	await press(setup, { name: "c", ctrl: true });
	expect(quits()).toBeGreaterThan(0);
	restore();
});

test("Ctrl+C re-arms instead of quitting once the 2s window lapses", async () => {
	const { setup, quits, restore } = await renderShellCountingQuits();
	const realNow = Date.now;
	let now = realNow();
	Date.now = () => now;
	try {
		await press(setup, { name: "c", ctrl: true });
		now += 2500;
		await press(setup, { name: "c", ctrl: true });
		expect(quits()).toBe(0);
		now += 500;
		await press(setup, { name: "c", ctrl: true });
		expect(quits()).toBeGreaterThan(0);
	} finally {
		Date.now = realNow;
		restore();
	}
});

test("Ctrl+C disarms after any other key and drops the stale prompt", async () => {
	const { setup, quits, restore } = await renderShellCountingQuits();
	await press(setup, { name: "c", ctrl: true });
	await frameSatisfying(setup, (frame) => frame.includes("Press Ctrl+C again"));
	await press(setup, { name: "right", option: true });
	const disarmed = await frameSatisfying(
		setup,
		(frame) => !frame.includes("Press Ctrl+C again")
	);
	expect(disarmed).not.toContain("Press Ctrl+C again");
	await press(setup, { name: "c", ctrl: true });
	expect(quits()).toBe(0);
	const rearmed = await frameSatisfying(setup, (frame) =>
		frame.includes("Press Ctrl+C again")
	);
	expect(rearmed).toContain("Press Ctrl+C again to quit");
	const toastLine = rearmed
		.split("\n")
		.find((line) => line.includes("Press Ctrl+C again"));
	expect(toastLine).not.toContain("×");
	restore();
});

test("Ctrl+C clears a chat draft and keeps the app running", async () => {
	const { setup, quits, restore } = await renderShellCountingQuits();
	await act(async () => {
		await setup.mockInput.typeText("hello draft");
	});
	await setup.flush({ maxPasses: 12 });
	await frameSatisfying(setup, (frame) => frame.includes("hello draft"));
	await press(setup, { name: "c", ctrl: true });
	const cleared = await frameSatisfying(
		setup,
		(frame) => !frame.includes("hello draft")
	);
	expect(cleared).not.toContain("hello draft");
	expect(cleared).not.toContain("Press Ctrl+C again");
	expect(quits()).toBe(0);
	restore();
});

test("Ctrl+K opens the palette without the composer also cutting the draft", async () => {
	const { setup, restore } = await renderShellCountingQuits();
	await act(async () => {
		await setup.mockInput.typeText("hello draft");
	});
	await setup.flush({ maxPasses: 12 });
	await frameSatisfying(setup, (frame) => frame.includes("hello draft"));
	// From the line start the textarea's own Ctrl+K would delete the whole line.
	await emitKey(setup, { name: "home" });
	await emitKey(setup, { name: "k", ctrl: true });
	await frameSatisfying(setup, (frame) => frame.includes("Switch node"));
	await emitKey(setup, { name: "escape" });
	const back = await frameSatisfying(setup, (frame) =>
		frame.includes("hello draft")
	);
	expect(back).toContain("hello draft");
	restore();
});

test("Ctrl+C copies a highlighted selection instead of arming the quit", async () => {
	const { setup, quits, restore } = await renderShellCountingQuits();
	const copies: string[] = [];
	setup.renderer.copyToClipboardOSC52 = (text: string) => {
		copies.push(text);
		return true;
	};
	const rows = setup.captureCharFrame().split("\n");
	const y = rows.findIndex((row) => row.includes("AGENT ·"));
	const x = rows[y]?.indexOf("AGENT ·") ?? -1;
	expect(y).toBeGreaterThanOrEqual(0);
	await act(async () => {
		await setup.mockMouse.drag(x, y, x + "AGENT".length, y);
	});
	await setup.flush({ maxPasses: 4 });
	expect(copies).toEqual(["AGENT"]);
	await press(setup, { name: "c", ctrl: true });
	expect(copies).toEqual(["AGENT", "AGENT"]);
	expect(setup.renderer.getSelection()).toBeNull();
	expect(setup.captureCharFrame()).not.toContain("Press Ctrl+C again");
	expect(quits()).toBe(0);
	restore();
});

test("palette exposes the New chat action", async () => {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 34,
	});

	await press(testSetup, { name: "k", ctrl: true });
	for (const ch of "new") {
		await press(testSetup, { name: ch });
	}
	const frame = await frameSatisfying(testSetup, (f) => f.includes("New chat"));
	expect(frame).not.toContain("Error:");
	expect(frame).toContain("New chat");
});

test("command palette arrow keys change selection and Escape dismisses it", async () => {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 34,
	});
	await press(testSetup, { name: "k", ctrl: true });
	for (const character of "go to") {
		await press(testSetup, { name: character });
	}
	const first = await frameSatisfying(testSetup, (frame) =>
		frame.includes("› Go to Chat")
	);
	expect(first).toContain("› Go to Chat");
	await press(testSetup, { name: "down" });
	await frameSatisfying(testSetup, (frame) => frame.includes("› Go to Agents"));
	await press(testSetup, { name: "up" });
	await frameSatisfying(testSetup, (frame) => frame.includes("› Go to Chat"));
	await press(testSetup, { name: "escape" });
	expect(
		await frameSatisfying(testSetup, (frame) => !frame.includes("Jump to"))
	).not.toContain("Jump to");
});

const SHORTCUTS_TITLE = "Keyboard shortcuts";

// Keymap rows on screen: a frame line carrying both an entry's keys and label.
function visibleKeymapRows(frame: string): string[] {
	const lines = frame.split("\n");
	return ALL_KEYMAP.filter((entry) =>
		lines.some(
			(line) => line.includes(entry.keys) && line.includes(entry.label)
		)
	).map((entry) => entry.id);
}

test("F1 opens the shortcuts overlay, filters as you type, and toggles closed", async () => {
	stubLocalAppStartup();
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 40,
	});
	await frameSatisfying(testSetup, (frame) => frame.includes("Ask anything"));
	await press(testSetup, { name: "f1" });
	const opened = await frameSatisfying(
		testSetup,
		(frame) => frame.includes(SHORTCUTS_TITLE) && frame.includes("Ctrl+Alt+S")
	);
	expect(opened).toContain("Ctrl+Alt+S");
	expect(opened).toContain("split");
	expect(visibleKeymapRows(opened).length).toBeGreaterThan(5);

	await act(async () => {
		await requireSetup().mockInput.typeText("split");
	});
	const filtered = await frameSatisfying(
		testSetup,
		(frame) => visibleKeymapRows(frame).length === 1
	);
	expect(visibleKeymapRows(filtered)).toEqual(["split"]);
	// The whole query shows in the filter field (it does not scroll off).
	expect(filtered).toContain("⌕ split");
	// The filter text went to the overlay, not the chat composer behind it.
	expect(filtered).not.toContain("Error:");

	await press(testSetup, { name: "f1" });
	const closed = await frameSatisfying(
		testSetup,
		(frame) => !frame.includes(SHORTCUTS_TITLE)
	);
	expect(closed).not.toContain(SHORTCUTS_TITLE);
	expect(closed).toContain("Ask anything");
});

test("a raw Ctrl+/ (0x1F) from the terminal opens the shortcuts overlay", async () => {
	stubLocalAppStartup();
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 40,
	});
	await frameSatisfying(testSetup, (frame) => frame.includes("Ask anything"));
	await act(async () => {
		// Real input path: the mock terminal writes "\x1f", which parses as Ctrl+_.
		requireSetup().mockInput.pressKey("/", { ctrl: true });
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	const opened = await frameSatisfying(testSetup, (frame) =>
		frame.includes(SHORTCUTS_TITLE)
	);
	expect(opened).toContain("Ctrl+?");
	await press(testSetup, { name: "escape" });
	expect(
		await frameSatisfying(
			testSetup,
			(frame) => !frame.includes(SHORTCUTS_TITLE)
		)
	).not.toContain(SHORTCUTS_TITLE);
});

test("a bare ? stays composer text but opens the shortcuts outside text fields", async () => {
	stubLocalAppStartup();
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 40,
	});
	await frameSatisfying(testSetup, (frame) => frame.includes("Ask anything"));
	await act(async () => {
		await requireSetup().mockInput.typeText("why?");
	});
	const typed = await frameSatisfying(testSetup, (frame) =>
		frame.includes("why?")
	);
	expect(typed).toContain("why?");
	expect(typed).not.toContain(SHORTCUTS_TITLE);

	await press(testSetup, { name: "k", ctrl: true });
	for (const character of "tasks") {
		await press(testSetup, { name: character });
	}
	await press(testSetup, { name: "return" });
	await frameSatisfying(testSetup, (frame) => !frame.includes("Jump to"));
	await testSetup.flush({ maxPasses: 12 });
	await press(testSetup, { name: "?" });
	expect(
		await frameSatisfying(testSetup, (frame) => frame.includes(SHORTCUTS_TITLE))
	).toContain(SHORTCUTS_TITLE);
});

test("a bare ? in the left pane's composer after a split stays composer text", async () => {
	stubLocalAppStartup();
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 34,
	});
	await frameSatisfying(testSetup, (frame) => hasMode(frame, "AGENT"));
	await testSetup.flush({ maxPasses: 30 });
	await press(testSetup, { name: "s", ctrl: true, option: true });
	await frameSatisfying(testSetup, (frame) =>
		paneTabCounts(frame).every((count) => count === 1)
	);
	// The right pane releases its input claim after the left pane claims it;
	// claims are per surface, so the left composer still owns "?".
	await press(testSetup, { name: "left", option: true });
	await press(testSetup, { name: "?" });
	await frameSatisfying(testSetup, (frame) => frame.includes("› ?"));
	// Let any shortcuts overlay the same key might open commit before asserting.
	await testSetup.flush({ maxPasses: 12 });
	const typed = testSetup.captureCharFrame();
	expect(typed).toContain("› ?");
	expect(typed).not.toContain(SHORTCUTS_TITLE);
});

test("palette lists Keyboard shortcuts with its key", async () => {
	stubLocalAppStartup();
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 34,
	});
	await press(testSetup, { name: "k", ctrl: true });
	for (const character of "keyboard") {
		await press(testSetup, { name: character });
	}
	const frame = await frameSatisfying(testSetup, (candidate) =>
		candidate.includes("Keyboard shortcuts")
	);
	const row = frame
		.split("\n")
		.find((line) => line.includes("Keyboard shortcuts"));
	expect(row).toContain("F1");
	await press(testSetup, { name: "return" });
	expect(
		await frameSatisfying(testSetup, (candidate) =>
			candidate.includes("Filter shortcuts and commands")
		)
	).toContain("Ctrl+Alt+S");
});

test("Ctrl+Tab and Ctrl+Shift+Tab activate adjacent workspace tabs", async () => {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 34,
	});

	await press(testSetup, { name: "k", ctrl: true });
	for (const ch of "library") {
		await press(testSetup, { name: ch });
	}
	await press(testSetup, { name: "return" });
	expect(
		await frameSatisfying(testSetup, (frame) => frame.includes("recipes ·"))
	).toContain("recipes ·");

	await press(testSetup, { name: "tab", ctrl: true });
	expect(
		await frameSatisfying(testSetup, (frame) => frame.includes("Ask anything"))
	).toContain("Ask anything");

	await press(testSetup, { name: "tab", ctrl: true, shift: true });
	expect(
		await frameSatisfying(testSetup, (frame) => frame.includes("recipes ·"))
	).toContain("recipes ·");
});

test("node picker Escape cancels and Enter persists the selected node", async () => {
	isolatedHome = mkdtempSync(join(tmpdir(), "ryu-cli-node-picker-"));

	const configPath = nodesPath();
	mkdirSync(join(isolatedHome, ".ryu"), { recursive: true });
	writeFileSync(
		configPath,
		JSON.stringify({
			default: "primary",
			nodes: [
				{ name: "primary", url: LOCAL_TARGET.url, token: null },
				{ name: "secondary", url: "http://127.0.0.1:7981", token: null },
			],
		})
	);
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "os", "/chat"),
		productModePreferencePath(isolatedHome)
	);
	installResponse(
		async () =>
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			})
	);

	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 34,
	});
	await frameSatisfying(testSetup, (frame) => hasMode(frame, "OS"));
	const pressOs = (key: KeyOverride) => press(requireSetup(), key, "OS");

	const openPicker = async (): Promise<void> => {
		const rows = testSetup?.captureCharFrame().split("\n") ?? [];
		const y = rows.findIndex((row) => row.includes("127.0.0.1:7980"));
		const x = rows[y]?.indexOf("127.0.0.1:7980") ?? -1;
		if (!testSetup || y < 0 || x < 0) {
			throw new Error(`Sidebar node selector missing:\n${rows.join("\n")}`);
		}
		await act(async () => {
			await testSetup?.mockMouse.click(x, y);
		});
		await testSetup.flush({ maxPasses: 12 });
	};

	await openPicker();
	expect(testSetup.captureCharFrame()).toContain("Enter switch");
	await pressOs({ name: "escape" });
	expect(
		await frameSatisfying(testSetup, (frame) => !frame.includes("Enter switch"))
	).not.toContain("Switch node");
	expect(JSON.parse(readFileSync(configPath, "utf8")).default).toBe("primary");

	await openPicker();
	const selectedNode = async (name: string) =>
		frameSatisfying(requireSetup(), (frame) =>
			frame.split("\n").some((row) => row.includes("›") && row.includes(name))
		);
	expect(await selectedNode("primary")).toContain("primary");
	await pressOs({ name: "k" });
	expect(await selectedNode("secondary")).toContain("secondary");
	await pressOs({ name: "j" });
	expect(await selectedNode("primary")).toContain("primary");
	await pressOs({ name: "up" });
	expect(await selectedNode("secondary")).toContain("secondary");
	await pressOs({ name: "down" });
	expect(await selectedNode("primary")).toContain("primary");
	await pressOs({ name: "down" });
	expect(await selectedNode("secondary")).toContain("secondary");
	await press(testSetup, { name: "return" });
	expect(JSON.parse(readFileSync(configPath, "utf8")).default).toBe(
		"secondary"
	);
	expect(
		await frameSatisfying(testSetup, (frame) =>
			frame.includes("127.0.0.1:7981")
		)
	).toContain("127.0.0.1:7981");
});

test("Calendar and Tasks navigate scheduled jobs, open history, and refresh", async () => {
	let jobsCalls = 0;
	const jobs = [
		{
			id: "job-alpha",
			name: "Alpha job",
			schedule: { kind: "every", interval: "5m" },
			target: { type: "agent", agent_id: "agent-1", prompt: "alpha" },
			created_at: "2026-09-01T00:00:00Z",
			updated_at: "2026-09-01T00:00:00Z",
			enabled: true,
			last_run_at: "2026-09-02T00:00:00Z",
			last_outcome: "success",
			history: [],
		},
		{
			id: "job-beta",
			name: "Beta job",
			schedule: { kind: "cron", expr: "0 * * * *" },
			target: { type: "workflow", workflow_id: "wf-1", input: {} },
			created_at: "2026-09-01T00:00:00Z",
			updated_at: "2026-09-01T00:00:00Z",
			enabled: false,
			last_run_at: null,
			last_outcome: null,
			history: [],
		},
	];
	installResponse(async (input) => {
		const url = String(input);
		let body: z.infer<typeof appRequestValueSchema> = {};
		// The list opts in to app jobs (`?include=app_jobs`), so match the path.
		if (url.split("?")[0].endsWith("/heartbeat/jobs")) {
			jobsCalls += 1;
			body = { jobs };
		}
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});

	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 34,
	});
	await press(testSetup, { name: "k", ctrl: true });
	for (const ch of "calendar") {
		await press(testSetup, { name: ch });
	}
	await press(testSetup, { name: "return" });
	const calendar = await frameSatisfying(
		testSetup,
		(frame) => frame.includes("Alpha job") && frame.includes("agenda")
	);
	expect(calendar).toContain("Alpha job");
	expect(jobsCalls).toBe(1);

	await press(testSetup, { name: "down" });
	await frameSatisfying(testSetup, (frame) =>
		frame
			.split("\n")
			.some((row) => row.includes("›") && row.includes("Beta job"))
	);
	await press(testSetup, { name: "k" });
	await frameSatisfying(testSetup, (frame) =>
		frame
			.split("\n")
			.some((row) => row.includes("›") && row.includes("Alpha job"))
	);
	await press(testSetup, { name: "up" });
	await frameSatisfying(testSetup, (frame) =>
		frame
			.split("\n")
			.some((row) => row.includes("›") && row.includes("Alpha job"))
	);
	await press(testSetup, { name: "j" });
	await frameSatisfying(testSetup, (frame) =>
		frame
			.split("\n")
			.some((row) => row.includes("›") && row.includes("Beta job"))
	);
	await press(testSetup, { name: "r" });
	await frameSatisfying(testSetup, () => jobsCalls === 2);

	await press(testSetup, { name: "return" });
	const tasks = await frameSatisfying(
		testSetup,
		(frame) => frame.includes("scheduled jobs") && frame.includes("Alpha job")
	);
	expect(tasks).toContain("scheduled jobs");
	expect(jobsCalls).toBe(3);
	await press(testSetup, { name: "j" });
	await frameSatisfying(testSetup, (frame) =>
		frame
			.split("\n")
			.some((row) => row.includes("›") && row.includes("Beta job"))
	);
	await press(testSetup, { name: "k" });
	await frameSatisfying(testSetup, (frame) =>
		frame
			.split("\n")
			.some((row) => row.includes("›") && row.includes("Alpha job"))
	);
	await press(testSetup, { name: "up" });
	expect(
		testSetup
			.captureCharFrame()
			.split("\n")
			.some((row) => row.includes("›") && row.includes("Alpha job"))
	).toBe(true);
	await press(testSetup, { name: "down" });
	await press(testSetup, { name: "r" });
	await frameSatisfying(testSetup, () => jobsCalls === 4);
	expect(jobsCalls).toBe(4);
});

test("Agents creates a record through keyboard focus and Ctrl+S", async () => {
	const createRequests: CreateRequestObservation[] = [];
	installResponse(async (input, init) => {
		const url = String(input);
		let body: z.infer<typeof appRequestValueSchema> = {};
		if (url.endsWith("/api/agents") && init?.method === "POST") {
			createRequests.push({
				body: nativeJsonObjectObservation.parse(JSON.parse(String(init.body))),
				method: init.method,
				url,
			});
			body = {
				agent: {
					id: "created-agent",
					name: "Draft Agent",
					engine: "mock-engine",
					version: "1.0.0",
				},
			};
		} else if (url.endsWith("/api/agents")) {
			body = { agents: [{ id: "existing-agent", name: "Existing Agent" }] };
		}
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});

	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 34,
	});
	await press(testSetup, { name: "k", ctrl: true });
	for (const ch of "agents") {
		await press(testSetup, { name: ch });
	}
	await press(testSetup, { name: "return" });
	expect(
		await frameSatisfying(
			testSetup,
			(frame) =>
				frame.includes("1 configured") && frame.includes("Existing Agent")
		)
	).toContain("Existing Agent");

	await press(testSetup, { name: "n" });
	expect(
		await frameSatisfying(testSetup, (frame) => frame.includes("New agent"))
	).toContain("New agent");
	await press(testSetup, { name: "escape" });
	const cancelled = await frameSatisfying(
		testSetup,
		(frame) => frame.includes("1 configured") && !frame.includes("New agent")
	);
	expect(cancelled).toContain("Existing Agent");
	expect(createRequests).toEqual([]);
	await press(testSetup, { name: "n" });
	await frameSatisfying(testSetup, (frame) =>
		frame.includes("How should this agent work?")
	);
	await press(testSetup, { name: "return" }); // keep "Acts as you"
	await frameSatisfying(testSetup, (frame) => frame.includes("Agent name"));
	await press(testSetup, { name: "backspace" });
	await act(async () => {
		await testSetup?.mockInput.typeText("Draft Agent", 10);
	});
	await testSetup.flush({ maxPasses: 12 });
	await act(async () => {
		testSetup?.mockInput.pressTab();
		testSetup?.mockInput.pressTab();
	});
	await testSetup.flush({ maxPasses: 12 });
	await act(async () => {
		await testSetup?.mockInput.typeText("mock-engine", 10);
	});
	await testSetup.flush({ maxPasses: 12 });
	expect(testSetup.captureCharFrame()).toContain("mock-engine");
	await act(async () => {
		testSetup?.mockInput.pressKey("s", { ctrl: true });
	});
	await testSetup.flush({ maxPasses: 12 });

	const saved = await frameSatisfying(
		testSetup,
		(frame) => frame.includes("Existing Agent") && !frame.includes("New agent")
	);
	expect(saved).toContain("Existing Agent");
	expect(createRequests.at(-1)).toEqual({
		body: {
			name: "Draft Agent",
			title: null,
			description: null,
			system_prompt: null,
			engine: "mock-engine",
			model: null,
			tools: ["__ryu_none__"],
			composio_actions: [],
			skills: [],
			persona: { display_name: null, tone: null },
			orchestrator: null,
			can_create_agents: null,
			identity_mode: "managed",
		},
		method: "POST",
		url: `${LOCAL_TARGET.url}/api/agents`,
	});
});

test("Agents Enter detail and e edit save the currently focused field", async () => {
	const updates: z.infer<typeof nativeJsonObjectObservation>[] = [];
	let agentListReads = 0;
	let currentName = "Existing Agent";
	let currentVersion = "1.2.3";
	const agentRecord = () => ({
		id: "existing-agent",
		name: currentName,
		description: "Original description",
		system_prompt: "Original prompt",
		engine: "mock-engine",
		tools: [],
		skills: [],
		version: currentVersion,
		created_at: "2026-09-01T00:00:00Z",
		updated_at: "2026-09-01T00:00:00Z",
	});
	installResponse(async (input, init) => {
		const url = String(input);
		let body: z.infer<typeof appRequestValueSchema> = {};
		if (url.endsWith("/api/agents/existing-agent") && init?.method === "PUT") {
			const update = nativeJsonObjectObservation.parse(
				JSON.parse(String(init.body))
			);
			updates.push(update);
			currentName = String(update.name);
			currentVersion = String(update.version);
			body = { agent: agentRecord() };
		} else if (url.endsWith("/api/agents/existing-agent")) {
			body = { agent: agentRecord() };
		} else if (url.endsWith("/api/agents")) {
			agentListReads += 1;
			body = {
				agents: [
					{ id: "agent-alpha", name: "Alpha Agent" },
					{ id: "existing-agent", name: currentName },
				],
			};
		}
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	const setup = testSetup;
	await press(setup, { name: "k", ctrl: true });
	for (const character of "agents") {
		await press(setup, { name: character });
	}
	await press(setup, { name: "return" });
	await frameSatisfying(
		setup,
		(frame) =>
			frame.includes("2 configured") && frame.includes("Existing Agent")
	);
	const selectedAgentName = async (name: string) =>
		frameSatisfying(setup, (frame) =>
			frame.split("\n").some((row) => row.includes("›") && row.includes(name))
		);
	await press(setup, { name: "down" });
	expect(await selectedAgentName("Existing Agent")).toContain("Existing Agent");
	await press(setup, { name: "k" });
	expect(await selectedAgentName("Alpha Agent")).toContain("Alpha Agent");
	await press(setup, { name: "j" });
	expect(await selectedAgentName("Existing Agent")).toContain("Existing Agent");
	await press(setup, { name: "up" });
	expect(await selectedAgentName("Alpha Agent")).toContain("Alpha Agent");
	await press(setup, { name: "down" });
	expect(await selectedAgentName("Existing Agent")).toContain("Existing Agent");
	const previousListReads = agentListReads;
	await press(setup, { name: "r" });
	await frameSatisfying(setup, () => agentListReads > previousListReads);
	await press(setup, { name: "return" });
	await frameSatisfying(setup, (frame) =>
		frame.includes("Original description")
	);
	await press(setup, { name: "e" });
	await frameSatisfying(setup, (frame) => frame.includes("Tab move field"));
	await act(async () => {
		await setup.mockInput.typeText(" v2", 50);
	});
	await press(setup, { name: "s", ctrl: true });
	await frameSatisfying(setup, (frame) => frame.includes("Existing Agent v2"));
	expect(updates).toHaveLength(1);
	expect(updates[0]).toMatchObject({
		name: "Existing Agent v2",
		version: "1.2.4",
	});
});

test("Settings and Gateway overlays navigate sections and close on Escape", async () => {
	let gatewayStatusReads = 0;
	const featureReads: { method: string; path: string }[] = [];
	installResponse(async (input, init) => {
		const url = String(input);
		let body: z.infer<typeof appRequestValueSchema> = {};
		if (new URL(url).pathname === "/api/plugins") {
			expect(new URL(url).origin).toBe(LOCAL_TARGET.url);
			expect(new URL(url).search).toBe("");
			expect(init?.method ?? "GET").toBe("GET");
			expect(init?.body).toBeUndefined();
			featureReads.push({ method: "GET", path: "/api/plugins" });
			body = {
				apps: [
					{
						id: "com.example.shell-navigation",
						name: "Canonical shell feature",
						enabled: true,
						installed: true,
						version: "1.0.0",
						built_in: false,
					},
				],
			};
		}
		if (url.includes("/api/gateway/status")) {
			gatewayStatusReads += 1;
			body = { reachable: true, effective_config: {} };
		}
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});

	await press(testSetup, { name: "k", ctrl: true });
	for (const ch of "settings") {
		await press(testSetup, { name: ch });
	}
	await press(testSetup, { name: "return" });
	expect(
		await frameSatisfying(testSetup, (frame) => frame.includes("General"))
	).toContain("General");
	await press(testSetup, { name: "down" });
	expect(
		await frameSatisfying(testSetup, (frame) =>
			frame.includes("Canonical shell feature")
		)
	).toContain("Apps and features installed on this node.");
	expect(featureReads).toEqual([{ method: "GET", path: "/api/plugins" }]);
	await press(testSetup, { name: "j" });
	expect(
		await frameSatisfying(testSetup, (frame) =>
			frame.includes("Terminal appearance follows")
		)
	).toContain("Terminal appearance follows");
	await press(testSetup, { name: "k" });
	await frameSatisfying(testSetup, (frame) =>
		frame.includes("Canonical shell feature")
	);
	expect(featureReads).toEqual([
		{ method: "GET", path: "/api/plugins" },
		{ method: "GET", path: "/api/plugins" },
	]);
	await press(testSetup, { name: "up" });
	await frameSatisfying(testSetup, (frame) =>
		frame.includes("Node connection is managed")
	);
	await press(testSetup, { name: "escape" });
	expect(
		await frameSatisfying(testSetup, (frame) => !frame.includes("Esc close"))
	).not.toContain("Settings");

	await press(testSetup, { name: "k", ctrl: true });
	for (let attempt = 0; attempt < 8; attempt += 1) {
		await press(testSetup, { name: "backspace" });
	}
	for (const ch of "gateway") {
		await press(testSetup, { name: ch });
	}
	await press(testSetup, { name: "return" });
	await frameSatisfying(testSetup, (frame) =>
		frame.includes("No providers reported")
	);
	expect(gatewayStatusReads).toBe(1);
	await press(testSetup, { name: "down" });
	expect(
		await frameSatisfying(testSetup, (frame) =>
			frame.includes("User-level model routing, evaluated")
		)
	).toContain("User-level model routing, evaluated");
	await press(testSetup, { name: "k" });
	await frameSatisfying(testSetup, (frame) =>
		frame.includes("No providers reported")
	);
	await press(testSetup, { name: "up" });
	await frameSatisfying(testSetup, (frame) =>
		frame.includes("No providers reported")
	);
	await press(testSetup, { name: "r" });
	await frameSatisfying(testSetup, () => gatewayStatusReads >= 2);
	await press(testSetup, { name: "escape" });
	expect(
		await frameSatisfying(testSetup, (frame) => !frame.includes("Esc close"))
	).not.toContain("Gateway");
});

test("Chat composer updates slash suggestions as the user types and accepts a choice", async () => {
	installResponse(
		async () =>
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			})
	);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await act(async () => {
		await testSetup?.mockInput.typeText("/mo");
	});
	await testSetup.flush({ maxPasses: 12 });
	const suggestions = await frameSatisfying(
		testSetup,
		(frame) => frame.includes("Complete") && frame.includes("/model")
	);
	expect(suggestions).toContain("/model");
	await act(async () => {
		testSetup?.mockInput.pressTab();
	});
	await testSetup.flush({ maxPasses: 12 });
	expect(testSetup.captureCharFrame()).toContain("/model");
});

// The sidebar's nav cluster: only rendered while the sidebar shows.
const SIDEBAR_NAV = "Search (Ctrl+K)";

function readLayoutFile(): string {
	return readFileSync(join(configDir ?? "", "cli-layout.json"), "utf8");
}

test("a 60-column terminal hides the sidebar until Ctrl+B, and Alt+B hides it again", async () => {
	stubLocalAppStartup([{ id: "agent-1", name: "Sidebar Agent" }]);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 60,
		height: 20,
	});
	const hidden = await frameSatisfying(testSetup, (frame) =>
		frame.includes("Ask anything")
	);
	await testSetup.flush({ maxPasses: 12 });
	for (const sidebarText of [SIDEBAR_NAV, "Library", "Sidebar Agent", "⌄"]) {
		expect(hidden).not.toContain(sidebarText);
	}

	await emitKey(testSetup, { name: "b", ctrl: true });
	const shown = await frameSatisfying(testSetup, (frame) =>
		frame.includes(SIDEBAR_NAV)
	);
	expect(shown).toContain("Library");
	expect(shown).toContain("127.0.0.1:7980 ⌄");
	expect(JSON.parse(readLayoutFile())).toEqual({ sidebar: "shown" });

	await emitKey(testSetup, { name: "b", option: true });
	const hiddenAgain = await frameSatisfying(
		testSetup,
		(frame) => !frame.includes(SIDEBAR_NAV)
	);
	expect(hiddenAgain).not.toContain("Library");
	expect(JSON.parse(readLayoutFile())).toEqual({ sidebar: "hidden" });
});

test("an explicit sidebar choice survives a restart, even on a wide terminal", async () => {
	stubLocalAppStartup();
	writeFileSync(
		join(configDir ?? "", "cli-layout.json"),
		JSON.stringify({ sidebar: "hidden" })
	);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 30,
	});
	await frameSatisfying(testSetup, (frame) => frame.includes("Ask anything"));
	await testSetup.flush({ maxPasses: 12 });
	expect(testSetup.captureCharFrame()).not.toContain(SIDEBAR_NAV);

	await emitKey(testSetup, { name: "b", ctrl: true });
	await frameSatisfying(testSetup, (frame) => frame.includes(SIDEBAR_NAV));
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});

	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 60,
		height: 20,
	});
	expect(
		await frameSatisfying(testSetup, (frame) => frame.includes(SIDEBAR_NAV))
	).toContain("Library");
});

test("a corrupt layout file falls back to the width-based default", async () => {
	stubLocalAppStartup();
	writeFileSync(join(configDir ?? "", "cli-layout.json"), "{ not json");
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 120,
		height: 30,
	});
	expect(
		await frameSatisfying(testSetup, (frame) => frame.includes(SIDEBAR_NAV))
	).toContain("Library");
});

test("F6 walks the sidebar by keyboard and Enter opens the focused section item", async () => {
	stubLocalAppStartup([{ id: "agent-1", name: "Sidebar Agent" }]);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 40,
	});
	await frameSatisfying(
		testSetup,
		(frame) => frame.includes("Sidebar Agent") && frame.includes("Ask anything")
	);
	await testSetup.flush({ maxPasses: 12 });

	await press(testSetup, { name: "f6" });
	// Focus starts on the node selector. Down walks the mode selector, the
	// seven nav buttons and the AGENTS header to reach the agent row.
	for (let step = 0; step < 10; step += 1) {
		await press(testSetup, { name: "down" });
	}

	await press(testSetup, { name: "return" });
	expect(
		await frameSatisfying(testSetup, (frame) => frame.includes("configured"))
	).toContain("configured");
});

test("Esc leaves sidebar focus and hands typing back to the composer", async () => {
	stubLocalAppStartup();
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 60,
		height: 24,
	});
	await frameSatisfying(testSetup, (frame) => frame.includes("Ask anything"));
	await testSetup.flush({ maxPasses: 12 });

	// Focus mode peeks a hidden sidebar open and owns the keyboard.
	await emitKey(testSetup, { name: "f6" });
	await frameSatisfying(testSetup, (frame) => frame.includes(SIDEBAR_NAV));
	await act(async () => {
		await requireSetup().mockInput.typeText("zz");
	});
	await testSetup.flush({ maxPasses: 12 });
	const focused = testSetup.captureCharFrame();
	expect(focused).toContain(SIDEBAR_NAV);
	expect(focused).not.toContain("› zz");

	await emitKey(testSetup, { name: "escape" });
	await frameSatisfying(testSetup, (frame) => !frame.includes(SIDEBAR_NAV));
	await act(async () => {
		await requireSetup().mockInput.typeText("hi");
	});
	expect(
		await frameSatisfying(testSetup, (frame) => frame.includes("› hi"))
	).toContain("› hi");
	expect(testSetup.captureCharFrame()).not.toContain(SIDEBAR_NAV);
});

test("the palette's Toggle sidebar action shows the sidebar with its shortcut", async () => {
	stubLocalAppStartup();
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 90,
		height: 30,
	});
	await frameSatisfying(testSetup, (frame) => frame.includes("Ask anything"));
	await testSetup.flush({ maxPasses: 12 });
	expect(testSetup.captureCharFrame()).not.toContain(SIDEBAR_NAV);
	await emitKey(testSetup, { name: "k", ctrl: true });
	for (const character of "sidebar") {
		await emitKey(testSetup, { name: character });
	}
	const listed = await frameSatisfying(testSetup, (frame) =>
		frame.includes("Toggle sidebar")
	);
	expect(
		listed.split("\n").find((line) => line.includes("Toggle sidebar"))
	).toContain("Ctrl+B / Alt+B");
	await emitKey(testSetup, { name: "return" });
	expect(
		await frameSatisfying(testSetup, (frame) => frame.includes(SIDEBAR_NAV))
	).toContain("Library");
});

test("Ctrl+B toggles the sidebar without moving the composer caret", async () => {
	stubLocalAppStartup();
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 120,
		height: 30,
	});
	await frameSatisfying(testSetup, (frame) => frame.includes("Ask anything"));
	await testSetup.flush({ maxPasses: 12 });
	await act(async () => {
		await requireSetup().mockInput.typeText("hello");
	});
	await emitKey(testSetup, { name: "b", ctrl: true });
	await frameSatisfying(testSetup, (frame) => !frame.includes(SIDEBAR_NAV));
	await emitKey(testSetup, { name: "b", meta: true });
	await frameSatisfying(testSetup, (frame) => frame.includes(SIDEBAR_NAV));
	await act(async () => {
		await requireSetup().mockInput.typeText("X");
	});
	expect(
		await frameSatisfying(testSetup, (frame) => frame.includes("› helloX"))
	).toContain("› helloX");
});

test("a click in the pane leaves sidebar focus and hands typing back", async () => {
	stubLocalAppStartup();
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 60,
		height: 24,
	});
	await frameSatisfying(testSetup, (frame) => frame.includes("Ask anything"));
	await testSetup.flush({ maxPasses: 12 });
	await emitKey(testSetup, { name: "f6" });
	await frameSatisfying(testSetup, (frame) => frame.includes(SIDEBAR_NAV));

	// A click on the peeked pane (right of the 24-column sidebar) returns focus,
	// so the peeked sidebar folds away again.
	await act(async () => {
		await requireSetup().mockMouse.click(50, 3);
	});
	await frameSatisfying(testSetup, (frame) => !frame.includes(SIDEBAR_NAV));
	await act(async () => {
		await requireSetup().mockInput.typeText("hi");
	});
	expect(
		await frameSatisfying(testSetup, (frame) => frame.includes("› hi"))
	).toContain("› hi");
});
