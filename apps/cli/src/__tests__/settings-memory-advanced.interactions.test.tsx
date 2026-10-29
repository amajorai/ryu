/* @jsxImportSource @opentui/react */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { act } from "react";
import { z } from "zod";
import { App } from "../App.tsx";
import {
	memoryConsentPath,
	readMemoryConsent,
	writeMemoryConsent,
} from "../core/memoryConsent.ts";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import {
	type FixtureRecord,
	fixtureRecordSchema,
	parseFixtureJson,
} from "../proof/cli-fixture-contract.ts";
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
	"context.compact-model",
	"context.compact-effort",
] as const;
const realFetch = globalThis.fetch;
type Setup = Awaited<ReturnType<typeof testRender>>;
let testSetup: Setup | null = null;
const originalRyuDir = process.env.RYU_DIR;
let consentDirectory = "";
beforeEach(() => {
	consentDirectory = mkdtempSync(join(tmpdir(), "ryu-cli-memory-consent-"));
	process.env.RYU_DIR = consentDirectory;
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath()
	);
});

afterEach(async () => {
	globalThis.fetch = realFetch;
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
	rmSync(consentDirectory, { recursive: true, force: true });
	if (originalRyuDir === undefined) {
		delete process.env.RYU_DIR;
	} else {
		process.env.RYU_DIR = originalRyuDir;
	}
});

interface RequestRecord {
	body?: FixtureRecord;
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
	const chatRequests: FixtureRecord[] = [];
	let sensitive = false;
	let denied = true;
	let failModel = true;
	let autoRecallReads = 0;
	let autoRecallWrites = 0;
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const method = init?.method ?? "GET";
			if (url.pathname === "/api/chat/stream") {
				chatRequests.push(
					fixtureRecordSchema.parse(parseFixtureJson(String(init?.body)))
				);
				return new Response(
					`data: ${JSON.stringify({ type: "text-delta", delta: "Memory consent acknowledged" })}\n\ndata: ${JSON.stringify({ type: "finish" })}\n\n`,
					{ headers: { "content-type": "text/event-stream" } }
				);
			}
			if (url.pathname === "/api/pi-config/catalog") {
				// Complete native catalog: core-client validates every provider
				// field and the catalog's apiTypes list.
				return Response.json({
					providers: [
						{
							id: "gateway",
							label: "Ryu Gateway (governed)",
							api: "openai-responses",
							authKind: "none",
							authEnv: "",
							routing: "gateway",
							configured: true,
							custom: false,
							suggestedModels: ["model-a", "model-b"],
						},
					],
					thinkingLevels: ["low", "high"],
					apiTypes: ["openai-responses"],
				});
			}
			if (url.pathname === "/api/memory/settings") {
				const body = init?.body
					? fixtureRecordSchema.parse(parseFixtureJson(String(init.body)))
					: undefined;
				requests.push({ method, path: url.pathname, body });
				if (denied) {
					return Response.json(
						{ error: "verified user required" },
						{ status: 403 }
					);
				}
				if (method === "PUT") {
					sensitive = z.boolean().parse(body?.include_sensitive_topics);
				}
				return Response.json({ include_sensitive_topics: sensitive });
			}
			if (url.pathname === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			if (url.pathname.startsWith("/api/preferences/")) {
				const key = decodeURIComponent(
					url.pathname.slice("/api/preferences/".length)
				);
				if (PREF_KEYS.some((preference) => preference === key)) {
					const body = init?.body
						? fixtureRecordSchema.parse(parseFixtureJson(String(init.body)))
						: undefined;
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
						if (key === "context.compact-model" && failModel) {
							failModel = false;
							return Response.json(
								{ error: "temporary write failure" },
								{ status: 503 }
							);
						}
						const value = z.string().safeParse(body?.value).data;
						if (value === undefined) {
							return Response.json(
								{ error: "value must be a string" },
								{ status: 400 }
							);
						}
						stored.set(key, value);
						return Response.json({ key, value });
					}
					return Response.json({ key, value: stored.get(key) ?? null });
				}
			}
			return Response.json({});
		},
		realFetch
	);
	return {
		chatRequests,
		requests,
		stored,
		allowConsent: () => {
			denied = false;
		},
	};
}

