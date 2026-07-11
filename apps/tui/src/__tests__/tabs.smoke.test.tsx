/* @jsxImportSource @opentui/react */
// Surface-router + workspace contract tests. The desktop-mirrored shell resolves
// a tab's path to a Surface module via the router registry (the single
// registration point), and the WorkspaceContext keybindings drive the panes. This
// replaces the legacy "17 flat tabs" registry test.

import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../App.tsx";
import { listSurfaces, resolveSurface } from "../workspace/router.ts";

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
	const after = testSetup.captureCharFrame();
	expect(after).not.toContain("Error:");
	// Two panes now render, each its own chat surface -> two WorkspaceBars.
	expect(countOccurrences(after, "route")).toBeGreaterThanOrEqual(2);
});

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}
