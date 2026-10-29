/* @jsxImportSource @opentui/react */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { act } from "react";
import { z } from "zod";
import { App } from "../App.tsx";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import { renderTerminalSvg } from "../proof/render-terminal-svg.ts";
import { testRender } from "./cli-test-render.ts";

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const PREF_KEYS = [
	"auto-recall-enabled",
	"auto-recall-top-k",
	"context.max-tokens",
	"context.max-output-tokens",
	"context.auto-compact",
	"skills-disclosure",
	"tools.active_ranker",
] as const;
const realFetch = globalThis.fetch;
type Setup = Awaited<ReturnType<typeof testRender>>;
let testSetup: Setup | null = null;

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let isolatedHome: string | null = null;
beforeEach(() => {
	isolatedHome = mkdtempSync(join(tmpdir(), "ryu-cli-interactions-"));
	process.env.HOME = isolatedHome;
	delete process.env.USERPROFILE;
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath(isolatedHome)
	);
});
afterEach(async () => {
	globalThis.fetch = realFetch;
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = originalUserProfile;
	}
	if (isolatedHome) {
		rmSync(isolatedHome, { recursive: true, force: true });
	}
	isolatedHome = null;
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
});

interface RequestRecord {
	body?: { value?: string };
	method: string;
	path: string;
}

interface CoreOptions {
	failFirstAutoRecallRead?: boolean;
	failFirstAutoRecallWrite?: boolean;
	initial?: Record<string, string>;
}

function installMemoryCore(options: CoreOptions = {}) {
	const stored = new Map(Object.entries(options.initial ?? {}));
	const requests: RequestRecord[] = [];
	let autoRecallReads = 0;
	let autoRecallWrites = 0;
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const method = init?.method ?? "GET";
			if (url.pathname === "/api/meetings") {
				if (
					url.origin !== LOCAL_TARGET.url ||
					url.search !== "" ||
					method !== "GET" ||
					init?.body !== undefined
				) {
					throw new Error(
						`Unexpected canonical Core request: ${method} ${url}`
					);
				}
				requests.push({ method, path: url.pathname });
				return Response.json({
					meetings: [
						{
							id: "memory-navigation-meeting",
							title: "Canonical meeting recovery review",
							status: "done",
							source: "manual",
							participants: ["Reviewer"],
							created_at: "2026-10-05T00:00:00Z",
							started_at: "2026-10-05T00:00:00Z",
							updated_at: "2026-10-05T00:00:00Z",
						},
					],
				});
			}
			if (url.pathname === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			if (url.pathname.startsWith("/api/preferences/")) {
				const key = decodeURIComponent(
					url.pathname.slice("/api/preferences/".length)
				);
				if (PREF_KEYS.some((preference) => preference === key)) {
					const parsedBody = init?.body
						? z
								.object({ value: z.string().optional() })
								.safeParse(JSON.parse(String(init.body)))
						: undefined;
					const body = parsedBody?.success ? parsedBody.data : undefined;
					requests.push({ body, method, path: url.pathname });
					if (key === "auto-recall-enabled" && method === "GET") {
						autoRecallReads += 1;
						if (options.failFirstAutoRecallRead && autoRecallReads === 1) {
							return Response.json(
								{ error: "temporary preference read failure" },
								{ status: 503 }
							);
						}
					}
					if (key === "auto-recall-enabled" && method === "PUT") {
						autoRecallWrites += 1;
						if (options.failFirstAutoRecallWrite && autoRecallWrites === 1) {
							return Response.json(
								{ error: "temporary preference write failure" },
								{ status: 503 }
							);
						}
					}
					if (method === "PUT") {
						if (body?.value === undefined) {
							return Response.json(
								{ error: "value must be a string" },
								{ status: 400 }
							);
						}
						stored.set(key, body.value);
						return Response.json({ key, value: body.value });
					}
					return Response.json({ key, value: stored.get(key) ?? null });
				}
			}
			return Response.json({});
		},
		{ preconnect: realFetch.preconnect }
	);
	return { requests, stored };
}

