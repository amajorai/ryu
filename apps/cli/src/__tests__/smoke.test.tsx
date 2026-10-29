/* @jsxImportSource @opentui/react */
// Headless boot + interaction tests for the desktop-mirrored shell. Prove the
// WorkspaceShell mounts under the OpenTUI test renderer, boots on the Chat home
// surface, and that the workspace keyboard model the whole app inherits actually
// routes keys: Ctrl+K opens + filters the command palette and jumps. No Core
// calls resolve offline, so this runs without a node.

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
	});
	await setup.renderOnce();
}

test("shell mounts on the chat home surface without an error banner", async () => {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 120,
		height: 34,
	});
	await testSetup.renderOnce();
	const frame = testSetup.captureCharFrame();

	expect(frame).not.toContain("Error:");
	// TabStrip brand + the home chat tab + its empty-state header render.
	expect(frame).toContain("Ryu");
	expect(frame).toContain("New chat");
	expect(frame).toContain("Ask anything");
});

test("Ctrl+K palette filters navigation destinations", async () => {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 120,
		height: 34,
	});
	await testSetup.renderOnce();

	await press(testSetup, { name: "k", ctrl: true });
	expect(testSetup.captureCharFrame()).toContain("Go to Chat");

	// Type "agents" -> only "Go to Agents" survives the fuzzy filter.
	for (const ch of "agents") {
		await press(testSetup, { name: ch });
	}
	const filtered = testSetup.captureCharFrame();
	expect(filtered).toContain("Go to Agents");
	expect(filtered).not.toContain("Go to Chat");
});

test("palette Switch node action opens the node picker", async () => {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 120,
		height: 34,
	});
	await testSetup.renderOnce();

	await press(testSetup, { name: "k", ctrl: true });
	// "switchnode" narrows past the "Switch between Bot, Agent and OS" action to
	// the "Switch node" action (fuzzy match on the full label).
	for (const ch of "switchnode") {
		await press(testSetup, { name: ch });
	}
	await press(testSetup, { name: "return" });
	const frame = testSetup.captureCharFrame();
	expect(frame).not.toContain("Error:");
	expect(frame).toContain("Switch node");
	expect(frame).toContain("Enter switch");
});
