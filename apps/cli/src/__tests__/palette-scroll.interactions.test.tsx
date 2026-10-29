/* @jsxImportSource @opentui/react */
// Exercise the real shell palette beyond its visible result cap. The command
// index must remain attached to an on-screen result so Enter never activates an
// entry the user cannot see.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;
const realFetch = globalThis.fetch;

const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;
let configDir: string | undefined;
beforeEach(() => {
	configDir = mkdtempSync(path.join(tmpdir(), "ryu-palette-scroll-state-"));
	process.env.RYU_CLI_CONFIG_DIR = configDir;
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath()
	);
});
afterEach(() => {
	testSetup?.renderer.destroy();
	testSetup = null;
	globalThis.fetch = realFetch;
	if (originalConfigDir === undefined) {
		delete process.env.RYU_CLI_CONFIG_DIR;
	} else {
		process.env.RYU_CLI_CONFIG_DIR = originalConfigDir;
	}
	if (configDir) {
		rmSync(configDir, { recursive: true, force: true });
	}
	configDir = undefined;
});

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const EVIDENCE_DIR = path.resolve(
	process.cwd(),
	"../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface KeyOverride {
	ctrl?: boolean;
	name: string;
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

async function frameSatisfying(
	setup: Awaited<ReturnType<typeof testRender>>,
	predicate: (frame: string) => boolean,
	maxFrames = 30
): Promise<string> {
	let frame = setup.captureCharFrame();
	for (let i = 0; i < maxFrames && !predicate(frame); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
		frame = setup.captureCharFrame();
	}
	return frame;
}

test("scrolls the selected command into view and activates the eleventh result", async () => {
	globalThis.fetch = Object.assign(
		() => new Promise<Response>(() => undefined),
		{ preconnect: realFetch.preconnect }
	);
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 34,
	});
	testSetup = setup;
	await act(async () => {
		await setup.renderOnce();
	});
	await press(setup, { name: "k", ctrl: true });
	for (const character of "go to") {
		await press(setup, { name: character });
	}
	await frameSatisfying(setup, (frame) => frame.includes("› Go to Chat"));

	for (let step = 0; step < 10; step += 1) {
		await press(setup, { name: "down" });
	}
	const selected = await frameSatisfying(setup, (frame) =>
		frame.includes("› Go to Monitors")
	);
	expect(selected).toContain("› Go to Monitors");
	await press(setup, { name: "up" });
	expect(
		await frameSatisfying(setup, (frame) => frame.includes("› Go to Timeline"))
	).toContain("› Go to Timeline");
	await press(setup, { name: "down" });
	expect(
		await frameSatisfying(setup, (frame) => frame.includes("› Go to Monitors"))
	).toContain("› Go to Monitors");

	await press(setup, { name: "return" });
	const destination = await frameSatisfying(setup, (frame) =>
		frame.includes("Website monitors on this node")
	);
	expect(destination).toContain("Website monitors on this node");
	expect(destination).not.toContain("Jump to");
	await mkdir(EVIDENCE_DIR, { recursive: true });
	await writeFile(
		path.join(EVIDENCE_DIR, "cli-command-palette-11th-result.frame.txt"),
		`${selected}\n\n${destination}\n`
	);
});