interface KeyInput {
	ctrl?: boolean;
	name: string;
}

async function press(setup: Setup, key: KeyInput): Promise<void> {
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

async function waitForFrame(
	setup: Setup,
	predicate: (frame: string) => boolean,
	maxFrames = 100
): Promise<string> {
	let frame = setup.captureCharFrame();
	for (let pass = 0; pass < maxFrames && !predicate(frame); pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
		frame = setup.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Memory settings render did not match: ${frame}`);
	}
	return frame;
}

async function renderApp(): Promise<Setup> {
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 180,
		height: 48,
	});
	testSetup = setup;
	await setup.renderOnce();
	return setup;
}

async function openMemory(setup: Setup): Promise<string> {
	await waitForFrame(setup, (frame) => frame.includes("Message"));
	await press(setup, { name: "k", ctrl: true });
	for (const character of "settings") {
		await press(setup, { name: character });
	}
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Node connection is managed")
	);
	// General → Memory is five panel steps now that Island is not a CLI panel.
	for (let index = 0; index < 5; index += 1) {
		await press(setup, { name: "j" });
	}
	return waitForFrame(
		setup,
		(frame) =>
			frame.includes("Automatically recall context") &&
			frame.includes("Tool and skill search ranking") &&
			!frame.includes("Loading Core memory preferences")
	);
}

async function typeInEditor(setup: Setup, value: string): Promise<void> {
	for (const character of value) {
		await press(setup, { name: character });
	}
	await press(setup, { name: "return" });
}

test("Memory reads canonical Core preferences, toggles auto-recall with readback, and reloads the saved value", async () => {
	const core = installMemoryCore({
		initial: {
			"auto-recall-enabled": "false",
			"auto-recall-top-k": "7",
			"context.max-tokens": "8192",
			"context.max-output-tokens": "512",
			"context.auto-compact": "true",
			"skills-disclosure": "full",
			"tools.active_ranker": "bm25",
		},
	});
	let setup = await renderApp();
	const loaded = await openMemory(setup);
	expect(loaded).toContain("Automatically recall context OFF");
	expect(loaded).toContain("Snippets per reply 7");
	expect(loaded).toContain("Conversation context budget 8,192 tokens");
	expect(loaded).toContain("Reply token reserve 512");
	expect(loaded).toContain("Summarize older turns ON");
	expect(loaded).toContain("Load skills on demand OFF · full instructions");
	expect(loaded).toContain("Tool and skill search ranking bm25");
	expect(
		new Set(
			core.requests
				.filter(
					(item) =>
						item.method === "GET" && item.path.startsWith("/api/preferences/")
				)
				.map((item) => item.path)
		)
	).toEqual(new Set(PREF_KEYS.map((key) => `/api/preferences/${key}`)));

	await press(setup, { name: "return" });
	const saved = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Saved and confirmed from Core.") &&
			frame.includes("Automatically recall context ON")
	);
	expect(saved).toContain("Automatically recall context ON");
	const proofPath = process.env.RYU_CLI_MEMORY_BASIC_PROOF;
	if (proofPath) {
		writeFileSync(`${proofPath}.svg`, renderTerminalSvg(setup.captureSpans()));
		writeFileSync(`${proofPath}.txt`, saved);
		writeFileSync(
			`${proofPath}.requests.json`,
			JSON.stringify(core.requests, null, 2)
		);
	}
	expect(core.stored.get("auto-recall-enabled")).toBe("true");
	expect(core.requests.filter((item) => item.method === "PUT")).toEqual([
		{
			body: { value: "true" },
			method: "PUT",
			path: "/api/preferences/auto-recall-enabled",
		},
	]);
	expect(
		core.requests.filter(
			(item) =>
				item.path === "/api/preferences/auto-recall-enabled" &&
				item.method === "GET"
		).length
	).toBeGreaterThanOrEqual(2);

	await act(async () => {
		setup.renderer.destroy();
		await Promise.resolve();
	});
	setup = await renderApp();
	const reloaded = await openMemory(setup);
	expect(reloaded).toContain("Automatically recall context ON");
	expect(reloaded).toContain("Tool and skill search ranking bm25");
});

test("Memory validates recall count and context budget input before exact Core preference writes", async () => {
	const core = installMemoryCore();
	const setup = await renderApp();
	await openMemory(setup);
	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) => frame.includes("› Snippets per reply"));
	await press(setup, { name: "e" });
	await typeInEditor(setup, "not-a-number");
	const invalidCount = await waitForFrame(setup, (frame) =>
		frame.includes("Enter a whole number.")
	);
	expect(invalidCount).toContain("Snippets per reply");
	expect(
		core.requests.some(
			(item) =>
				item.path === "/api/preferences/auto-recall-top-k" &&
				item.method === "PUT"
		)
	).toBe(false);

	for (let index = 0; index < "not-a-number".length; index += 1) {
		await press(setup, { name: "backspace" });
	}
	await typeInEditor(setup, "12");
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Snippets per reply 12") &&
			frame.includes("Saved and confirmed from Core.")
	);
	expect(core.stored.get("auto-recall-top-k")).toBe("12");

	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) =>
		frame.includes("› Conversation context budget")
	);
	await press(setup, { name: "e" });
	await typeInEditor(setup, "1024");
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Conversation context budget 2,048 tokens") &&
			frame.includes("Saved and confirmed from Core.")
	);
	expect(core.stored.get("context.max-tokens")).toBe("2048");
	expect(
		core.requests
			.filter((item) => item.method === "PUT")
			.map((item) => [item.path, item.body?.value])
	).toEqual([
		["/api/preferences/auto-recall-top-k", "12"],
		["/api/preferences/context.max-tokens", "2048"],
	]);
});

test("Memory context, skill disclosure, and search ranking choices persist their canonical values", async () => {
	const core = installMemoryCore({ initial: { "context.max-tokens": "8192" } });
	const setup = await renderApp();
	await openMemory(setup);
	for (let index = 0; index < 3; index += 1) {
		await press(setup, { name: "down" });
	}
	await waitForFrame(setup, (frame) => frame.includes("Reply token reserve"));
	await press(setup, { name: "e" });
	await typeInEditor(setup, "64");
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Reply token reserve 128") &&
			frame.includes("Saved and confirmed from Core.")
	);
	expect(core.stored.get("context.max-output-tokens")).toBe("128");

	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) => frame.includes("Summarize older turns"));
	await press(setup, { name: "return" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Summarize older turns ON") &&
			frame.includes("Saved and confirmed from Core.")
	);
	expect(core.stored.get("context.auto-compact")).toBe("true");

	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) => frame.includes("Load skills on demand"));
	await press(setup, { name: "return" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Load skills on demand OFF · full instructions") &&
			frame.includes("Saved and confirmed from Core.")
	);
	expect(core.stored.get("skills-disclosure")).toBe("full");

	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Tool and skill search ranking")
	);
	await press(setup, { name: "right" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Tool and skill search ranking bm25") &&
			frame.includes("Saved and confirmed from Core.")
	);
	expect(core.stored.get("tools.active_ranker")).toBe("bm25");
	expect(
		core.requests
			.filter((item) => item.method === "PUT")
			.map((item) => [item.path, item.body?.value])
	).toEqual([
		["/api/preferences/context.max-output-tokens", "128"],
		["/api/preferences/context.auto-compact", "true"],
		["/api/preferences/skills-disclosure", "full"],
		["/api/preferences/tools.active_ranker", "bm25"],
	]);
});

test("Memory exposes failed preference reads and retries, and failed writes retry the same value", async () => {
	const core = installMemoryCore({
		failFirstAutoRecallRead: true,
		failFirstAutoRecallWrite: true,
	});
	const setup = await renderApp();
	await openMemory(setup);
	await waitForFrame(setup, (frame) =>
		frame.includes("Couldn't load Memory preferences")
	);
	await press(setup, { name: "r" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Automatically recall context ON")
	);
	await press(setup, { name: "return" });
	const failed = await waitForFrame(setup, (frame) =>
		frame.includes("Couldn't save auto-recall")
	);
	expect(failed).toContain("Press r to");
	expect(failed).toContain("retry.");
	expect(core.stored.has("auto-recall-enabled")).toBe(false);
	await press(setup, { name: "r" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Saved and confirmed from Core.") &&
			frame.includes("Automatically recall context OFF")
	);
	expect(
		core.requests
			.filter(
				(item) =>
					item.path === "/api/preferences/auto-recall-enabled" &&
					item.method === "PUT"
			)
			.map((item) => item.body?.value)
	).toEqual(["false", "false"]);
});

test("Memory Settings j/k moves between panels without changing the saved preferences", async () => {
	const core = installMemoryCore({
		initial: { "auto-recall-enabled": "false" },
	});
	const setup = await renderApp();
	await openMemory(setup);
	// App startup reads meetings for the sidebar before this panel opens.
	expect(core.requests.filter((item) => item.path === "/api/meetings")).toEqual(
		[{ method: "GET", path: "/api/meetings" }]
	);
	const beforeNavigation = core.requests.length;
	await press(setup, { name: "j" });
	const nextPanel = await waitForFrame(setup, (frame) =>
		frame.includes("Canonical meeting recovery review")
	);
	expect(nextPanel).toContain("Captured meetings and their status.");
	expect(
		core.requests
			.slice(beforeNavigation)
			.filter((item) => item.path === "/api/meetings")
	).toEqual([{ method: "GET", path: "/api/meetings" }]);
	await press(setup, { name: "k" });
	const returned = await waitForFrame(setup, (frame) =>
		frame.includes("Automatically recall context OFF")
	);
	expect(returned).toContain("Snippets per reply 5");
	expect(core.requests.some((item) => item.method === "PUT")).toBe(false);
	expect(core.stored.get("auto-recall-enabled")).toBe("false");
});

test("Memory advances a custom context budget to a preset instead of resetting it to Off", async () => {
	const core = installMemoryCore({ initial: { "context.max-tokens": "6000" } });
	const setup = await renderApp();
	await openMemory(setup);
	await press(setup, { name: "down" });
	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Conversation context budget 6,000 tokens")
	);
	await press(setup, { name: "right" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Conversation context budget 4,096 tokens") &&
			frame.includes("Saved and confirmed from Core.")
	);
	expect(
		core.requests
			.filter(
				(item) =>
					item.path === "/api/preferences/context.max-tokens" &&
					item.method === "PUT"
			)
			.map((item) => item.body?.value)
	).toEqual(["4096"]);
});

test("Memory does not edit snippet limits or auto-compact while their Core master settings are off", async () => {
	const core = installMemoryCore({
		initial: { "auto-recall-enabled": "false" },
	});
	const setup = await renderApp();
	await openMemory(setup);
	await press(setup, { name: "down" });
	await press(setup, { name: "e" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Turn on auto-recall before changing the snippet limit.")
	);
	expect(
		core.requests.some(
			(item) =>
				item.path === "/api/preferences/auto-recall-top-k" &&
				item.method === "PUT"
		)
	).toBe(false);
	for (let index = 0; index < 3; index += 1) {
		await press(setup, { name: "down" });
	}
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes(
			"Set a context budget first; auto-compact is inactive while the budget is off."
		)
	);
	expect(
		core.requests.some(
			(item) =>
				item.path === "/api/preferences/context.auto-compact" &&
				item.method === "PUT"
		)
	).toBe(false);
	expect(core.requests.some((item) => item.method === "PUT")).toBe(false);
});
