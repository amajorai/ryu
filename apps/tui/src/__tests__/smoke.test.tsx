/* @jsxImportSource @opentui/react */
// Headless boot + interaction tests for the desktop-mirrored shell. Prove the
// WorkspaceShell mounts under the OpenTUI test renderer, boots on the Chat home
// surface, and that the workspace keyboard model the whole app inherits actually
// routes keys: Ctrl+K opens + filters the command palette and jumps. No Core
// calls resolve offline, so this runs without a node.

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
	// "switch" uniquely isolates the "Switch node" action (space is not a
	// character key in the palette, so filter on a single word).
	for (const ch of "switch") {
		await press(testSetup, { name: ch });
	}
	await press(testSetup, { name: "return" });
	const frame = testSetup.captureCharFrame();
	expect(frame).not.toContain("Error:");
	expect(frame).toContain("Switch node");
	expect(frame).toContain("Enter switch");
});
