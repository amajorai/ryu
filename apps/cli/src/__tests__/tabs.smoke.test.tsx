/* @jsxImportSource @opentui/react */
// Surface-router + workspace contract tests. The desktop-mirrored shell resolves
// a tab's path to a Surface module via the router registry (the single
// registration point), and the WorkspaceContext keybindings drive the panes. This
// replaces the legacy "17 flat tabs" registry test.

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
import { listSurfaces, resolveSurface } from "../workspace/router.ts";
import { testRender } from "./cli-test-render.ts";

const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;
let configDir: string | undefined;
beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "ryu-contributed-command-state-"));
	process.env.RYU_CLI_CONFIG_DIR = configDir;
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath()
	);
});

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(() => {
	testSetup?.renderer.destroy();
	testSetup = null;
	if (originalConfigDir === undefined) {
		delete process.env.RYU_CLI_CONFIG_DIR;
	} else {
		process.env.RYU_CLI_CONFIG_DIR = originalConfigDir;
	}
	if (configDir) {
		rmSync(configDir, { recursive: true, force: true });
		configDir = undefined;
	}
});

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };

interface KeyOverride {
	ctrl?: boolean;
	name: string;
	option?: boolean;
	shift?: boolean;
}

async function press(
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
				meta: false,
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

async function frameSatisfying(
	setup: Awaited<ReturnType<typeof testRender>>,
	predicate: (frame: string) => boolean,
	maxFrames = 30
): Promise<string> {
	let frame = setup.captureCharFrame();
	for (let i = 0; i < maxFrames && !predicate(frame); i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
		frame = setup.captureCharFrame();
	}
	return frame;
}

test("router seeds the chat surface as the home surface", () => {
	const chat = resolveSurface("/chat");
	expect(chat?.id).toBe("chat");
	expect(chat?.match("/chat")).toBe(true);
	expect(resolveSurface("/nope")).toBeUndefined();
	expect(listSurfaces().some((surface) => surface.id === "chat")).toBe(true);
});

test("Ctrl+Alt+S splits the workspace into two chat panes", async () => {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 34,
	});
	await testSetup.renderOnce();

	// One pane before the split: the chat WorkspaceBar's "route" label appears once.
	const before = testSetup.captureCharFrame();
	expect(countOccurrences(before, "route")).toBe(1);

	await press(testSetup, { name: "s", ctrl: true, option: true });
	const after = await frameSatisfying(
		testSetup,
		(frame) => countOccurrences(frame, "route") >= 2
	);
	expect(after).not.toContain("Error:");
	// Two panes now render, each its own chat surface -> two WorkspaceBars.
	expect(countOccurrences(after, "route")).toBeGreaterThanOrEqual(2);
});

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/** Frame rows that carry a "n:title" tab chip. */
function tabLabelRows(frame: string): string[] {
	return frame.split("\n").filter((line) => /\b\d:New chat/.test(line));
}

async function openTenTabs(
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<string> {
	for (let opened = 1; opened < 10; opened++) {
		await press(setup, { name: "t", ctrl: true });
	}
	return frameSatisfying(setup, (frame) =>
		(frame.split("\n")[0] ?? "").includes("10:New chat ×")
	);
}

test("ten tabs at 80 columns stay on one strip row with overflow markers", async () => {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 30,
	});
	await testSetup.renderOnce();

	const frame = await openTenTabs(testSetup);
	const rows = frame.split("\n");
	const stripRows = tabLabelRows(frame);
	expect(stripRows).toHaveLength(1);
	expect(rows[0]).toBe(stripRows[0]);
	// The newest (active) tab is kept in view; the older ones collapse to "‹ +N".
	expect(rows[0]).toMatch(/‹ \+\d+/);
	expect(rows[0]).toContain("10:New chat ×");
	// No chip title is split across rows (" New" here, "chat" on the next row).
	expect(rows[1]).not.toMatch(/^\s*chat\b/);
});

test("Alt+2 jumps to the second tab without typing into the composer", async () => {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 30,
	});
	await testSetup.renderOnce();
	await openTenTabs(testSetup);

	await press(testSetup, { name: "2", option: true });
	const frame = await frameSatisfying(testSetup, (candidate) =>
		(candidate.split("\n")[0] ?? "").includes("2:New chat ×")
	);
	const strip = frame.split("\n")[0] ?? "";
	// The close glyph marks the active chip; only the second tab carries it.
	expect(strip).toContain("2:New chat ×");
	expect(strip).not.toContain("10:New chat ×");
	expect(strip).toMatch(/\+\d+ ›/);
});