// Core publishes the complete decrypted LongTermEntry; fill the serde defaults
// Core applies to a created or edited row so the fake node answers natively.
function nativeMemory(fields: FixtureRecord): FixtureRecord {
	return {
		scope_id: null,
		when_to_use: null,
		author_agent_id: null,
		owner_user_id: "local",
		provenance: { source: "user" },
		lifecycle: "active",
		created_at: 1_767_225_600_000,
		updated_at: 1_767_225_600_000,
		...fields,
	};
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
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Message") || frame.includes("Memory consent acknowledged")
	);
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
			frame.includes("Tool and skill search ranking")
	);
}

test("Advanced Memory production App navigation confirms model/effort, denied consent, retry and local chat consent", async () => {
	const core = installMemoryCore();
	const setup = await renderApp();
	await openMemory(setup);
	await press(setup, { name: "m" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Sensitive-topic consent unavailable")
	);
	await press(setup, { name: "right" });
	await waitForFrame(setup, (frame) => frame.includes("Couldn't save"));
	expect(core.stored.has("context.compact-model")).toBe(false);
	await press(setup, { name: "r" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Summarizer model: model-a")
	);
	expect(core.stored.get("context.compact-model")).toBe("model-a");
	expect(
		core.requests
			.filter(
				(item) => item.method === "PUT" && item.path.endsWith("compact-model")
			)
			.map((item) => item.body)
	).toEqual([{ value: "model-a" }, { value: "model-a" }]);
	await press(setup, { name: "down" });
	await press(setup, { name: "right" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Summarizer thinking / effort: low")
	);
	expect(core.stored.get("context.compact-effort")).toBe("low");
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Cross-session memory: ON")
	);
	expect(readMemoryConsent()).toBe(true);
	expect(JSON.parse(readFileSync(memoryConsentPath(), "utf8"))).toEqual({
		version: 1,
		enableLongTerm: true,
	});
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("A verified user with memory write permission is required")
	);
	expect(
		core.requests.filter(
			(item) => item.path === "/api/memory/settings" && item.method === "PUT"
		)
	).toHaveLength(0);
	core.allowConsent();
	await press(setup, { name: "r" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Include sensitive topics: OFF")
	);
	await press(setup, { name: "return" });
	const frame = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Include sensitive topics: ON") &&
			frame.includes("Saved and confirmed.")
	);
	expect(
		core.requests
			.filter(
				(item) => item.path === "/api/memory/settings" && item.method === "PUT"
			)
			.map((item) => item.body)
	).toEqual([{ include_sensitive_topics: true }]);
	expect(core.requests.at(-1)?.method).toBe("GET");
	const proofPath = process.env.RYU_CLI_MEMORY_PROOF;
	if (proofPath) {
		writeFileSync(`${proofPath}.svg`, renderTerminalSvg(setup.captureSpans()));
		writeFileSync(`${proofPath}.txt`, frame);
		writeFileSync(
			`${proofPath}.requests.json`,
			JSON.stringify(core.requests, null, 2)
		);
	}
	await press(setup, { name: "m" });
	await press(setup, { name: "m" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Summarizer model: model-a") &&
			frame.includes("Include sensitive topics: ON")
	);
	await press(setup, { name: "escape" });
	await act(async () => {
		await setup.mockInput.typeText("Recall our context");
	});
	await act(async () => {
		setup.mockInput.pressEnter();
	});
	await waitForFrame(setup, (frame) =>
		frame.includes("Memory consent acknowledged")
	);
	expect(core.chatRequests[0]?.enable_long_term).toBe(true);
	expect(core.chatRequests[0]?.messages).toEqual([
		{ role: "user", content: [{ type: "text", text: "Recall our context" }] },
	]);
	await openMemory(setup);
	await press(setup, { name: "m" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Cross-session memory: ON")
	);
	await press(setup, { name: "down" });
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Cross-session memory: OFF")
	);
	await act(async () => {
		setup.renderer.destroy();
		await Promise.resolve();
	});
	const restarted = await renderApp();
	await waitForFrame(restarted, (frame) => frame.includes("Message"));
	await act(async () => {
		await restarted.mockInput.typeText("Start without recall");
	});
	await act(async () => {
		restarted.mockInput.pressEnter();
	});
	await waitForFrame(restarted, (frame) =>
		frame.includes("Memory consent acknowledged")
	);
	expect(core.chatRequests[1]?.enable_long_term).toBe(false);
});

test("CLI memory consent fails closed for malformed or unversioned data and persists with private permissions", () => {
	const path = memoryConsentPath();
	expect(readMemoryConsent()).toBe(false);
	for (const raw of [
		"{",
		'{"enableLongTerm":true}',
		'{"version":2,"enableLongTerm":true}',
		'{"version":1,"enableLongTerm":"true"}',
	]) {
		writeFileSync(path, raw);
		expect(readMemoryConsent()).toBe(false);
	}
	writeMemoryConsent(true);
	expect(readMemoryConsent()).toBe(true);
	expect(statSync(path).mode & 0o777).toBe(0o600);
	writeMemoryConsent(false);
	expect(readMemoryConsent()).toBe(false);
});

test("Advanced Memory custom model editor saves a routable ID and can restore the inherited default", async () => {
	const core = installMemoryCore();
	const setup = await renderApp();
	await openMemory(setup);
	await press(setup, { name: "m" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Summarizer model: Use default model")
	);
	await press(setup, { name: "e" });
	for (const character of "provider/model-42") {
		await press(setup, { name: character });
	}
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("Couldn't save"));
	await press(setup, { name: "r" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Summarizer model: provider/model-42")
	);
	expect(core.stored.get("context.compact-model")).toBe("provider/model-42");
	await press(setup, { name: "e" });
	await press(setup, { name: "return" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Summarizer model: Use default model") &&
			frame.includes("Saved and confirmed.")
	);
	expect(core.stored.get("context.compact-model")).toBe("");
	expect(
		core.requests
			.filter(
				(item) => item.path.endsWith("compact-model") && item.method === "PUT"
			)
			.map((item) => item.body)
	).toEqual([
		{ value: "provider/model-42" },
		{ value: "provider/model-42" },
		{ value: "" },
	]);
});

test("Memory library App navigation confirms permission denial, search, CRUD, cancel, retry and reopened readback", async () => {
	installMemoryCore();
	const fallback = globalThis.fetch;
	const memories = new Map<string, FixtureRecord>();
	const records: RequestRecord[] = [];
	let denied = true;
	let deleteFailed = false;
	let readbackFailed = false;
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (
				url.pathname !== "/api/memory" &&
				!url.pathname.startsWith("/api/memory/entry")
			) {
				return fallback(input, init);
			}
			const method = init?.method ?? "GET";
			const body = init?.body
				? fixtureRecordSchema.parse(parseFixtureJson(String(init.body)))
				: undefined;
			records.push({ method, path: url.pathname + url.search, body });
			if (method !== "GET" && denied) {
				return Response.json({ error: "space:write denied" }, { status: 403 });
			}
			if (method === "GET" && url.pathname === "/api/memory") {
				return Response.json({ memories: [...memories.values()] });
			}
			if (method === "POST") {
				const memory = nativeMemory({ ...body, id: "entry/one" });
				memories.set("entry/one", memory);
				return Response.json({ memory }, { status: 201 });
			}
			const id = decodeURIComponent(url.pathname.slice("/api/memory/".length));
			if (method === "GET" && !readbackFailed) {
				readbackFailed = true;
				return Response.json(
					{ error: "temporary readback failure" },
					{ status: 503 }
				);
			}
			if (method === "PUT") {
				memories.set(id, nativeMemory({ ...memories.get(id), ...body }));
			}
			if (method === "DELETE") {
				if (!deleteFailed) {
					deleteFailed = true;
					return Response.json(
						{ error: "temporary delete failure" },
						{ status: 503 }
					);
				}
				memories.delete(id);
				return Response.json({ removed: true });
			}
			return Response.json({ memory: memories.get(id) });
		},
		realFetch
	);
	const setup = await renderApp();
	await openMemory(setup);
	await press(setup, { name: "l" });
	await waitForFrame(setup, (frame) => frame.includes("No matching memories."));
	await press(setup, { name: "a" });
	for (const name of "Prefer concise replies") {
		await press(setup, { name });
	}
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("/api/memory failed: 403")
	);
	expect(memories.size).toBe(0);
	denied = false;
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("entry%2Fone failed: 503")
	);
	expect(memories.size).toBe(1);
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Memory saved and confirmed")
	);
	const created = {
		scope: "user",
		category: "other",
		importance: 3,
		tags: [],
		content: "Prefer concise replies",
	};
	expect(
		records.filter((item) => item.method === "POST").map((item) => item.body)
	).toEqual([created, created]);
	expect(
		records.some(
			(item) => item.method === "GET" && item.path === "/api/memory/entry%2Fone"
		)
	).toBe(true);
	await press(setup, { name: "/" });
	for (const name of "concise") {
		await press(setup, { name });
	}
	await press(setup, { name: "return" });
	await waitForFrame(
		setup,
		(frame) => frame.includes("Search: concise") && frame.includes("1 shown")
	);
	await press(setup, { name: "e" });
	for (const name of "Always: ") {
		await press(setup, { name });
	}
	await press(setup, { name: "tab" });
	const oldMetadata = JSON.stringify({
		scope: "user",
		scope_id: null,
		category: "other",
		importance: 3,
		tags: [],
		when_to_use: null,
	});
	for (const _character of oldMetadata) {
		await press(setup, { name: "right" });
	}
	for (const _character of oldMetadata) {
		await press(setup, { name: "backspace" });
	}
	const nextMetadata = {
		scope: "project",
		scope_id: "project/42",
		category: "preference",
		importance: 5,
		tags: ["tone"],
		when_to_use: "When replying",
	};
	for (const name of JSON.stringify(nextMetadata)) {
		await press(setup, { name });
	}
	await press(setup, { name: "return" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Memory saved and confirmed") &&
			!frame.includes("Edit memory") &&
			frame.includes("Always: Prefer concise replies")
	);
	expect(memories.get("entry/one")).toMatchObject({
		...nextMetadata,
		content: "Always: Prefer concise replies",
	});
	expect(records.filter((record) => record.method === "PUT").at(-1)).toEqual({
		method: "PUT",
		path: "/api/memory/entry%2Fone",
		body: { ...nextMetadata, content: "Always: Prefer concise replies" },
	});
	await press(setup, { name: "e" });
	const reopenedEditor = await waitForFrame(setup, (frame) =>
		frame.includes("Edit memory")
	);
	const visibleMetadata = reopenedEditor.replace(/\s/g, "");
	for (const fragment of [
		'"scope":"project"',
		'"scope_id":"project/42"',
		'"category":"preference"',
		'"importance":5',
		'"tags":["tone"]',
		'"when_to_use":"Whenreplying"',
	]) {
		expect(visibleMetadata).toContain(fragment);
	}
	await press(setup, { name: "b", ctrl: true });
	await waitForFrame(setup, (frame) => !frame.includes("Edit memory"));
	const proofPath = process.env.RYU_CLI_MEMORY_LIBRARY_PROOF;
	if (proofPath) {
		writeFileSync(`${proofPath}.svg`, renderTerminalSvg(setup.captureSpans()));
		writeFileSync(`${proofPath}.txt`, setup.captureCharFrame());
	}
	await press(setup, { name: "x" });
	await press(setup, { name: "n" });
	expect(records.filter((item) => item.method === "DELETE")).toHaveLength(0);
	await press(setup, { name: "x" });
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Couldn't delete memory")
	);
	expect(memories.size).toBe(1);
	await press(setup, { name: "y" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("absence confirmed") &&
			frame.includes("No matching memories")
	);
	expect(memories.size).toBe(0);
	await press(setup, { name: "l" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Automatically recall context")
	);
	await press(setup, { name: "l" });
	await waitForFrame(setup, (frame) => frame.includes("No matching memories."));
	expect(records.at(-1)?.path).toBe("/api/memory?limit=500");
	if (proofPath) {
		writeFileSync(
			`${proofPath}.requests.json`,
			JSON.stringify(records, null, 2)
		);
	}
}, 30_000);

test("Memory library arrows select the actual entry, reload retries, search matches every advertised field, and editor cancel preserves Core", async () => {
	installMemoryCore();
	const fallback = globalThis.fetch;
	const entries = [
		nativeMemory({
			id: "first",
			content: "Alpha content",
			scope: "user",
			category: "fact",
			importance: 2,
			tags: ["amber"],
		}),
		nativeMemory({
			id: "second",
			content: "Beta content",
			scope: "project",
			scope_id: "project/42",
			category: "preference",
			importance: 4,
			tags: ["violet"],
			when_to_use: "During review",
		}),
	];
	const records: RequestRecord[] = [];
	let failReload = false;
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.pathname !== "/api/memory") {
				return fallback(input, init);
			}
			records.push({
				method: init?.method ?? "GET",
				path: url.pathname + url.search,
			});
			if (failReload) {
				failReload = false;
				return Response.json(
					{ error: "temporary library failure" },
					{ status: 503 }
				);
			}
			return Response.json({ memories: entries });
		},
		realFetch
	);
	const setup = await renderApp();
	await openMemory(setup);
	await press(setup, { name: "l" });
	await waitForFrame(setup, (frame) => frame.includes("› Alpha content"));
	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) => frame.includes("› Beta content"));
	await press(setup, { name: "e" });
	await waitForFrame(setup, (frame) =>
		frame.includes('"scope_id":"project/42"')
	);
	await press(setup, { name: "z" });
	await press(setup, { name: "tab" });
	await press(setup, { name: "z" });
	await press(setup, { name: "b", ctrl: true });
	const canceled = await waitForFrame(
		setup,
		(frame) =>
			!frame.includes("Edit memory") && frame.includes("› Beta content")
	);
	expect(canceled).not.toContain("zBeta content");
	expect(records.every((record) => record.method === "GET")).toBe(true);
	await press(setup, { name: "up" });
	await waitForFrame(setup, (frame) => frame.includes("› Alpha content"));
	failReload = true;
	await press(setup, { name: "r" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Couldn't load memories")
	);
	await press(setup, { name: "e" });
	expect(setup.captureCharFrame()).not.toContain("Edit memory");
	await press(setup, { name: "r" });
	await waitForFrame(setup, (frame) => frame.includes("› Alpha content"));
	for (const query of ["BETA", "violet", "project", "preference"]) {
		await press(setup, { name: "/" });
		for (const character of query) {
			await press(setup, { name: character });
		}
		await press(setup, { name: "return" });
		const result = await waitForFrame(
			setup,
			(frame) => frame.includes(`Search: ${query}`) && frame.includes("1 shown")
		);
		expect(result).toContain("› Beta content");
		expect(result).not.toContain("Alpha content");
		await press(setup, { name: "/" });
		for (const _character of query) {
			await press(setup, { name: "right" });
		}
		for (const _character of query) {
			await press(setup, { name: "backspace" });
		}
		await press(setup, { name: "return" });
		await waitForFrame(setup, (frame) => frame.includes("2 shown"));
	}
	expect(records).toEqual(
		Array.from({ length: 3 }, () => ({
			method: "GET",
			path: "/api/memory?limit=500",
		}))
	);
}, 30_000);

