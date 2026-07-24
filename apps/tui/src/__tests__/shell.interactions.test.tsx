/* @jsxImportSource @opentui/react */
// Workspace keybinding tests: the tab lifecycle (Ctrl+T new, Ctrl+W close,
// Ctrl+Shift+T restore) drives the TabStrip, and the palette exposes the bridged
// "New chat" action. These drive real key events through the OpenTUI test
// renderer and assert on the captured character frame.

import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../App.tsx";

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(() => {
	testSetup?.renderer.destroy();
	testSetup = null;
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
	const keyInput = (
		setup.renderer as unknown as {
			keyInput: { emit: (event: string, data: unknown) => void };
		}
	).keyInput;
	keyInput.emit("keypress", {
		name: key.name,
		sequence: key.name.length === 1 ? key.name : "",
		ctrl: key.ctrl ?? false,
		shift: key.shift ?? false,
		meta: false,
		option: key.option ?? false,
		eventType: "press",
		repeated: false,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	await setup.renderOnce();
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
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
		frame = setup.captureCharFrame();
	}
	return frame;
}

// Raw count of the "New chat" tab-title glyph across the whole frame. The sidebar
// contributes a constant baseline, so the test asserts on relative deltas: each
// open chat tab adds one occurrence in the TabStrip.
function countNewChat(frame: string): number {
	return frame.split("New chat").length - 1;
}

test("Ctrl+T opens a tab, Ctrl+W closes it, Ctrl+Shift+T restores it", async () => {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 34,
	});
	await testSetup.renderOnce();
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

test("palette exposes the New chat action", async () => {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 34,
	});
	await testSetup.renderOnce();

	await press(testSetup, { name: "k", ctrl: true });
	for (const ch of "new") {
		await press(testSetup, { name: ch });
	}
	const frame = await frameSatisfying(testSetup, (f) => f.includes("New chat"));
	expect(frame).not.toContain("Error:");
	expect(frame).toContain("New chat");
});
