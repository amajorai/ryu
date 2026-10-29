/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { act } from "react";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import { AppsTab } from "../tabs/apps.tsx";
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
					<AppsTab active />
					<ToastHost />
				</ToastProvider>
			</CoreProvider>
		</ThemeProvider>
	);
}

function installFetch(posts: string[]) {
	const provide = async (
		...args: Parameters<typeof realFetch>
	): ReturnType<typeof realFetch> => {
		const [input, init] = args;
		const url = new URL(String(input));
		if ((init?.method ?? "GET") === "POST") {
			posts.push(url.pathname);
			return Response.json({ success: true });
		}
		if (url.pathname === "/api/catalog") {
			return Response.json({
				sidecars: [
					{
						name: "ollama",
						category: "provider",
						install_state: "installed",
						installed_version: "1.0",
						latest_version: "1.0",
					},
				],
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
		throw new Error(`Apps render did not match: ${frame}`);
	}
	return frame;
}

const UNINSTALL_PATH = "/api/setup/ollama/uninstall";

test("Apps Shift+D asks for confirmation and only uninstalls after y", async () => {
	const posts: string[] = [];
	installFetch(posts);
	setup = await testRender(<Harness />, { width: 120, height: 30 });
	const renderer = setup;
	await waitFor(renderer, (frame) => frame.includes("ollama"));

	await press(renderer, "d", true);
	const prompt = await waitFor(renderer, (frame) =>
		frame.includes("Uninstall ollama?")
	);
	expect(prompt).toContain("[ Cancel ]");
	expect(prompt).toContain("[ Uninstall ]");
	expect(posts).toEqual([]);

	// i (install) belongs to the tab and is ignored while the prompt is open.
	await press(renderer, "i");
	await press(renderer, "escape");
	await waitFor(renderer, (frame) => !frame.includes("Uninstall ollama?"));
	await press(renderer, "D");
	await waitFor(renderer, (frame) => frame.includes("Uninstall ollama?"));
	await press(renderer, "return");
	await waitFor(renderer, (frame) => !frame.includes("Uninstall ollama?"));
	expect(posts).toEqual([]);

	await press(renderer, "d", true);
	await waitFor(renderer, (frame) => frame.includes("Uninstall ollama?"));
	await press(renderer, "y");
	await waitFor(renderer, () => posts.includes(UNINSTALL_PATH));
	expect(posts).toEqual([UNINSTALL_PATH]);
});