test("Advanced Memory model and effort arrows restore defaults with exact writes and reopened readback; sensitive consent can be revoked", async () => {
	const core = installMemoryCore({
		initial: {
			"context.compact-model": "model-b",
			"context.compact-effort": "high",
		},
	});
	core.allowConsent();
	const setup = await renderApp();
	await openMemory(setup);
	await press(setup, { name: "m" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Summarizer model: model-b") &&
			frame.includes("Include sensitive topics: OFF")
	);
	await press(setup, { name: "left" });
	await waitForFrame(setup, (frame) => frame.includes("Couldn't save"));
	await press(setup, { name: "r" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Summarizer model: model-a")
	);
	await press(setup, { name: "left" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Summarizer model: Use default model") &&
			frame.includes("Saved and confirmed.")
	);
	await press(setup, { name: "down" });
	await press(setup, { name: "left" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Summarizer thinking / effort: low")
	);
	await press(setup, { name: "left" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Summarizer thinking / effort: Provider default")
	);
	await press(setup, { name: "right" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Summarizer thinking / effort: low")
	);
	await press(setup, { name: "left" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Summarizer thinking / effort: Provider default")
	);
	await press(setup, { name: "down" });
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Include sensitive topics: ON")
	);
	await press(setup, { name: "return" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Include sensitive topics: OFF") &&
			frame.includes("Saved and confirmed.")
	);
	expect(
		core.requests
			.filter((record) => record.method === "PUT")
			.map((record) => [record.path, record.body])
	).toEqual([
		["/api/preferences/context.compact-model", { value: "model-a" }],
		["/api/preferences/context.compact-model", { value: "model-a" }],
		["/api/preferences/context.compact-model", { value: "" }],
		["/api/preferences/context.compact-effort", { value: "low" }],
		["/api/preferences/context.compact-effort", { value: "" }],
		["/api/preferences/context.compact-effort", { value: "low" }],
		["/api/preferences/context.compact-effort", { value: "" }],
		["/api/memory/settings", { include_sensitive_topics: true }],
		["/api/memory/settings", { include_sensitive_topics: false }],
	]);
	await press(setup, { name: "up" });
	await press(setup, { name: "up" });
	await waitForFrame(setup, (frame) =>
		frame.includes("› Summarizer thinking / effort")
	);
	await press(setup, { name: "m" });
	await press(setup, { name: "m" });
	const reopened = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Summarizer model: Use default model") &&
			frame.includes("Include sensitive topics: OFF")
	);
	expect(reopened).toContain("Summarizer thinking / effort: Provider default");
	expect(core.stored.get("context.compact-model")).toBe("");
	expect(core.stored.get("context.compact-effort")).toBe("");
}, 30_000);
