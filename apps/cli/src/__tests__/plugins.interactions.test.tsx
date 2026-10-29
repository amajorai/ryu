/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { act } from "react";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import { PluginsTab } from "../tabs/plugins.tsx";
import { confirmKeyAction } from "../ui/ConfirmPrompt.tsx";
import { ToastHost, ToastProvider } from "../ui/toast.tsx";
import { testRender } from "./cli-test-render.ts";

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
let setup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(async () => {
	globalThis.fetch = realFetch;
	await act(async () => {
		setup?.renderer.destroy();
		await Promise.resolve();
	});
	setup = null;
});

function Harness() {
	return (
		<ThemeProvider reducedMotion>
			<CoreProvider initial={LOCAL_TARGET}>
				<ToastProvider>
					<PluginsTab active />
					<ToastHost />
				</ToastProvider>
			</CoreProvider>
		</ThemeProvider>
	);
}

function manifest(id: string, name: string) {
	return {
		built_in: false,
		enabled: true,
		id,
		installed: true,
		installed_version: "1.0.0",
		local_only: false,
		name,
		permission_grants: [],
		runnables: [],
		sidecar_name: null,
		version: "1.0.0",
		windows_first: false,
	};
}

/** Serve `/api/plugins` with one installed plugin and record every POST path. The
 *  first plain uninstall is refused as blocked by a dependent when `blocked`. */
function installFetch(posts: string[], blocked = false) {
	const provide = async (
		...args: Parameters<typeof realFetch>
	): ReturnType<typeof realFetch> => {
		const [input, init] = args;
		const url = new URL(String(input));
		if ((init?.method ?? "GET") === "POST") {
			posts.push(`${url.pathname}${url.search}`);
			if (blocked && url.search === "") {
				return Response.json(
					{
						dependency_error: {
							code: "blocked_by_dependents",
							plugin: "com.example.base",
							dependents: ["com.example.addon"],
						},
					},
					{ status: 409 }
				);
			}
			return Response.json({ success: true, removed: "com.example.base" });
		}
		if (url.pathname === "/api/plugins") {
			return Response.json({
				apps: [manifest("com.example.base", "Base plugin")],
			});
		}
		return Response.json({});
	};
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});
}

async function press(
	renderer: Awaited<ReturnType<typeof testRender>>,
	name: string,
	shift = false
): Promise<void> {
	await act(async () => {
		renderer.renderer.keyInput.emit(
			"keypress",
			new KeyEvent({
				name,
				sequence: name.length === 1 ? name : "",
				shift,
				ctrl: false,
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
	});
	await renderer.renderOnce();
}

async function waitFor(
	renderer: Awaited<ReturnType<typeof testRender>>,
	predicate: (frame: string) => boolean
): Promise<string> {
	let frame = renderer.captureCharFrame();
	for (let pass = 0; pass < 30 && !predicate(frame); pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await renderer.renderOnce();
		frame = renderer.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Plugins render did not match: ${frame}`);
	}
	return frame;
}

const UNINSTALL_PATH = "/api/plugins/com.example.base/uninstall";

test("confirmKeyAction maps y/n/Esc/Enter/Tab and ignores modified chords", () => {
	const plain = { ctrl: false, meta: false, option: false };
	expect(confirmKeyAction({ ...plain, name: "y" }, "cancel")).toBe("confirm");
	expect(confirmKeyAction({ ...plain, name: "n" }, "confirm")).toBe("cancel");
	expect(confirmKeyAction({ ...plain, name: "escape" }, "confirm")).toBe(
		"cancel"
	);
	expect(confirmKeyAction({ ...plain, name: "return" }, "cancel")).toBe(
		"cancel"
	);
	expect(confirmKeyAction({ ...plain, name: "return" }, "confirm")).toBe(
		"confirm"
	);
	expect(confirmKeyAction({ ...plain, name: "tab" }, "cancel")).toBe("switch");
	expect(confirmKeyAction({ ...plain, name: "r" }, "cancel")).toBeNull();
	expect(confirmKeyAction({ ...plain, ctrl: true, name: "y" }, "cancel")).toBe(
		null
	);
});

test("Plugins Shift+D asks for confirmation and only uninstalls after y", async () => {
	const posts: string[] = [];
	installFetch(posts);
	setup = await testRender(<Harness />, { width: 120, height: 30 });
	const renderer = setup;
	await waitFor(renderer, (frame) => frame.includes("Base plugin"));

	await press(renderer, "d", true);
	const prompt = await waitFor(renderer, (frame) =>
		frame.includes("Uninstall Base plugin?")
	);
	expect(prompt).toContain("[ Cancel ]");
	expect(prompt).toContain("[ Uninstall ]");
	expect(posts).toEqual([]);

	await press(renderer, "n");
	await waitFor(renderer, (frame) => !frame.includes("Uninstall Base plugin?"));
	await press(renderer, "D");
	await waitFor(renderer, (frame) => frame.includes("Uninstall Base plugin?"));
	await press(renderer, "escape");
	await waitFor(renderer, (frame) => !frame.includes("Uninstall Base plugin?"));
	expect(posts).toEqual([]);

	await press(renderer, "d", true);
	await waitFor(renderer, (frame) => frame.includes("Uninstall Base plugin?"));
	// Tab moves focus to the destructive button; Enter then confirms.
	await press(renderer, "tab");
	await press(renderer, "return");
	await waitFor(renderer, () => posts.includes(UNINSTALL_PATH));

	await press(renderer, "d", true);
	await waitFor(renderer, (frame) => frame.includes("Uninstall Base plugin?"));
	await press(renderer, "y");
	await waitFor(renderer, () => posts.length === 2);
	expect(posts).toEqual([UNINSTALL_PATH, UNINSTALL_PATH]);
});

test("Plugins C names the blocking dependents and cascades only after y", async () => {
	const posts: string[] = [];
	installFetch(posts, true);
	setup = await testRender(<Harness />, { width: 140, height: 30 });
	const renderer = setup;
	await waitFor(renderer, (frame) => frame.includes("Base plugin"));

	await press(renderer, "d", true);
	await waitFor(renderer, (frame) => frame.includes("Uninstall Base plugin?"));
	await press(renderer, "y");
	await waitFor(renderer, () => posts.includes(UNINSTALL_PATH));

	await press(renderer, "c", true);
	const prompt = await waitFor(renderer, (frame) =>
		frame.includes("Uninstall Base plugin and its dependents?")
	);
	expect(prompt).toContain("com.example.addon");
	expect(posts).toEqual([UNINSTALL_PATH]);

	await press(renderer, "y");
	await waitFor(renderer, () => posts.length === 2);
	expect(posts).toEqual([UNINSTALL_PATH, `${UNINSTALL_PATH}?cascade=true`]);
});
