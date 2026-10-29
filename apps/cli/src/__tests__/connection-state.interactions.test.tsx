/* @jsxImportSource @opentui/react */
// Guided Core-unreachable state: with every request refused, Home's status card
// becomes the ConnectionCard (node named, s/^N/r actions, auto-retry line) and an
// empty Chat shows it as a banner above "Ask anything". No raw socket code or zod
// JSON dump may reach a frame, and ErrorView only offers "r" when the surface
// binds it.

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
import { ErrorView, errorViewHint, RETRY_HINT } from "../ui/ErrorView.tsx";
import { testRender } from "./cli-test-render.ts";

type RenderedApp = Awaited<ReturnType<typeof testRender>>;

const TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;
const originalNoBootstrap = process.env.RYU_TUI_NO_BOOTSTRAP;
let configDir: string | undefined;
let setup: RenderedApp | null = null;

function refused(input: Parameters<typeof fetch>[0]): Error {
	return Object.assign(
		new Error("Unable to connect. Is the computer able to access the url?"),
		{
			code: "ConnectionRefused",
			errno: 0,
			path: String(input instanceof Request ? input.url : input),
		}
	);
}

function installFetch(
	respond: (input: Parameters<typeof fetch>[0]) => Promise<Response> | Response
): void {
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof fetch>[0]) => await respond(input),
		{ preconnect: realFetch.preconnect }
	);
}

function startOn(surface: "/home" | "/chat"): void {
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", surface),
		productModePreferencePath()
	);
}

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "ryu-connection-state-"));
	process.env.RYU_CLI_CONFIG_DIR = configDir;
	// Bootstrap stays allowed so Home offers "s start Core"; no test presses s on
	// Home, so nothing is spawned or downloaded.
	delete process.env.RYU_TUI_NO_BOOTSTRAP;
});

afterEach(() => {
	setup?.renderer.destroy();
	setup = null;
	globalThis.fetch = realFetch;
	if (originalConfigDir === undefined) {
		delete process.env.RYU_CLI_CONFIG_DIR;
	} else {
		process.env.RYU_CLI_CONFIG_DIR = originalConfigDir;
	}
	if (originalNoBootstrap === undefined) {
		delete process.env.RYU_TUI_NO_BOOTSTRAP;
	} else {
		process.env.RYU_TUI_NO_BOOTSTRAP = originalNoBootstrap;
	}
	if (configDir) {
		rmSync(configDir, { force: true, recursive: true });
		configDir = undefined;
	}
});

async function renderApp(
	element = <App target={TARGET} />,
	size = { height: 34, width: 120 }
): Promise<RenderedApp> {
	const holder: { rendered: RenderedApp | null } = { rendered: null };
	await act(async () => {
		const next = await testRender(element, size);
		holder.rendered = next;
		await next.renderOnce();
	});
	const { rendered } = holder;
	if (!rendered) {
		throw new Error("OpenTUI did not render");
	}
	setup = rendered;
	return rendered;
}

async function waitForFrame(
	renderer: RenderedApp,
	predicate: (frame: string) => boolean
): Promise<string> {
	let frame = renderer.captureCharFrame();
	await act(async () => {
		for (let pass = 0; pass < 60 && !predicate(frame); pass += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			await renderer.renderOnce();
			frame = renderer.captureCharFrame();
		}
	});
	if (!predicate(frame)) {
		throw new Error(`frame did not match:\n${frame}`);
	}
	return frame;
}