test("Alt+digit leaves the departing tab's composer draft empty", async () => {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 30,
	});
	await testSetup.renderOnce();
	await press(testSetup, { name: "t", ctrl: true });
	await frameSatisfying(testSetup, (frame) =>
		(frame.split("\n")[0] ?? "").includes("2:New chat ×")
	);

	// Tab 2's composer owns the keyboard when Alt+1 arrives; jump back to it.
	await press(testSetup, { name: "1", option: true });
	await frameSatisfying(testSetup, (frame) =>
		(frame.split("\n")[0] ?? "").includes("1:New chat ×")
	);
	await press(testSetup, { name: "2", option: true });
	const frame = await frameSatisfying(testSetup, (candidate) =>
		(candidate.split("\n")[0] ?? "").includes("2:New chat ×")
	);
	// An empty draft still shows the composer placeholder.
	expect(frame).toContain("› Message");
});

test("clicking a tab chip focuses it and middle-clicking closes it", async () => {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 120,
		height: 30,
	});
	await testSetup.renderOnce();
	await press(testSetup, { name: "t", ctrl: true });
	const two = await frameSatisfying(testSetup, (frame) =>
		(frame.split("\n")[0] ?? "").includes("2:New chat ×")
	);
	const strip = two.split("\n")[0] ?? "";

	await testSetup.mockMouse.click(strip.indexOf("1:New chat") + 2, 0);
	const focused = await frameSatisfying(testSetup, (frame) =>
		(frame.split("\n")[0] ?? "").includes("1:New chat ×")
	);
	expect(focused.split("\n")[0]).toContain("1:New chat ×");
	expect(focused.split("\n")[0]).not.toContain("2:New chat ×");

	const after = focused.split("\n")[0] ?? "";
	await testSetup.mockMouse.click(after.indexOf("2:New chat") + 2, 0, 1);
	const closed = await frameSatisfying(
		testSetup,
		(frame) => !(frame.split("\n")[0] ?? "").includes("2:New chat")
	);
	expect(closed.split("\n")[0]).not.toContain("2:New chat");
	expect(closed.split("\n")[0]).toContain("1:New chat ×");
});

test("a split lends the short pane's spare strip columns to the crowded pane", async () => {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 24,
	});
	await testSetup.renderOnce();
	await openTenTabs(testSetup);
	await press(testSetup, { name: "s", ctrl: true, option: true });
	const frame = await frameSatisfying(testSetup, (candidate) =>
		(candidate.split("\n")[0] ?? "").includes("│")
	);
	const strip = frame.split("\n")[0] ?? "";
	const [left = "", right = ""] = strip.split("│");
	// The new pane holds one tab; the ten-tab pane shows more than one chip
	// beside its active one instead of an even half-row.
	expect(right).toContain("1:New chat ×");
	expect(left.match(/\d+:New chat/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
	expect(Bun.stringWidth(strip.trimEnd())).toBeLessThanOrEqual(80);
});

test("clicking an overflow marker reveals the nearest hidden tab", async () => {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 24,
	});
	await testSetup.renderOnce();
	const frame = await openTenTabs(testSetup);
	const strip = frame.split("\n")[0] ?? "";
	const hidden = Number(/‹ \+(\d+)/u.exec(strip)?.[1]);
	expect(hidden).toBeGreaterThan(0);

	await act(async () => {
		await testSetup?.mockMouse.click(strip.indexOf("‹"), 0);
	});
	const revealed = await frameSatisfying(testSetup, (candidate) =>
		(candidate.split("\n")[0] ?? "").includes(`${hidden}:New chat ×`)
	);
	expect(revealed.split("\n")[0]).toContain(`${hidden}:New chat ×`);
});

test("a ten-tab split at 40 columns never spills a chip into the next pane", async () => {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 40,
		height: 12,
	});
	await testSetup.renderOnce();
	for (let opened = 1; opened < 10; opened++) {
		await press(testSetup, { name: "t", ctrl: true });
	}
	await press(testSetup, { name: "s", ctrl: true, option: true });
	const frame = await frameSatisfying(testSetup, (candidate) =>
		(candidate.split("\n")[0] ?? "").includes("│")
	);
	const strip = frame.split("\n")[0] ?? "";
	// The lone left chip is cut with "…" so the right pane's chip stays whole.
	expect(strip).toContain("…");
	expect(strip.split("│")[1]).toContain("1:New chat ×");
});
