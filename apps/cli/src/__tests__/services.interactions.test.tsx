/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { act } from "react";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import { ServicesTab } from "../tabs/services.tsx";
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
					<ServicesTab active />
					<ToastHost />
				</ToastProvider>
			</CoreProvider>
		</ThemeProvider>
	);
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
		throw new Error(`Services render did not match: ${frame}`);
	}
	return frame;
}

test("Services navigate and install, start, stop, restart, uninstall, and run all-service actions", async () => {
	const installed = new Set(["temporal", "spider"]);
	const running = new Set(["temporal"]);
	const actions: string[] = [];
	const names = [
		"temporal",
		"spider",
		"screenpipe",
		"llmfit",
		"qmd",
		"shadow",
		"ghost",
		"llamacpp",
		"ollama",
		"vllm",
		"zeroclaw",
		"openclaw",
		"nanoclaw",
		"picoclaw",
		"nemoclaw",
		"ironclaw",
	];
	const provide = async (
		...args: Parameters<typeof realFetch>
	): ReturnType<typeof realFetch> => {
		const [input, init] = args;
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		if (method === "POST") {
			actions.push(url.pathname);
			const match = url.pathname.match(
				/^\/api\/sidecar\/([^/]+)\/(start|stop|restart)$/
			);
			if (match?.[1] && match[2] === "start") {
				running.add(match[1]);
			} else if (match?.[1] && match[2] === "stop") {
				running.delete(match[1]);
			} else if (match?.[1] && match[2] === "restart") {
				running.add(match[1]);
			} else if (url.pathname === "/api/sidecar/start-all") {
				for (const name of installed) {
					running.add(name);
				}
			} else if (url.pathname === "/api/sidecar/stop-all") {
				running.clear();
			} else if (url.pathname === "/api/setup/temporal/uninstall") {
				installed.delete("temporal");
				running.delete("temporal");
			} else if (url.pathname === "/api/setup/temporal/install") {
				installed.add("temporal");
			}
			return Response.json({ success: true });
		}
		if (url.pathname === "/api/sidecar/status") {
			return Response.json({
				sidecars: names.map((name) => ({ name, running: running.has(name) })),
			});
		}
		if (url.pathname === "/api/setup/list") {
			return Response.json({ installed: [...installed] });
		}
		if (url.pathname === "/api/setup/status") {
			return Response.json({ states: {} });
		}
		return Response.json({});
	};
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});
	setup = await testRender(<Harness />, { width: 120, height: 42 });
	const renderer = setup;
	const initial = await waitFor(
		renderer,
		(frame) => frame.includes("temporal") && frame.includes("running")
	);
	expect(initial).toContain("Services");

	await press(renderer, "j");
	expect(
		renderer
			.captureCharFrame()
			.split("\n")
			.some((row) => row.includes("›") && row.includes("spider"))
	).toBe(true);
	await press(renderer, "k");
	await press(renderer, "down");
	await press(renderer, "up");
	expect(
		renderer
			.captureCharFrame()
			.split("\n")
			.some((row) => row.includes("›") && row.includes("temporal"))
	).toBe(true);

	await press(renderer, "s");
	await waitFor(renderer, () =>
		actions.includes("/api/sidecar/temporal/start")
	);
	await press(renderer, "x");
	await waitFor(
		renderer,
		(frame) =>
			actions.includes("/api/sidecar/temporal/stop") &&
			frame.includes("stopped")
	);
	await press(renderer, "r");
	await waitFor(
		renderer,
		(frame) =>
			actions.includes("/api/sidecar/temporal/restart") &&
			frame.includes("running")
	);
	await press(renderer, "a", true);
	await waitFor(renderer, (frame) => frame.includes("Start all services?"));
	expect(actions).not.toContain("/api/sidecar/start-all");
	await press(renderer, "y");
	await waitFor(renderer, () => actions.includes("/api/sidecar/start-all"));
	await press(renderer, "z", true);
	await waitFor(renderer, (frame) => frame.includes("Stop all services?"));
	expect(actions).not.toContain("/api/sidecar/stop-all");
	await press(renderer, "y");
	await waitFor(renderer, () => actions.includes("/api/sidecar/stop-all"));
	await press(renderer, "d", true);
	await waitFor(renderer, (frame) => frame.includes("Uninstall temporal?"));
	expect(actions).not.toContain("/api/setup/temporal/uninstall");
	await press(renderer, "y");
	await waitFor(
		renderer,
		(frame) =>
			actions.includes("/api/setup/temporal/uninstall") &&
			!frame.includes("running")
	);
	await press(renderer, "d");
	await waitFor(
		renderer,
		(frame) =>
			actions.includes("/api/setup/temporal/install") &&
			frame.includes("temporal")
	);
	await press(renderer, "i");
	expect(
		await waitFor(renderer, (frame) =>
			frame.includes("Dependency setup is not available in the TUI")
		)
	).toContain("Services");
	expect(actions).toEqual([
		"/api/sidecar/temporal/start",
		"/api/sidecar/temporal/stop",
		"/api/sidecar/temporal/restart",
		"/api/sidecar/start-all",
		"/api/sidecar/stop-all",
		"/api/setup/temporal/uninstall",
		"/api/setup/temporal/install",
	]);
});

test("Services confirm prompt: Esc, n and Enter-on-Cancel dismiss bulk and destructive actions without posting", async () => {
	const actions: string[] = [];
	const provide = async (
		...args: Parameters<typeof realFetch>
	): ReturnType<typeof realFetch> => {
		const [input, init] = args;
		const url = new URL(String(input));
		if ((init?.method ?? "GET") === "POST") {
			actions.push(url.pathname);
			return Response.json({ success: true });
		}
		if (url.pathname === "/api/sidecar/status") {
			return Response.json({
				sidecars: [{ name: "temporal", running: true }],
			});
		}
		if (url.pathname === "/api/setup/list") {
			return Response.json({ installed: ["temporal"] });
		}
		if (url.pathname === "/api/setup/status") {
			return Response.json({ states: {} });
		}
		return Response.json({});
	};
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});
	setup = await testRender(<Harness />, { width: 120, height: 42 });
	const renderer = setup;
	await waitFor(
		renderer,
		(frame) => frame.includes("temporal") && frame.includes("running")
	);

	await press(renderer, "z", true);
	await waitFor(renderer, (frame) => frame.includes("Stop all services?"));
	await press(renderer, "escape");
	await waitFor(renderer, (frame) => !frame.includes("Stop all services?"));

	await press(renderer, "d", true);
	await waitFor(renderer, (frame) => frame.includes("Uninstall temporal?"));
	// Keys meant for the tab (r restart, s start) are swallowed while it is open.
	await press(renderer, "r");
	await press(renderer, "s");
	await press(renderer, "n");
	await waitFor(renderer, (frame) => !frame.includes("Uninstall temporal?"));

	await press(renderer, "a", true);
	await waitFor(renderer, (frame) => frame.includes("Start all services?"));
	// Cancel is focused by default, so Enter is the safe choice.
	await press(renderer, "return");
	await waitFor(renderer, (frame) => !frame.includes("Start all services?"));

	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(actions).toEqual([]);
});