async function press(renderer: RenderedApp, name: string): Promise<void> {
	await act(async () => {
		renderer.renderer.keyInput.emit(
			"keypress",
			new KeyEvent({
				name,
				sequence: name,
				ctrl: false,
				shift: false,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: name,
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await renderer.renderOnce();
}

const RAW_ERROR_MARKERS = [
	"ECONNREFUSED",
	"ConnectionRefused",
	"Unable to connect",
	"[{",
];

function rawErrorsIn(frame: string): string[] {
	return RAW_ERROR_MARKERS.filter((marker) => frame.includes(marker));
}

test("Home shows the guided connection card when Core refuses connections", async () => {
	startOn("/home");
	installFetch((input) => {
		throw refused(input);
	});
	const renderer = await renderApp();
	const frame = await waitForFrame(
		renderer,
		(next) =>
			next.includes("isn't running at 127.0.0.1:7980") &&
			next.includes("retrying in")
	);
	expect(frame).toContain("isn't running at 127.0.0.1:7980");
	expect(frame).toContain("s start Core");
	expect(frame).toContain("^N switch node");
	expect(frame).toContain("r retry");
	expect(frame).not.toContain("Core unreachable");
	expect(rawErrorsIn(frame)).toEqual([]);
});

test("Home hides s start Core when bootstrap is disabled, and recovers on r", async () => {
	process.env.RYU_TUI_NO_BOOTSTRAP = "1";
	startOn("/home");
	let coreUp = false;
	installFetch((input) => {
		if (!coreUp) {
			throw refused(input);
		}
		const url = new URL(String(input instanceof Request ? input.url : input));
		if (url.pathname === "/api/system/status") {
			return Response.json({
				engine: { active: "llama", running: true },
				gateway: { reachable: true },
				sidecars: [],
			});
		}
		return Response.json({});
	});
	const renderer = await renderApp();
	const down = await waitForFrame(renderer, (next) =>
		next.includes("isn't running at 127.0.0.1:7980")
	);
	expect(down).not.toContain("s start Core");
	expect(down).toContain("r retry");

	coreUp = true;
	await press(renderer, "r");
	const recovered = await waitForFrame(
		renderer,
		(next) => !next.includes("isn't running") && next.includes("Gateway")
	);
	expect(recovered).toContain("Engine");
	expect(rawErrorsIn(recovered)).toEqual([]);
});

test("an empty Chat shows the connection banner above Ask anything", async () => {
	startOn("/chat");
	installFetch((input) => {
		throw refused(input);
	});
	const renderer = await renderApp();
	const frame = await waitForFrame(renderer, (next) =>
		next.includes("isn't running at 127.0.0.1:7980")
	);
	expect(frame).toContain("Ask anything");
	expect(frame).toContain("^N switch node");
	// The composer owns printable keys in Chat, so s/r are not offered there.
	expect(frame).not.toContain("r retry");
	expect(frame).toContain("open Home to start Core");
	expect(rawErrorsIn(frame)).toEqual([]);

	// Typing still reaches the composer: "s" is not swallowed by the banner.
	await press(renderer, "s");
	const typed = await waitForFrame(renderer, (next) => next.includes("› s"));
	expect(typed).toContain("› s");
});

test("a short 80x16 terminal keeps the card intact instead of overlapping rows", async () => {
	startOn("/chat");
	installFetch((input) => {
		throw refused(input);
	});
	const chat = await renderApp(<App target={TARGET} />, {
		height: 16,
		width: 80,
	});
	const chatFrame = await waitForFrame(
		chat,
		(next) =>
			next.includes("isn't running at 127.0.0.1:7980") &&
			next.includes("retrying in")
	);
	expect(chatFrame).toContain("^N switch node  open Home to start Core");
	expect(chatFrame).toContain("Ask anything");
	chat.renderer.destroy();
	setup = null;

	startOn("/home");
	const home = await renderApp(<App target={TARGET} />, {
		height: 16,
		width: 80,
	});
	const homeFrame = await waitForFrame(
		home,
		(next) =>
			next.includes("isn't running at 127.0.0.1:7980") &&
			next.includes("retrying in")
	);
	expect(homeFrame).toContain("s start Core  ^N switch node  r retry");
	// Quick actions clip below the card rather than drawing over each other.
	expect(homeFrame).toContain("› New chat Talk to an agent");
	expect(rawErrorsIn(homeFrame)).toEqual([]);
});

test("Chat shows no banner while Core is healthy", async () => {
	startOn("/chat");
	installFetch(() => Response.json({}));
	const renderer = await renderApp();
	const frame = await waitForFrame(renderer, (next) =>
		next.includes("Ask anything")
	);
	// Give the health check time to settle "up".
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	await renderer.renderOnce();
	expect(renderer.captureCharFrame()).not.toContain("isn't running");
	expect(frame).not.toContain("isn't running");
});

test("ErrorView shows the retry hint only when the surface binds r", async () => {
	expect(errorViewHint({})).toBeNull();
	expect(errorViewHint({ onRetry: true })).toBe(RETRY_HINT);
	expect(errorViewHint({ hint: "Retrying automatically…" })).toBe(
		"Retrying automatically…"
	);

	const plain = await renderApp(<ErrorView message="agents failed" />);
	const withoutRetry = await waitForFrame(plain, (next) =>
		next.includes("agents failed")
	);
	expect(withoutRetry).toContain("agents failed");
	expect(withoutRetry).not.toContain(RETRY_HINT);
	plain.renderer.destroy();
	setup = null;

	const retry = await renderApp(<ErrorView message="agents failed" onRetry />);
	const withRetry = await waitForFrame(retry, (next) =>
		next.includes("agents failed")
	);
	expect(withRetry).toContain(RETRY_HINT);
});
