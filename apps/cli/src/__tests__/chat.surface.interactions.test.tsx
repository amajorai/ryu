/* @jsxImportSource @opentui/react */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BaseRenderable,
	KeyEvent,
	ScrollBoxRenderable,
	TextAttributes,
} from "@opentui/core";
import {
	type appRequestValueSchema,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import { z } from "zod";
import { App } from "../App.tsx";
import { runsOnEnter } from "../core/autocomplete.ts";
import { createQueuedChatTurn } from "../core/chatQueue.ts";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import { testRender } from "./cli-test-render.ts";
import { MIN_TEXT_CONTRAST, renderedContrast } from "./color-contrast.ts";

const chatRequestFieldsSchema = z.looseObject({
	acp_config: z.record(z.string(), z.string()).optional(),
	acp_mode: z.string().optional(),
	acp_model: z.string().optional(),
	agent_id: z.string().optional(),
	conversation_id: z.string().optional(),
	enable_long_term: z.boolean(),
	messages: z.array(
		z.looseObject({
			role: z.enum(["user", "assistant"]),
			content: z.array(
				z.looseObject({ type: z.literal("text"), text: z.string() })
			),
		})
	),
	plugin_flags: z.record(z.string(), z.boolean()).optional(),
	team_id: z.string().optional(),
	workflow_id: z.string().optional(),
});
type ChatRequestObservation = z.infer<typeof chatRequestFieldsSchema>;
const chatRequestObservationSchema = z.custom<ChatRequestObservation>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		chatRequestFieldsSchema.safeParse(value).success
);

// Full fields from actual private Core question/permission, SDK btw/conversation and preference publishers.
const preferenceRequestFields = z.looseObject({ value: z.string() });
const pinnedRequestFields = z.looseObject({ value: z.boolean() });
const renameRequestFields = z.looseObject({ title: z.string() });
const btwRequestFields = z.looseObject({
	question: z.string(),
	conversation_id: z.string(),
});
const questionRequestFields = z.looseObject({
	conversation_id: z.string(),
	tool_call_id: z.string(),
	answers: z.array(
		z.looseObject({
			kind: z.enum(["single", "multi", "text", "skip"]),
			question_id: z.string(),
			selected_ids: z.array(z.string()).optional(),
			text: z.string().optional(),
		})
	),
});
const permissionRequestFields = z.looseObject({
	request_id: z.string(),
	option_id: z.string().nullable(),
});
const preferenceRequestObservation = z.custom<
	z.infer<typeof preferenceRequestFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		preferenceRequestFields.safeParse(value).success
);
const pinnedRequestObservation = z.custom<z.infer<typeof pinnedRequestFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		pinnedRequestFields.safeParse(value).success
);
const renameRequestObservation = z.custom<z.infer<typeof renameRequestFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		renameRequestFields.safeParse(value).success
);
const btwRequestObservation = z.custom<z.infer<typeof btwRequestFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		btwRequestFields.safeParse(value).success
);
const questionRequestObservation = z.custom<
	z.infer<typeof questionRequestFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		questionRequestFields.safeParse(value).success
);
const permissionRequestObservation = z.custom<
	z.infer<typeof permissionRequestFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		permissionRequestFields.safeParse(value).success
);
interface StreamControllerValueCapture {
	value: ReadableStreamDefaultController<Uint8Array> | null;
}
interface BtwRequestCapture {
	body: z.infer<typeof btwRequestObservation> | null;
}
interface StreamControllerCapture {
	current: ReadableStreamDefaultController<Uint8Array> | null;
}

const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;
let configDir: string | undefined;
beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "ryu-contributed-command-state-"));
	process.env.RYU_CLI_CONFIG_DIR = configDir;
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath()
	);
});

function installResponse(
	provide: (
		...args: Parameters<typeof realFetch>
	) => ReturnType<typeof realFetch>
): void {
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});
}
const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
const realDateNow = Date.now;
let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(async () => {
	globalThis.fetch = realFetch;
	Date.now = realDateNow;
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
	if (originalConfigDir === undefined) {
		delete process.env.RYU_CLI_CONFIG_DIR;
	} else {
		process.env.RYU_CLI_CONFIG_DIR = originalConfigDir;
	}
	if (configDir) {
		rmSync(configDir, { recursive: true, force: true });
		configDir = undefined;
	}
});

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
	});
	await setup.renderOnce();
}

async function waitForFrame(
	setup: Awaited<ReturnType<typeof testRender>>,
	predicate: (frame: string) => boolean,
	{ timeoutMs = 1000 }: { timeoutMs?: number } = {}
): Promise<string> {
	let frame = setup.captureCharFrame();
	// Active streams intentionally coalesce redraws for 50 ms. Poll a bounded
	// real deadline and flush each React turn; a count of zero-delay polls can
	// finish before the first production redraw. Some cases replace Date.now.
	const deadline = performance.now() + timeoutMs;
	while (!predicate(frame) && performance.now() < deadline) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await setup.renderOnce();
		});
		frame = setup.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Chat render did not match: ${frame}`);
	}
	return frame;
}

function composerValue(setup: Awaited<ReturnType<typeof testRender>>): string {
	return setup.renderer.currentFocusedEditor?.plainText ?? "";
}

/** The first Enter accepts a slash completion and the second runs it, except
 * for a bare no-argument built-in such as `/new`, which runs on the first. */
function needsSecondEnter(value: string): boolean {
	const trimmed = value.trim();
	const name = trimmed.slice(1);
	return (
		trimmed.startsWith("/") &&
		!name.includes(" ") &&
		!runsOnEnter(trimmed, { description: "", kind: "command", name })
	);
}

async function typeAndSubmit(
	setup: Awaited<ReturnType<typeof testRender>>,
	value: string
): Promise<void> {
	await act(async () => {
		await setup.mockInput.typeText(value);
	});
	await setup.flush({ maxPasses: 12 });
	await act(async () => {
		setup.mockInput.pressEnter();
	});
	await setup.renderOnce();
	if (needsSecondEnter(value)) {
		await setup.flush({ maxPasses: 12 });
		await act(async () => {
			setup.mockInput.pressEnter();
		});
		await setup.renderOnce();
	}
}

test("Chat opens the keymap with Ctrl+? and dismisses it with Escape", async () => {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	await press(testSetup, { name: "?", ctrl: true });
	const keymap = await waitForFrame(
		testSetup,
		(frame) => frame.includes("Navigation") && frame.includes("Ctrl+?")
	);
	expect(keymap).toContain("Navigation");
	await press(testSetup, { name: "escape" });
	expect(
		await waitForFrame(testSetup, (frame) => !frame.includes("Ctrl+?"))
	).not.toContain("Ctrl+?");
});

test("Chat sends the focused composer value through the stream endpoint", async () => {
	const requestBodies: ChatRequestObservation[] = [];
	installResponse(async (input, init) => {
		const url = String(input);
		if (url.endsWith("/api/chat/stream")) {
			requestBodies.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init?.body)))
			);
			return new Response(
				[
					`data: ${JSON.stringify({ type: "text-delta", delta: `Reply ${requestBodies.length}` })}`,
					`data: ${JSON.stringify({ type: "finish" })}`,
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } }
			);
		}
		return new Response("{}", {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await act(async () => {
		await setup.mockInput.typeText("Hello from CLI", 50);
	});
	await act(async () => {
		setup.mockInput.pressEnter();
	});
	const result = await waitForFrame(setup, (frame) =>
		frame.includes("Reply 1")
	);
	expect(result).toContain("Reply 1");
	expect(requestBodies[0]?.messages).toEqual([
		{ role: "user", content: [{ type: "text", text: "Hello from CLI" }] },
	]);
	expect(composerValue(setup)).toBe("");
	await act(async () => {
		// Keep typing and Enter in one renderer turn to exercise the same
		// batched input/submit path used by a fast terminal keystroke sequence.
		await setup.mockInput.typeText("Second turn", 50);
		setup.mockInput.pressEnter();
	});
	await waitForFrame(setup, (frame) => frame.includes("Reply 2"));
	expect(requestBodies[1]?.messages).toEqual([
		{ role: "user", content: [{ type: "text", text: "Hello from CLI" }] },
		{ role: "assistant", content: [{ type: "text", text: "Reply 1" }] },
		{ role: "user", content: [{ type: "text", text: "Second turn" }] },
	]);
	expect(composerValue(setup)).toBe("");
	await press(setup, { name: "up" });
	expect(composerValue(setup)).toBe("Second turn");
	await act(async () => {
		await setup.mockInput.typeText(" draft");
	});
	expect(composerValue(setup)).toBe("Second turn draft");
	await press(setup, { name: "up" });
	expect(composerValue(setup)).toBe("Second turn");
	await press(setup, { name: "down" });
	expect(composerValue(setup)).toBe("Second turn draft");
	await press(setup, { name: "l", ctrl: true });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Ask anything") &&
			!frame.includes("Reply 1") &&
			!frame.includes("Reply 2")
	);
});

test("Chat renders user turns behind a left bar and collapses long prompts until Ctrl+O", async () => {
	const longPrompt = Array.from(
		{ length: 10 },
		(_, index) => `Restored prompt row ${index + 1}`
	).join("\n");
	installResponse(async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/chat/stream") {
			return new Response(
				[
					`data: ${JSON.stringify({ type: "text-delta", delta: "Styled reply" })}`,
					`data: ${JSON.stringify({ type: "finish" })}`,
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } }
			);
		}
		if (url.pathname === "/api/conversations/long-7") {
			return Response.json({
				id: "long-7",
				title: "Long prompt",
				messages: [
					{ id: "message-1", role: "user", content: longPrompt },
					{ id: "message-2", role: "assistant", content: "Long answer" },
				],
			});
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 120,
		height: 40,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "Style this turn");
	const turn = await waitForFrame(
		setup,
		// Finished markdown paints once highlighting settles, so wait for the
		// prompt text as well as the reply.
		(frame) =>
			frame.includes("Styled reply") &&
			frame.includes("Style this turn") &&
			!frame.includes("Esc interrupt")
	);
	// The transcript shares each frame row with the sidebar, so a role label
	// shows up as a trailing word rather than a line of its own.
	expect(turn).not.toMatch(/\s(you|assistant)\s*$/m);
	const turnLines = turn.split("\n");
	const promptLine =
		turnLines.find((line) => line.includes("Style this turn")) ?? "";
	expect(promptLine).toMatch(/┃ Style this turn/);
	const replyLine =
		turnLines.find((line) => line.includes("Styled reply")) ?? "";
	expect(replyLine).not.toContain("┃");
	// The reply is indented to line up with the prompt text beside the bar.
	expect(replyLine.indexOf("Styled reply")).toBe(
		promptLine.indexOf("Style this turn")
	);

	await typeAndSubmit(setup, "/resume long-7");
	const collapsed = await waitForFrame(setup, (frame) =>
		frame.includes("Long answer")
	);
	expect(collapsed).toContain("… 4 more lines (Ctrl+O expand)");
	expect(collapsed).toContain("Restored prompt row 6");
	expect(collapsed).not.toContain("Restored prompt row 7");
	await press(setup, { name: "o", ctrl: true });
	const expanded = await waitForFrame(setup, (frame) =>
		frame.includes("Restored prompt row 10")
	);
	expect(expanded).not.toContain("more lines");
	await press(setup, { name: "o", ctrl: true });
	// Markdown keeps its previous paint until the shorter text is highlighted.
	const recollapsed = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("4 more lines") &&
			!frame.includes("Restored prompt row 10")
	);
	expect(recollapsed).not.toContain("Restored prompt row 10");

	// Clicking the hint expands only that prompt.
	const hintRow = recollapsed
		.split("\n")
		.findIndex((line) => line.includes("4 more lines"));
	const hintColumn = recollapsed.split("\n")[hintRow]?.indexOf("4 more") ?? -1;
	expect(hintRow).toBeGreaterThan(-1);
	await setup.mockMouse.click(hintColumn, hintRow);
	const clicked = await waitForFrame(setup, (frame) =>
		frame.includes("Restored prompt row 10")
	);
	expect(clicked).not.toContain("more lines");
});

test("Chat completes a workflow mention and sends the exact workflow target to Core", async () => {
	const streamBodies: ChatRequestObservation[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/agents") {
			return Response.json({ agents: [] });
		}
		if (url.pathname === "/workflows") {
			return Response.json({
				workflows: [
					{
						id: "release-checklist",
						name: "Release Checklist",
						nodes: [
							{ id: "input", type: "input" },
							{ id: "review", type: "prompt" },
						],
						edges: [{ from: "input", to: "review" }],
						triggers: [{ type: "manual" }],
					},
					{
						id: "nightly-maintenance",
						name: "Nightly Maintenance",
						nodes: [{ id: "review", type: "prompt" }],
						edges: [],
						triggers: [{ type: "manual" }],
					},
				],
			});
		}
		if (url.pathname === "/api/chat/stream" && init?.method === "POST") {
			streamBodies.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init.body)))
			);
			return new Response(
				[
					`data: ${JSON.stringify({ type: "text-delta", delta: "Workflow complete" })}`,
					`data: ${JSON.stringify({ type: "finish" })}`,
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } }
			);
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await act(async () => {
		await setup.mockInput.typeText("Run @Rele");
	});
	const suggestions = await waitForFrame(setup, (frame) =>
		frame.includes("@Release Checklist")
	);
	expect(suggestions).toMatch(/@Release Checklist\s+workflow/);
	expect(suggestions).not.toContain("@Nightly Maintenance");
	await press(setup, { name: "tab" });
	expect(setup.renderer.currentFocusedEditor?.plainText).toBe(
		"Run @Release Checklist "
	);
	await press(setup, { name: "return" });
	const result = await waitForFrame(setup, (frame) =>
		frame.includes("Workflow complete")
	);
	expect(result).toContain("Workflow complete");
	expect(streamBodies).toHaveLength(1);
	expect(streamBodies[0]?.workflow_id).toBe("release-checklist");
	expect(streamBodies[0]?.messages).toEqual([
		{
			role: "user",
			content: [{ type: "text", text: "Run @Release Checklist" }],
		},
	]);
});

test("Chat completes enabled app and plugin mentions with Desktop labels", async () => {
	const streamBodies: ChatRequestObservation[] = [];
	let appCatalogReads = 0;
	const appWire = (
		id: string,
		name: string,
		enabled: boolean,
		companion: boolean
	) => ({
		built_in: false,
		companion: companion ? { label: name, icon: null, shortcut: null } : null,
		enabled,
		id,
		installed: true,
		installed_version: "1.0.0",
		local_only: false,
		name,
		permission_grants: [],
		runnables: [],
		sidecar_name: null,
		surfaces: {},
		targets: ["cli"],
		version: "1.0.0",
		windows_first: false,
	});
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/agents") {
			return Response.json({ agents: [] });
		}
		if (url.pathname === "/api/plugins") {
			appCatalogReads += 1;
			return Response.json({
				apps: [
					appWire("@ryu/mail", "Mail", true, true),
					appWire("@ryu/bookmarks", "Bookmarks", true, false),
					appWire("@ryu/hidden", "Disabled App", false, true),
				],
			});
		}
		if (url.pathname === "/workflows") {
			return Response.json({ workflows: [] });
		}
		if (url.pathname === "/api/chat/stream" && init?.method === "POST") {
			streamBodies.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init.body)))
			);
			return new Response(
				[
					`data: ${JSON.stringify({ type: "text-delta", delta: "Mentions sent" })}`,
					`data: ${JSON.stringify({ type: "finish" })}`,
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } }
			);
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	expect(appCatalogReads).toBe(0);
	await act(async () => {
		await setup.mockInput.typeText("Review @Mai");
	});
	const appSuggestion = await waitForFrame(setup, (frame) =>
		/@Mail\s+app/.test(frame)
	);
	expect(appCatalogReads).toBe(1);
	expect(appSuggestion).not.toContain("Disabled App");
	await press(setup, { name: "tab" });
	expect(setup.renderer.currentFocusedEditor?.plainText).toBe("Review @Mail ");
	await act(async () => {
		await setup.mockInput.typeText("and @Book");
	});
	await waitForFrame(setup, (frame) => /@Bookmarks\s+plugin/.test(frame));
	expect(appCatalogReads).toBe(1);
	await press(setup, { name: "tab" });
	expect(setup.renderer.currentFocusedEditor?.plainText).toBe(
		"Review @Mail and @Bookmarks "
	);
	await press(setup, { name: "return" });
	const result = await waitForFrame(setup, (frame) =>
		frame.includes("Mentions sent")
	);
	expect(result).toContain("Mentions sent");
	expect(streamBodies).toHaveLength(1);
	expect(streamBodies[0]?.messages).toEqual([
		{
			role: "user",
			content: [{ type: "text", text: "Review @Mail and @Bookmarks" }],
		},
	]);
	expect(streamBodies[0]?.agent_id).toBeUndefined();
	expect(streamBodies[0]?.team_id).toBeUndefined();
	expect(streamBodies[0]?.workflow_id).toBeUndefined();
});

test("Chat Ctrl+A and Ctrl+R choose an agent and its ACP mode", async () => {
	const streamBodies: ChatRequestObservation[] = [];
	installResponse(async (input, init) => {
		const url = String(input);
		let body: z.infer<typeof appRequestValueSchema> = {};
		if (url.endsWith("/api/chat/stream") && init?.method === "POST") {
			streamBodies.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init.body)))
			);
			return new Response(`data: ${JSON.stringify({ type: "finish" })}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}
		if (url.endsWith("/api/agents")) {
			body = {
				agents: [
					{ id: "agent-alpha", name: "Alpha Agent" },
					{ id: "agent-beta", name: "Beta Agent" },
				],
			};
		} else if (url.endsWith("/api/agents/agent-beta/acp-config")) {
			body = {
				modes: {
					currentModeId: "plan",
					availableModes: [
						{ id: "plan", name: "Plan", description: "Plan before editing" },
						{ id: "edit", name: "Edit", description: "Allow edits" },
					],
				},
				models: null,
				configOptions: [
					{
						id: "thought_level",
						name: "Thinking",
						type: "select",
						currentValue: "low",
						options: [
							{ value: "low", name: "Low" },
							{ value: "high", name: "High" },
						],
					},
				],
			};
		}
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await press(setup, { name: "a", ctrl: true });
	await waitForFrame(setup, (frame) => frame.includes("Select agent"));
	await press(setup, { name: "down" });
	const betaRow = await waitForFrame(setup, (frame) =>
		frame.split("\n").some((row) => row.includes("› Beta Agent"))
	);
	expect(betaRow).toContain("› Beta Agent");
	await press(setup, { name: "return" });
	const selectedBeta = await waitForFrame(setup, (frame) =>
		frame.includes("Agent: Beta Agent")
	);
	expect(selectedBeta).toContain("Agent: Beta Agent");
	await press(setup, { name: "r", ctrl: true });
	await waitForFrame(setup, (frame) => frame.includes("ACP settings"));
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	const selectedMode = await waitForFrame(
		setup,
		(frame) => !frame.includes("ACP settings") && frame.includes("Edit")
	);
	expect(selectedMode).toContain("Edit");

	await press(setup, { name: "r", ctrl: true });
	const reasoningChoices = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("ACP settings") && frame.includes("Thinking: High")
	);
	expect(reasoningChoices).toContain("Thinking: Low");
	await press(setup, { name: "down" });
	await press(setup, { name: "down" });
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	await typeAndSubmit(setup, "Use the selected session settings");
	await waitForFrame(setup, () => streamBodies.length === 1);
	expect(streamBodies[0]).toMatchObject({
		acp_config: { thought_level: "high" },
		acp_mode: "edit",
		agent_id: "agent-beta",
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "Use the selected session settings" }],
			},
		],
	});
});

test("a finished turn shows its receipt and the workspace bar shows session usage", async () => {
	installResponse(async (input, init) => {
		const url = String(input);
		let body: z.infer<typeof appRequestValueSchema> = {};
		if (url.endsWith("/api/chat/stream") && init?.method === "POST") {
			return new Response(
				[
					`data: ${JSON.stringify({ type: "text-delta", delta: "Usage reply" })}`,
					// ACP re-sends its meter under one id; the last snapshot wins.
					`data: ${JSON.stringify({ type: "data-acp-usage", data: { id: "acp-usage", used: 9000, total: 153_750, done: false } })}`,
					`data: ${JSON.stringify({
						type: "data-acp-usage",
						data: {
							id: "acp-usage",
							done: true,
							used: 12_300,
							total: 153_750,
							promptTokens: 900,
							completionTokens: 300,
							tokensPerSecond: 96.8,
							durationMs: 12_400,
							sessionCostAmount: 0.42,
							sessionCostCurrency: "USD",
						},
					})}`,
					`data: ${JSON.stringify({ type: "finish" })}`,
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } }
			);
		}
		if (url.endsWith("/api/agents")) {
			body = {
				agents: [
					{ id: "agent-alpha", name: "Alpha Agent" },
					{ id: "agent-beta", name: "Beta Agent", model: "claude-sonnet-4" },
				],
			};
		}
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await press(setup, { name: "a", ctrl: true });
	await waitForFrame(setup, (frame) => frame.includes("Select agent"));
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	// The workspace bar names the agent's configured model, not "default".
	const routed = await waitForFrame(setup, (frame) =>
		frame.includes("model claude-sonnet-4")
	);
	expect(routed).not.toContain("model default");
	expect(routed).not.toContain("usage");

	await typeAndSubmit(setup, "How much did that cost?");
	// Finished markdown paints once highlighting settles, so wait for the reply
	// and both usage lines rather than the first one to appear.
	const finished = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Usage reply") &&
			frame.includes(
				"agent-beta · claude-sonnet-4 · 12.4s · 1.2K tok · 97 tok/s"
			) &&
			frame.includes("usage 12.3K (8%) · $0.42")
	);
	expect(finished).toContain("Usage reply");
	expect(finished).toContain(
		"agent-beta · claude-sonnet-4 · 12.4s · 1.2K tok · 97 tok/s"
	);
	expect(finished).toContain("usage 12.3K (8%) · $0.42");

	await typeAndSubmit(setup, "/new");
	const fresh = await waitForFrame(
		setup,
		(frame) => !frame.includes("Usage reply")
	);
	expect(fresh).not.toContain("12.3K (8%)");
	expect(fresh).not.toContain("tok/s");
});

test("a data-ryu-usage turn fits its receipt and usage meter in an 80x24 pane", async () => {
	installResponse(async (input, init) => {
		const url = String(input);
		let body: z.infer<typeof appRequestValueSchema> = {};
		if (url.endsWith("/api/chat/stream") && init?.method === "POST") {
			return new Response(
				[
					`data: ${JSON.stringify({ type: "text-delta", delta: "Meter reply" })}`,
					`data: ${JSON.stringify({
						type: "data-ryu-usage",
						data: {
							done: true,
							used: 12_300,
							total: 153_750,
							promptTokens: 900,
							completionTokens: 300,
							tokensPerSecond: 38.2,
							durationMs: 4200,
						},
					})}`,
					`data: ${JSON.stringify({ type: "finish" })}`,
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } }
			);
		}
		if (url.endsWith("/api/agents")) {
			body = {
				agents: [
					{
						id: "agent-alpha",
						name: "Alpha Agent",
						model: "claude-sonnet-4",
					},
				],
			};
		}
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 24,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await press(setup, { name: "a", ctrl: true });
	await waitForFrame(setup, (frame) => frame.includes("Select agent"));
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("model claude-sonnet-4"));

	await typeAndSubmit(setup, "Meter check");
	// Finished markdown paints once highlighting settles, so wait for the reply
	// and the receipt as well as the meter.
	const finished = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Meter reply") &&
			frame.includes(" · 4.2s · 1.2K tok · 38 tok/s") &&
			frame.includes("usage 12.3K (8%)")
	);
	expect(finished).toContain("Meter reply");
	// The narrow pane shortens the agent/model names but keeps the numbers.
	expect(finished).toContain(" · 4.2s · 1.2K tok · 38 tok/s");
	expect(finished).toContain("usage 12.3K (8%)");
	// The workspace bar stays on one row instead of wrapping its chips.
	const barRows = finished
		.split("\n")
		.filter((line) => line.includes("route ") || line.includes("model "));
	expect(barRows).toHaveLength(1);
	// Nothing in the pane runs past the terminal width.
	for (const line of finished.split("\n")) {
		expect(line.trimEnd().length).toBeLessThanOrEqual(80);
	}
});

test("Ctrl+Q opens queued prompts while a chat stream is running", async () => {
	const firstStreamController: StreamControllerValueCapture = {
		value: null,
	};
	const requestBodies: ChatRequestObservation[] = [];
	const encoder = new TextEncoder();
	installResponse(async (input, init) => {
		const url = String(input);
		if (url.endsWith("/api/chat/stream")) {
			requestBodies.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init?.body)))
			);
			if (requestBodies.length > 1) {
				return new Response(
					[
						`data: ${JSON.stringify({ type: "text-delta", delta: "Queued reply" })}`,
						`data: ${JSON.stringify({ type: "finish" })}`,
						"",
					].join("\n"),
					{ status: 200, headers: { "content-type": "text/event-stream" } }
				);
			}
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					firstStreamController.value = controller;
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ type: "text-delta", delta: "working" })}\n\n`
						)
					);
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}
		return new Response("{}", {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await act(async () => {
		await setup.mockInput.typeText("first prompt", 40);
	});
	await act(async () => {
		setup.mockInput.pressEnter();
	});
	await waitForFrame(setup, (frame) => frame.includes("working"));
	await act(async () => {
		await setup.mockInput.typeText("queued next", 40);
	});
	await act(async () => {
		setup.mockInput.pressEnter();
	});
	const queue = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Queue · 1 queued") && frame.includes("queued next")
	);
	expect(queue).toContain("queued next");
	await press(setup, { name: "q", ctrl: true });
	await press(setup, { name: "return" });
	await waitForFrame(
		setup,
		(frame) => frame.includes("Queued prompts") && frame.includes("queued next")
	);
	await press(setup, { name: "escape" });
	await act(async () => {
		firstStreamController.value?.close();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	const completed = await waitForFrame(setup, (frame) =>
		frame.includes("Queued reply")
	);
	expect(completed).toContain("Queued reply");
	expect(requestBodies).toHaveLength(2);
	expect(requestBodies[1]?.messages).toEqual([
		{ role: "user", content: [{ type: "text", text: "first prompt" }] },
		{ role: "assistant", content: [{ type: "text", text: "working" }] },
		{ role: "user", content: [{ type: "text", text: "queued next" }] },
	]);
});

// The first turn holds its body open until Esc aborts it; later turns finish.
function installInterruptibleQueueStream(
	requestBodies: ChatRequestObservation[]
): void {
	const encoder = new TextEncoder();
	installResponse(async (input, init) => {
		if (!String(input).endsWith("/api/chat/stream")) {
			return Response.json({});
		}
		requestBodies.push(
			chatRequestObservationSchema.parse(JSON.parse(String(init?.body)))
		);
		if (requestBodies.length > 1) {
			return new Response(
				[
					`data: ${JSON.stringify({ type: "text-delta", delta: "Queued reply" })}`,
					`data: ${JSON.stringify({ type: "finish" })}`,
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } }
			);
		}
		const signal = init?.signal;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({ type: "text-delta", delta: "partial work" })}\n\n`
					)
				);
				signal?.addEventListener("abort", () => controller.close(), {
					once: true,
				});
			},
		});
		return new Response(stream, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});
}

async function queueBehindInterruptibleTurn(): Promise<
	Awaited<ReturnType<typeof testRender>>
> {
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await act(async () => {
		await setup.mockInput.typeText("first", 40);
	});
	await act(async () => {
		setup.mockInput.pressEnter();
	});
	await waitForFrame(setup, (frame) => frame.includes("partial work"));
	await act(async () => {
		await setup.mockInput.typeText("queued next", 40);
	});
	await act(async () => {
		setup.mockInput.pressEnter();
	});
	await waitForFrame(setup, (frame) => frame.includes("Queue · 1 queued"));
	return setup;
}

test("Escape mid-turn marks the reply Interrupted and pauses the queue until Enter", async () => {
	const requestBodies: ChatRequestObservation[] = [];
	installInterruptibleQueueStream(requestBodies);
	const setup = await queueBehindInterruptibleTurn();
	await press(setup, { name: "escape" });
	const paused = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Interrupted") && frame.includes("Enter send next")
	);
	expect(paused).toContain("partial work");
	expect(paused).toContain("Esc clear queue");
	expect(paused).toContain("Queue · 1 queued");
	// Give a would-be auto-dispatch a chance to fire before asserting none did.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	expect(requestBodies).toHaveLength(1);

	await press(setup, { name: "return" });
	const resumed = await waitForFrame(setup, (frame) =>
		frame.includes("Queued reply")
	);
	expect(resumed).not.toContain("Queue · 1 queued");
	expect(requestBodies).toHaveLength(2);
	expect(requestBodies[1]?.messages?.at(-1)).toEqual({
		role: "user",
		content: [{ type: "text", text: "queued next" }],
	});
});

test("a second Escape while the queue is paused clears it", async () => {
	const requestBodies: ChatRequestObservation[] = [];
	installInterruptibleQueueStream(requestBodies);
	const setup = await queueBehindInterruptibleTurn();
	await press(setup, { name: "escape" });
	await waitForFrame(setup, (frame) => frame.includes("Enter send next"));
	await press(setup, { name: "escape" });
	const cleared = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Queue cleared") && !frame.includes("Queue · 1 queued")
	);
	expect(cleared).toContain("Interrupted");
	expect(requestBodies).toHaveLength(1);
});

test("a typed prompt sent while the queue is paused goes first, then the queue drains", async () => {
	const requestBodies: ChatRequestObservation[] = [];
	installInterruptibleQueueStream(requestBodies);
	const setup = await queueBehindInterruptibleTurn();
	await press(setup, { name: "escape" });
	await waitForFrame(setup, (frame) => frame.includes("Enter send next"));
	await act(async () => {
		await setup.mockInput.typeText("fresh prompt", 40);
	});
	await act(async () => {
		setup.mockInput.pressEnter();
	});
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("queued next") &&
			!frame.includes("Queue · 1 queued") &&
			frame.split("Queued reply").length === 3
	);
	expect(
		requestBodies.map((body) => body.messages?.at(-1)?.content[0]?.text)
	).toEqual(["first", "fresh prompt", "queued next"]);
});

test("/queue opens queued prompts and /queue clear removes them while a turn is active", async () => {
	const firstStreamController: StreamControllerValueCapture = {
		value: null,
	};
	const requestBodies: ChatRequestObservation[] = [];
	const encoder = new TextEncoder();
	installResponse(async (input, init) => {
		if (String(input).endsWith("/api/chat/stream")) {
			requestBodies.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init?.body)))
			);
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					firstStreamController.value = controller;
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ type: "text-delta", delta: "active turn" })}\n\n`
						)
					);
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "first prompt");
	await waitForFrame(setup, (frame) => frame.includes("active turn"));
	await typeAndSubmit(setup, "queued prompt");
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Queue · 1 queued") && frame.includes("queued prompt")
	);
	await typeAndSubmit(setup, "/queue");
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Queued prompts") && frame.includes("queued prompt")
	);
	await press(setup, { name: "escape" });
	await typeAndSubmit(setup, "/queue clear");
	const cleared = await waitForFrame(
		setup,
		(frame) => !frame.includes("Queue · 1 queued")
	);
	expect(cleared).not.toContain("queued prompt");
	await act(async () => {
		firstStreamController.value?.close();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await waitForFrame(setup, (frame) => !frame.includes("Esc interrupt"));
	expect(requestBodies).toHaveLength(1);
});

test("/queue up, down, and drop apply their slash actions to the requested queued turn", async () => {
	const fixedNow = 1_700_000_000_000;
	Date.now = () => fixedNow;
	const previous = createQueuedChatTurn("seed");
	const previousSequence = Number(previous.id.split("-").at(-1));
	const firstQueuedId = `chat-turn-${fixedNow}-${previousSequence + 1}`;
	const activeController: StreamControllerValueCapture = {
		value: null,
	};
	const requestBodies: ChatRequestObservation[] = [];
	const encoder = new TextEncoder();
	installResponse(async (input, init) => {
		if (String(input).endsWith("/api/chat/stream")) {
			requestBodies.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init?.body)))
			);
			if (requestBodies.length > 1) {
				return new Response(`data: ${JSON.stringify({ type: "finish" })}\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						activeController.value = controller;
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({ type: "text-delta", delta: "active" })}\n\n`
							)
						);
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } }
			);
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "active prompt");
	await waitForFrame(setup, (frame) => frame.includes("active"));
	await typeAndSubmit(setup, "drop this queued turn");
	await typeAndSubmit(setup, "keep this queued turn");
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Queue · 2 queued") &&
			frame.includes("keep this queued turn")
	);

	await typeAndSubmit(setup, `/queue down ${firstQueuedId}`);
	const movedDown = await waitForFrame(
		setup,
		(frame) =>
			frame.indexOf("keep this queued turn") <
			frame.indexOf("drop this queued turn")
	);
	expect(movedDown.indexOf("keep this queued turn")).toBeLessThan(
		movedDown.indexOf("drop this queued turn")
	);
	await typeAndSubmit(setup, `/queue up ${firstQueuedId}`);
	const movedUp = await waitForFrame(
		setup,
		(frame) =>
			frame.indexOf("drop this queued turn") <
			frame.indexOf("keep this queued turn")
	);
	expect(movedUp.indexOf("drop this queued turn")).toBeLessThan(
		movedUp.indexOf("keep this queued turn")
	);
	await typeAndSubmit(setup, `/queue drop ${firstQueuedId}`);
	const dropped = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Queue · 1 queued") &&
			frame.includes("keep this queued turn")
	);
	expect(dropped).not.toContain("drop this queued turn");
	await typeAndSubmit(setup, "/queue clear");
	await waitForFrame(setup, (frame) => !frame.includes("Queue · 1 queued"));
	await act(async () => {
		activeController.value?.close();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await waitForFrame(setup, (frame) => !frame.includes("Esc interrupt"));
	expect(requestBodies).toHaveLength(1);
});

// The picker card's own key hint. Its title is not a reliable marker: the
// "Terminal theme reset" toast repeats it below the shell after a reset.
const THEME_PICKER_HINT = "r reset · Esc cancel";

test("Chat theme picker moves, applies, resets, and cancels its selection", async () => {
	const savedPreferences: string[] = [];
	let preferenceReads = 0;
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (
			url.pathname === "/api/preferences/terminal-theme" &&
			init?.method === "PUT"
		) {
			const body = preferenceRequestObservation.parse(
				JSON.parse(String(init.body))
			);
			savedPreferences.push(body.value);
			return Response.json({ value: body.value });
		}
		if (url.pathname === "/api/preferences/terminal-theme") {
			preferenceReads += 1;
			return Response.json({ value: { mode: "system", preset: "ryu" } });
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await waitForFrame(setup, () => preferenceReads > 0);
	await typeAndSubmit(setup, "/theme");
	await waitForFrame(setup, (frame) => frame.includes(THEME_PICKER_HINT));
	await press(setup, { name: "down" });
	expect(
		await waitForFrame(setup, (frame) => frame.includes("› light"))
	).toContain(THEME_PICKER_HINT);
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => !frame.includes(THEME_PICKER_HINT));
	await waitForFrame(setup, () => savedPreferences.length === 1);
	expect(JSON.parse(savedPreferences[0] ?? "{}")).toEqual({
		mode: "light",
		preset: "ryu",
	});

	await typeAndSubmit(setup, "/theme");
	await waitForFrame(setup, (frame) => frame.includes(THEME_PICKER_HINT));
	await press(setup, { name: "r" });
	await waitForFrame(setup, () => savedPreferences.length === 2);
	expect(JSON.parse(savedPreferences[1] ?? "{}")).toEqual({
		mode: "system",
		preset: "ryu",
	});
	await press(setup, { name: "escape" });
	expect(
		await waitForFrame(setup, (frame) => !frame.includes(THEME_PICKER_HINT))
	).not.toContain(THEME_PICKER_HINT);
});

test("a light theme loaded after mount recolours the focused composer draft", async () => {
	let preferenceReads = 0;
	installResponse(async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/preferences/terminal-theme") {
			preferenceReads += 1;
			return Response.json({ value: { mode: "light", preset: "ryu" } });
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 24,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await waitForFrame(setup, () => preferenceReads > 0);
	await act(async () => {
		await setup.mockInput.typeText("legible draft");
	});
	await waitForFrame(setup, (frame) => frame.includes("legible draft"));
	// The composer mounts under the dark default; the light theme arrives from
	// Core afterwards and must reach the focused textarea's text colour too.
	let contrast = 0;
	const deadline = performance.now() + 1000;
	while (performance.now() < deadline) {
		contrast = renderedContrast(setup.captureSpans(), "legible draft");
		if (contrast >= MIN_TEXT_CONTRAST) {
			break;
		}
		await setup.renderOnce();
	}
	expect(contrast).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
});

test("Chat /sessions lists this conversation's runs and closes on Escape", async () => {
	let sessionPath = "";
	installResponse(async (input) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("/sessions")) {
			sessionPath = url.pathname;
			return Response.json({
				sessions: [
					{
						conversation_id: url.pathname.split("/")[3],
						created_at: 1,
						id: "session-7",
						runnable_id: "workflow-7",
						runnable_kind: "workflow",
						status: "completed",
						updated_at: 2,
					},
				],
			});
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "/sessions");
	const sessions = await waitForFrame(
		setup,
		(frame) => frame.includes("Sessions") && frame.includes("workflow-7")
	);
	expect(sessions).toContain("completed");
	expect(sessionPath).toMatch(/^\/api\/conversations\/[^/]+\/sessions$/);
	await press(setup, { name: "escape" });
	expect(
		await waitForFrame(setup, (frame) => !frame.includes("Sessions"))
	).not.toContain("Sessions");
});

test("Chat slash commands pin, unpin, rename, fork, resume, and forward goal, proof, and receipt turns", async () => {
	const pinValues: boolean[] = [];
	const renameBodies: z.infer<typeof renameRequestObservation>[] = [];
	const forkPaths: string[] = [];
	let resumedPath = "";
	const goalBodies: ChatRequestObservation[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("/pinned") && init?.method === "POST") {
			const body = pinnedRequestObservation.parse(
				JSON.parse(String(init.body))
			);
			pinValues.push(body.value);
			return Response.json({ pinned: body.value });
		}
		if (url.pathname.endsWith("/title") && init?.method === "POST") {
			const body = renameRequestObservation.parse(
				JSON.parse(String(init.body))
			);
			renameBodies.push(body);
			return Response.json({ title: body.title });
		}
		if (url.pathname.endsWith("/fork") && init?.method === "POST") {
			forkPaths.push(url.pathname);
			return Response.json({ conversation: { id: "forked-conversation" } });
		}
		if (url.pathname === "/api/conversations/restore-42") {
			resumedPath = url.pathname;
			return Response.json({
				id: "restore-42",
				title: "Restored conversation",
				messages: [
					{ id: "message-1", role: "assistant", content: "Restored reply" },
				],
			});
		}
		if (url.pathname === "/api/chat/stream" && init?.method === "POST") {
			goalBodies.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init.body)))
			);
			return new Response(`data: ${JSON.stringify({ type: "finish" })}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "/pin");
	await typeAndSubmit(setup, "/pin off");
	await typeAndSubmit(setup, "/unpin");
	await typeAndSubmit(setup, "/rename Project notes");
	await typeAndSubmit(setup, "/fork");
	await typeAndSubmit(setup, "/resume restore-42");
	const restored = await waitForFrame(setup, (frame) =>
		frame.includes("Restored reply")
	);
	expect(restored).toContain("Restored reply");
	await typeAndSubmit(setup, "/goal Finish this run");
	await waitForFrame(setup, () => goalBodies.length === 1);
	await typeAndSubmit(setup, "/proof Verify this result");
	await waitForFrame(setup, () => goalBodies.length === 2);
	await typeAndSubmit(setup, "/receipt Record this action");
	await waitForFrame(setup, () => goalBodies.length === 3);

	expect(pinValues).toEqual([true, false, false]);
	expect(renameBodies).toEqual([{ title: "Project notes" }]);
	expect(forkPaths).toHaveLength(1);
	expect(forkPaths[0]).toMatch(/^\/api\/conversations\/[^/]+\/fork$/);
	expect(resumedPath).toBe("/api/conversations/restore-42");
	expect(goalBodies.map((body) => body.messages.at(-1))).toEqual([
		{
			role: "user",
			content: [{ type: "text", text: "/goal Finish this run" }],
		},
		{
			role: "user",
			content: [{ type: "text", text: "/proof Verify this result" }],
		},
		{
			role: "user",
			content: [{ type: "text", text: "/receipt Record this action" }],
		},
	]);
});

test("Chat local slash commands toggle double-check, route groups, set model, and start new", async () => {
	const streamBodies: ChatRequestObservation[] = [];
	installResponse(async (input, init) => {
		if (String(input).endsWith("/api/chat/stream") && init?.method === "POST") {
			streamBodies.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init.body)))
			);
			return new Response(
				[
					`data: ${JSON.stringify({ type: "text-delta", delta: "Reply" })}`,
					`data: ${JSON.stringify({ type: "finish" })}`,
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } }
			);
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "/check");
	await waitForFrame(setup, (frame) => frame.includes("double-check"));
	await typeAndSubmit(setup, "/check");
	await waitForFrame(setup, (frame) => !frame.includes("double-check"));

	await typeAndSubmit(setup, "/group research");
	expect(
		await waitForFrame(setup, (frame) => frame.includes("team:research"))
	).toContain("route team:research");
	await typeAndSubmit(setup, "/group clear");
	await waitForFrame(setup, (frame) => frame.includes("route auto"));

	await typeAndSubmit(setup, "/model fast-model");
	expect(
		await waitForFrame(setup, (frame) => frame.includes("fast-model"))
	).toContain("model fast-model");
	await typeAndSubmit(setup, "/model clear");
	await waitForFrame(setup, (frame) => frame.includes("model default"));

	await typeAndSubmit(setup, "Remember this line");
	await waitForFrame(setup, (frame) => frame.includes("Remember this line"));
	await typeAndSubmit(setup, "/new");
	const fresh = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Ask anything") && !frame.includes("Remember this line")
	);
	expect(fresh).not.toContain("Remember this line");
	expect(streamBodies).toHaveLength(1);
});

test("Chat slash overlays open Help, Agent, ACP settings, Model, and btw views", async () => {
	const btwRequest: BtwRequestCapture = { body: null };
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/agents") {
			return Response.json({
				agents: [
					{ id: "agent-alpha", name: "Alpha Agent", model: "alpha-model" },
					{ id: "agent-beta", name: "Beta Agent", model: "beta-model" },
				],
			});
		}
		if (url.pathname === "/api/agents/agent-beta/acp-config") {
			return Response.json({
				modes: {
					currentModeId: "plan",
					availableModes: [
						{ id: "plan", name: "Plan" },
						{ id: "edit", name: "Edit" },
					],
				},
				models: {
					currentModelId: "beta-model",
					availableModels: [
						{ modelId: "beta-model", name: "Beta Model" },
						{ modelId: "fast-model", name: "Fast Model" },
					],
				},
				configOptions: null,
			});
		}
		if (url.pathname === "/api/btw" && init?.method === "POST") {
			btwRequest.body = btwRequestObservation.parse(
				JSON.parse(String(init.body))
			);
			return Response.json({ answer: "Side answer", model: "test-model" });
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	// Bare /help opens the shell's shortcuts overlay; /help <command> shows usage.
	await typeAndSubmit(setup, "/help");
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Keyboard shortcuts") && frame.includes("Ctrl+Alt+S")
	);
	await press(setup, { name: "escape" });
	await waitForFrame(setup, (frame) => !frame.includes("Keyboard shortcuts"));
	await typeAndSubmit(setup, "/help check");
	await waitForFrame(setup, (frame) => frame.includes("toggle double-check"));
	await press(setup, { name: "escape" });
	await waitForFrame(setup, (frame) => !frame.includes("toggle double-check"));

	await typeAndSubmit(setup, "/agent");
	await waitForFrame(setup, (frame) => frame.includes("Select agent"));
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("agent:agent-beta"));

	await typeAndSubmit(setup, "/config");
	await waitForFrame(setup, (frame) => frame.includes("ACP settings"));
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => !frame.includes("ACP settings"));
	await typeAndSubmit(setup, "/reasoning");
	await waitForFrame(setup, (frame) => frame.includes("ACP settings"));
	await press(setup, { name: "escape" });
	await waitForFrame(setup, (frame) => !frame.includes("ACP settings"));

	await typeAndSubmit(setup, "/model");
	await waitForFrame(setup, (frame) => frame.includes("Select model"));
	await press(setup, { name: "down" });
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	expect(
		await waitForFrame(setup, (frame) => frame.includes("model fast-model"))
	).toContain("model fast-model");

	await typeAndSubmit(setup, "/btw Can you summarize?");
	expect(
		await waitForFrame(setup, (frame) => frame.includes("Side answer"))
	).toContain("Side answer");
	expect(btwRequest.body?.question).toBe("Can you summarize?");
	await press(setup, { name: "escape" });
	await waitForFrame(setup, (frame) => !frame.includes("Side answer"));
});

test("Chat /delete requires confirmation and only y or Enter deletes the conversation", async () => {
	const deletions: string[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (init?.method === "DELETE") {
			deletions.push(url.pathname);
			return Response.json({ removed: true });
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "/delete conversation-9");
	const dialog = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Delete conversation?") && frame.includes("conversation-9")
	);
	expect(dialog).toContain("Enter/Y confirm · Esc/N cancel");
	await press(setup, { name: "n" });
	expect(deletions).toEqual([]);
	expect(
		await waitForFrame(
			setup,
			(frame) => !frame.includes("Delete conversation?")
		)
	).not.toContain("Delete conversation?");
	await typeAndSubmit(setup, "/delete conversation-9");
	await waitForFrame(setup, (frame) => frame.includes("Delete conversation?"));
	await press(setup, { name: "escape" });
	expect(deletions).toEqual([]);
	expect(
		await waitForFrame(
			setup,
			(frame) => !frame.includes("Delete conversation?")
		)
	).not.toContain("Delete conversation?");

	await typeAndSubmit(setup, "/delete conversation-9");
	await waitForFrame(setup, (frame) => frame.includes("Delete conversation?"));
	await press(setup, { name: "return" });
	await waitForFrame(setup, () => deletions.length === 1);
	expect(deletions).toEqual(["/api/conversations/conversation-9"]);

	await typeAndSubmit(setup, "/delete conversation-10");
	await waitForFrame(setup, (frame) => frame.includes("Delete conversation?"));
	await press(setup, { name: "y" });
	await waitForFrame(setup, () => deletions.length === 2);
	expect(deletions).toEqual([
		"/api/conversations/conversation-9",
		"/api/conversations/conversation-10",
	]);
});

test("Escape aborts the active Chat stream, cancels its turn on Core, and clears its streaming state", async () => {
	let signalAborted = false;
	let streamConversationId: string | undefined;
	const cancelBodies: string[] = [];
	installResponse(async (input, init) => {
		if (String(input).endsWith("/api/chat/cancel")) {
			cancelBodies.push(String(init?.body ?? ""));
			return Response.json({ cancelled: true });
		}
		if (String(input).endsWith("/api/chat/stream")) {
			streamConversationId = z
				.object({ conversation_id: z.string() })
				.parse(JSON.parse(String(init?.body ?? "{}"))).conversation_id;
			const signal = init?.signal;
			const encoder = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ type: "text-delta", delta: "still working" })}\n\n`
						)
					);
					if (signal) {
						signal.addEventListener("abort", () => {
							signalAborted = true;
							controller.close();
						});
					}
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await act(async () => {
		await setup.mockInput.typeText("stop this stream", 35);
	});
	await act(async () => {
		setup.mockInput.pressEnter();
	});
	const busy = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("still working") && frame.includes("Esc interrupt")
	);
	expect(busy).toMatch(/Thinking… \d+s · Esc interrupt/);
	expect(busy).toContain("Queue a follow-up… (Enter queue · Esc interrupt)");
	await press(setup, { name: "escape" });
	const stopped = await waitForFrame(
		setup,
		(frame) => signalAborted && !frame.includes("Esc interrupt")
	);
	expect(signalAborted).toBe(true);
	expect(stopped).toContain("still working");
	// Core keeps a persisted turn running after its stream is aborted, so Esc
	// must also cancel the conversation's turn there.
	expect(cancelBodies).toEqual([
		JSON.stringify({ conversation_id: streamConversationId }),
	]);
	expect(stopped).not.toContain("Thinking…");
	expect(stopped).not.toContain("Queue a follow-up");
});

test("an 80x24 terminal keeps the busy row and the whole composer box", async () => {
	const isAborted = installOpenStream([
		{ type: "text-delta", delta: "still working" },
	]);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 24,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "hello there");
	const busy = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("still working") && frame.includes("Esc interrupt")
	);
	const rows = busy.split("\n");
	const placeholderRow = rows.findIndex((row) =>
		row.includes("│ › Queue a follow-up… (Enter queue · Esc interrupt)")
	);
	// The composer keeps its top border, input row, and bottom border above the
	// footer instead of collapsing onto one border row.
	expect(placeholderRow).toBeGreaterThan(0);
	expect(rows[placeholderRow - 1]).toContain("╭");
	expect(rows[placeholderRow + 1]).toContain("╰");
	expect(rows.slice(0, placeholderRow).join("\n")).toMatch(
		/Thinking… \d+s · Esc interrupt/
	);
	await press(setup, { name: "escape" });
	const settled = await waitForFrame(
		setup,
		(frame) => isAborted() && frame.includes("Interrupted")
	);
	const settledRows = settled.split("\n");
	const idleRow = settledRows.findIndex((row) =>
		row.includes("│ › Message · Ctrl+A agent")
	);
	expect(idleRow).toBeGreaterThan(0);
	expect(settledRows[idleRow + 1]).toContain("╰");
	expect(settledRows[idleRow + 1]).not.toContain("^Kpalette");
});

// Records each chat request body and answers it with a short finished reply.
function installReplyingStream(requestBodies: ChatRequestObservation[]): void {
	installResponse(async (input, init) => {
		if (String(input).endsWith("/api/chat/stream")) {
			requestBodies.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init?.body)))
			);
			return new Response(
				[
					`data: ${JSON.stringify({ type: "text-delta", delta: `Reply ${requestBodies.length}` })}`,
					`data: ${JSON.stringify({ type: "finish" })}`,
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } }
			);
		}
		return Response.json({});
	});
}

function lastUserText(body: ChatRequestObservation | undefined): string {
	const turn = body?.messages.findLast((message) => message.role === "user");
	return turn?.content[0]?.text ?? "";
}

// Shift+Enter as a kitty/modifyOtherKeys terminal reports it.
async function pressShiftEnter(
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> {
	await act(async () => {
		setup.renderer.keyInput.emit(
			"keypress",
			new KeyEvent({
				name: "return",
				sequence: "\r",
				ctrl: false,
				shift: true,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: "\x1b[13;2u",
				source: "kitty",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await setup.renderOnce();
}

test("a multi-line bracketed paste collapses to a placeholder and sends its CRLF-normalised text", async () => {
	const requestBodies: ChatRequestObservation[] = [];
	installReplyingStream(requestBodies);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 120,
		height: 30,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await setup.mockInput.pasteBracketedText("a\r\nb\r\nc");
	expect(composerValue(setup)).toBe("[Pasted 3 lines #1]");
	await waitForFrame(setup, (frame) => frame.includes("[Pasted 3 lines #1]"));
	setup.mockInput.pressEnter();
	await waitForFrame(setup, (frame) => frame.includes("Reply 1"));
	expect(lastUserText(requestBodies[0])).toBe("a\nb\nc");
	expect(composerValue(setup)).toBe("");
	// History keeps the composer text: the placeholder, never the pasted block.
	await press(setup, { name: "up" });
	expect(composerValue(setup)).toBe("[Pasted 3 lines #1]");
});

test("a short two-line paste stays inline with its line break", async () => {
	const requestBodies: ChatRequestObservation[] = [];
	installReplyingStream(requestBodies);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 120,
		height: 30,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await setup.mockInput.pasteBracketedText("one\rtwo");
	expect(composerValue(setup)).toBe("one\ntwo");
	setup.mockInput.pressEnter();
	await waitForFrame(setup, (frame) => frame.includes("Reply 1"));
	expect(lastUserText(requestBodies[0])).toBe("one\ntwo");
});

test("Shift+Enter and Ctrl+J insert newlines without sending the draft", async () => {
	const requestBodies: ChatRequestObservation[] = [];
	installReplyingStream(requestBodies);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 120,
		height: 30,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await setup.mockInput.typeText("first");
	await pressShiftEnter(setup);
	await setup.mockInput.typeText("second");
	// A plain terminal sends Ctrl+J as a bare line feed.
	setup.mockInput.pressKey("LINEFEED");
	await setup.mockInput.typeText("third");
	await setup.renderOnce();
	expect(composerValue(setup)).toBe("first\nsecond\nthird");
	expect(requestBodies).toHaveLength(0);
	setup.mockInput.pressEnter();
	await waitForFrame(setup, (frame) => frame.includes("Reply 1"));
	expect(lastUserText(requestBodies[0])).toBe("first\nsecond\nthird");
});

test("Up moves through a multi-line draft before it recalls history", async () => {
	const requestBodies: ChatRequestObservation[] = [];
	installReplyingStream(requestBodies);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 120,
		height: 30,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "Earlier prompt");
	await waitForFrame(setup, (frame) => frame.includes("Reply 1"));
	await setup.mockInput.typeText("line one");
	await pressShiftEnter(setup);
	await setup.mockInput.typeText("line two");
	const editor = setup.renderer.currentFocusedEditor;
	expect(editor?.logicalCursor.row).toBe(1);
	// The cursor is on the last line: Up moves it rather than loading history.
	await press(setup, { name: "up" });
	expect(composerValue(setup)).toBe("line one\nline two");
	expect(editor?.logicalCursor.row).toBe(0);
	// On the first line, Up recalls the previous prompt; Down restores the draft.
	await press(setup, { name: "up" });
	expect(composerValue(setup)).toBe("Earlier prompt");
	await press(setup, { name: "down" });
	expect(composerValue(setup)).toBe("line one\nline two");
});

test("a multi-line draft keeps its whole bordered composer while streaming with a queue", async () => {
	installOpenStream([{ type: "text-delta", delta: "still working" }]);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 120,
		height: 24,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "hello there");
	await waitForFrame(setup, (frame) => frame.includes("still working"));
	await typeAndSubmit(setup, "queued one");
	await typeAndSubmit(setup, "queued two");
	await waitForFrame(setup, (frame) => frame.includes("Queue · 2 queued"));
	await setup.mockInput.typeText("draft one");
	setup.mockInput.pressKey("LINEFEED");
	await setup.mockInput.typeText("draft two");
	setup.mockInput.pressKey("LINEFEED");
	await setup.mockInput.typeText("draft three");
	const frame = await waitForFrame(setup, (current) =>
		current.includes("draft three")
	);
	const rows = frame.split("\n");
	const firstRow = rows.findIndex((row) => row.includes("│ › draft one"));
	expect(firstRow).toBeGreaterThan(0);
	expect(rows[firstRow - 1]).toContain("╭");
	expect(rows[firstRow + 1]).toMatch(/│\s+draft two/);
	expect(rows[firstRow + 2]).toMatch(/│\s+draft three/);
	// The "Queued prompt" toasts paint over the bottom rows, so check the
	// layout itself: three text rows inside a box with both borders.
	const editor = setup.renderer.currentFocusedEditor;
	expect(editor?.height).toBe(3);
	expect(editor?.parent?.height).toBe(5);
	expect(frame).toContain("Queue · 2 queued");
	expect(frame).toMatch(/Thinking… \d+s/);
});

test("Up moves through a wrapped single-line draft before it recalls history", async () => {
	const requestBodies: ChatRequestObservation[] = [];
	installReplyingStream(requestBodies);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 24,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "Earlier prompt");
	await waitForFrame(setup, (frame) => frame.includes("Reply 1"));
	const draft = Array.from({ length: 16 }, (_, index) => `word${index}`).join(
		" "
	);
	await setup.mockInput.typeText(draft);
	await setup.renderOnce();
	const editor = setup.renderer.currentFocusedEditor;
	// One logical line, wrapped onto further visual rows.
	expect(editor?.lineCount).toBe(1);
	const wrappedRows = editor?.visualCursor.visualRow ?? 0;
	expect(wrappedRows).toBeGreaterThan(0);
	// Each Up climbs one wrapped row; the draft stays in the composer.
	for (let row = wrappedRows - 1; row >= 0; row -= 1) {
		await press(setup, { name: "up" });
		expect(composerValue(setup)).toBe(draft);
		expect(editor?.visualCursor.visualRow).toBe(row);
	}
	// From the top visual row, Up recalls the previous prompt.
	await press(setup, { name: "up" });
	expect(composerValue(setup)).toBe("Earlier prompt");
});

test("a wrapped draft keeps the prompt glyph clear of the text", async () => {
	installReplyingStream([]);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 24,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await setup.mockInput.typeText(
		"draft one is a much longer line that wraps by word inside the composer"
	);
	const frame = await waitForFrame(setup, (current) =>
		current.includes("composer")
	);
	expect(frame).toContain("│ › draft one");
	expect(frame).not.toContain("›draft");
});

test("a short terminal shrinks a tall draft to keep the composer border and cursor row", async () => {
	installOpenStream([{ type: "text-delta", delta: "still working" }]);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 12,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await typeAndSubmit(setup, "hello there");
	await typeAndSubmit(setup, "queued one");
	await waitForFrame(setup, (frame) => frame.includes("Queue · 1 queued"));
	await setup.mockInput.typeText("draft one");
	setup.mockInput.pressKey("LINEFEED");
	await setup.mockInput.typeText("draft two");
	setup.mockInput.pressKey("LINEFEED");
	await setup.mockInput.typeText("draft three");
	const frame = await waitForFrame(setup, (current) =>
		current.includes("draft three")
	);
	const rows = frame.split("\n");
	const cursorRow = rows.findIndex((row) => row.includes("draft three"));
	// The row below the cursor line is the composer's closing border, not a
	// clipped text row, and the busy row and queue stay on screen.
	expect(rows[cursorRow + 1]).toContain("╰");
	expect(frame).toContain("Queue · 1 queued");
	expect(frame).toMatch(/Thinking… \d+s/);
	expect(composerValue(setup)).toBe("draft one\ndraft two\ndraft three");
});

test("a long transcript never squeezes a multi-line draft", async () => {
	const reply = Array.from({ length: 60 }, (_, index) => `line ${index}`).join(
		"\n\n"
	);
	installOpenStream([{ type: "text-delta", delta: reply }, { type: "finish" }]);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 24,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await typeAndSubmit(setup, "tell me");
	await waitForFrame(setup, (frame) => frame.includes("line 59"));
	await setup.mockInput.typeText("first");
	setup.mockInput.pressKey("LINEFEED");
	await setup.mockInput.typeText("second");
	const frame = await waitForFrame(setup, (current) =>
		current.includes("second")
	);
	expect(frame).toContain("│ › first");
	expect(frame).toMatch(/│\s+second/);
	expect(setup.renderer.currentFocusedEditor?.height).toBe(2);
});

// Streams the given frames, then holds the body open until the turn aborts.
function installOpenStream(frames: object[]): () => boolean {
	let aborted = false;
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/chat/stream") {
			const signal = init?.signal;
			const encoder = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const item of frames) {
						controller.enqueue(
							encoder.encode(`data: ${JSON.stringify(item)}\n\n`)
						);
					}
					signal?.addEventListener("abort", () => {
						aborted = true;
						controller.close();
					});
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}
		if (url.pathname === "/api/chat/permission") {
			return Response.json({ resolved: true });
		}
		return Response.json({});
	});
	return () => aborted;
}

const SPINNER_GLYPHS = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

test("Escape mid-tool leaves a static interrupted row instead of a spinner", async () => {
	const aborted = installOpenStream([
		{
			type: "tool-input-available",
			toolName: "Bash",
			toolCallId: "bash-1",
			input: { command: "sleep 60" },
		},
	]);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "run a long command");
	await waitForFrame(setup, (frame) => SPINNER_GLYPHS.test(frame));
	await press(setup, { name: "escape" });
	const stopped = await waitForFrame(
		setup,
		(frame) => aborted() && frame.includes("⊘ Bash")
	);
	expect(stopped).toContain("interrupted");
	await act(async () => {
		await Bun.sleep(1000);
	});
	await setup.renderOnce();
	const later = setup.captureCharFrame();
	expect(later).toContain("⊘ Bash");
	expect(later).toContain("interrupted");
	expect(SPINNER_GLYPHS.test(later)).toBe(false);
});

test("a tool-output-error frame settles its row as failed", async () => {
	installResponse(async (input) => {
		if (String(input).endsWith("/api/chat/stream")) {
			return new Response(
				[
					{
						type: "tool-input-available",
						toolName: "Bash",
						toolCallId: "bash-err",
						input: { command: "missing-binary" },
					},
					{
						type: "tool-output-error",
						toolCallId: "bash-err",
						errorText: "command not found",
					},
					{ type: "finish" },
				]
					.map((item) => `data: ${JSON.stringify(item)}\n`)
					.join(""),
				{ status: 200, headers: { "content-type": "text/event-stream" } }
			);
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "run a missing binary");
	const frame = await waitForFrame(setup, (current) =>
		current.includes("✗ Bash")
	);
	expect(SPINNER_GLYPHS.test(frame)).toBe(false);
});

test("the busy row names the tool still running and drops settled ones", async () => {
	const isAborted = installOpenStream([
		{
			type: "tool-input-available",
			toolName: "Bash",
			toolCallId: "bash-busy",
			input: { command: "bun test" },
		},
		{
			type: "tool-input-available",
			toolName: "Read",
			toolCallId: "read-busy",
			input: { file_path: "src/a.ts" },
		},
		{
			type: "tool-output-available",
			toolCallId: "read-busy",
			output: "contents",
		},
	]);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "run the tests");
	const frame = await waitForFrame(setup, (current) =>
		/Running command… \d+s · Esc interrupt/.test(current)
	);
	expect(frame).not.toContain("Reading files…");
	expect(frame).not.toContain("Thinking…");
	await press(setup, { name: "escape" });
	const settled = await waitForFrame(
		setup,
		(current) => isAborted() && !current.includes("Esc interrupt")
	);
	expect(settled).not.toContain("Running command…");
});

test("rejecting a tool permission strikes its row through", async () => {
	installOpenStream([
		{
			type: "tool-input-available",
			toolName: "Bash",
			toolCallId: "bash-deny",
			input: { command: "rm -rf build" },
		},
		{
			type: "data-ryu-permission",
			data: {
				requestId: "permission-deny",
				toolCall: { toolCallId: "bash-deny", title: "Run rm" },
				options: [
					{ optionId: "allow", name: "Allow once", kind: "allow_once" },
					{ optionId: "reject", name: "Reject once", kind: "reject_once" },
				],
			},
		},
	]);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "clean the build");
	const asking = await waitForFrame(setup, (frame) =>
		frame.includes("Allow the agent to Run rm?")
	);
	// Blocked on the user: the busy row says so, and Esc belongs to the prompt.
	expect(asking).toMatch(/Waiting for permission… \d+s/);
	expect(asking).not.toContain("Running command…");
	expect(asking).not.toContain("Esc interrupt");
	// The prompt replaces the composer while it waits.
	expect(asking).toContain("Permission required");
	expect(asking).not.toContain("Queue a follow-up…");
	// The tool row it is about turns into an "awaiting permission" row.
	const waitingRow =
		asking.split("\n").find((line) => line.includes("rm -rf build")) ?? "";
	expect(waitingRow).toContain("awaiting permission");
	await press(setup, { name: "escape" });
	const frame = await waitForFrame(
		setup,
		(current) => current.includes("✗ Bash") && current.includes("denied")
	);
	// The turn itself is still streaming; only the tool row must stop spinning.
	const row = frame.split("\n").find((line) => line.includes("Bash")) ?? "";
	expect(row).toContain("denied");
	expect(SPINNER_GLYPHS.test(row)).toBe(false);
	const struck = setup
		.captureSpans()
		.lines.flatMap((line) => line.spans)
		.find((span) => span.text.trim() === "Bash");
	expect(struck).toBeDefined();
	expect((struck?.attributes ?? 0) & TextAttributes.STRIKETHROUGH).not.toBe(0);
	await press(setup, { name: "escape" });
});

test("the busy row ticks once while Chat streams and the status bar keeps its hints", async () => {
	let signalAborted = false;
	installResponse(async (input, init) => {
		if (String(input).endsWith("/api/chat/stream")) {
			const signal = init?.signal;
			const encoder = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ type: "text-delta", delta: "still working" })}\n\n`
						)
					);
					signal?.addEventListener("abort", () => {
						signalAborted = true;
						controller.close();
					});
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	expect(setup.captureCharFrame()).not.toContain("Esc interrupt");
	await act(async () => {
		await setup.mockInput.typeText("keep streaming", 35);
	});
	await act(async () => {
		setup.mockInput.pressEnter();
	});
	const busy = await waitForFrame(setup, (frame) =>
		/Thinking… \d+s · Esc interrupt/.test(frame)
	);
	expect(busy).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking… \d+s · Esc interrupt/);
	// The pane's busy row owns the clock: the shell bar keeps Chat's key hints
	// and does not repeat the spinner on the row below.
	const statusRow = busy.trimEnd().split("\n").at(-1) ?? "";
	expect(statusRow).toContain("^A agent");
	expect(statusRow).not.toContain("Esc interrupt");
	const ticked = await waitForFrame(
		setup,
		(frame) => /Thinking… [1-9]\d*s/.test(frame),
		{ timeoutMs: 4000 }
	);
	expect(ticked).toMatch(/Thinking… [1-9]\d*s/);
	await press(setup, { name: "escape" });
	const stopped = await waitForFrame(
		setup,
		(frame) => signalAborted && !frame.includes("Esc interrupt")
	);
	expect(stopped).not.toContain("Esc interrupt");
});

test("Ctrl+C aborts the active Chat stream without quitting", async () => {
	let signalAborted = false;
	installResponse(async (input, init) => {
		if (String(input).endsWith("/api/chat/stream")) {
			const signal = init?.signal;
			const encoder = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ type: "text-delta", delta: "still working" })}\n\n`
						)
					);
					signal?.addEventListener("abort", () => {
						signalAborted = true;
						controller.close();
					});
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		exitOnCtrlC: false,
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	const destroy = setup.renderer.destroy;
	let quits = 0;
	setup.renderer.destroy = () => {
		quits += 1;
	};
	try {
		await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
		await act(async () => {
			await setup.mockInput.typeText("stop this stream", 35);
		});
		await act(async () => {
			setup.mockInput.pressEnter();
		});
		await waitForFrame(
			setup,
			(frame) =>
				frame.includes("still working") && frame.includes("Esc interrupt")
		);
		await press(setup, { name: "c", ctrl: true });
		const stopped = await waitForFrame(
			setup,
			(frame) => signalAborted && !frame.includes("Esc interrupt")
		);
		expect(signalAborted).toBe(true);
		expect(stopped).toContain("still working");
		expect(stopped).not.toContain("Press Ctrl+C again");
		expect(quits).toBe(0);
	} finally {
		setup.renderer.destroy = destroy;
	}
});

test("Chat question overlay submits choices, typed answers, and skip responses through Core", async () => {
	const questionPosts: z.infer<typeof questionRequestObservation>[] = [];
	let streamCount = 0;
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/chat/stream") {
			streamCount += 1;
			const question =
				streamCount === 1
					? {
							id: "choice-question",
							title: "Choose one",
							kind: "single",
							options: [
								{ id: "alpha", label: "Alpha" },
								{ id: "beta", label: "Beta" },
							],
						}
					: {
							id: `text-question-${streamCount}`,
							title: "Provide a name",
							kind: "text",
							options: [],
						};
			return new Response(
				[
					`data: ${JSON.stringify({
						type: "data-ryu-question",
						toolCallId: `question-call-${streamCount}`,
						data: { questions: [question] },
					})}`,
					`data: ${JSON.stringify({ type: "finish" })}`,
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } }
			);
		}
		if (url.pathname === "/api/chat/question" && init?.method === "POST") {
			questionPosts.push(
				questionRequestObservation.parse(JSON.parse(String(init.body)))
			);
			return Response.json({ resolved: true });
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "choose for me");
	await waitForFrame(setup, (frame) => frame.includes("Choose one"));
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	await waitForFrame(setup, () => questionPosts.length === 1);
	expect(questionPosts[0]).toMatchObject({
		tool_call_id: "question-call-1",
		answers: [
			{
				kind: "single",
				question_id: "choice-question",
				selected_ids: ["beta"],
			},
		],
	});
	await waitForFrame(
		setup,
		(frame) => !frame.includes("Enter submit · Esc skip")
	);

	await typeAndSubmit(setup, "enter a name");
	await waitForFrame(setup, (frame) =>
		frame.includes("Enter submit · Esc skip")
	);
	await press(setup, { name: "r" });
	await press(setup, { name: "y" });
	await press(setup, { name: "u" });
	await press(setup, { name: "backspace" });
	await press(setup, { name: "u" });
	await press(setup, { name: "return" });
	await waitForFrame(setup, () => questionPosts.length === 2);
	expect(questionPosts[1]).toMatchObject({
		tool_call_id: "question-call-2",
		answers: [{ kind: "text", question_id: "text-question-2", text: "ryu" }],
	});

	await waitForFrame(
		setup,
		(frame) => !frame.includes("Enter submit · Esc skip")
	);
	await typeAndSubmit(setup, "skip a name");
	await waitForFrame(setup, (frame) =>
		frame.includes("Enter submit · Esc skip")
	);
	await press(setup, { name: "escape" });
	await waitForFrame(setup, () => questionPosts.length === 3);
	expect(questionPosts[2]).toMatchObject({
		tool_call_id: "question-call-3",
		answers: [{ kind: "skip", question_id: "text-question-3" }],
	});
});

test("Chat permission overlay submits a choice and Escape rejects the next request", async () => {
	const permissionPosts: z.infer<typeof permissionRequestObservation>[] = [];
	let streamCount = 0;
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/chat/stream") {
			streamCount += 1;
			return new Response(
				[
					`data: ${JSON.stringify({
						type: "data-ryu-permission",
						data: {
							requestId: `permission-${streamCount}`,
							toolCall: { fields: { title: "Run terminal" } },
							options: [
								{ optionId: "allow", name: "Allow once", kind: "allow_once" },
								{
									optionId: "reject",
									name: "Reject once",
									kind: "reject_once",
								},
							],
						},
					})}`,
					`data: ${JSON.stringify({ type: "finish" })}`,
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } }
			);
		}
		if (url.pathname === "/api/chat/permission") {
			permissionPosts.push(
				permissionRequestObservation.parse(JSON.parse(String(init?.body)))
			);
			return Response.json({ resolved: true });
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "run the tool");
	await waitForFrame(setup, (frame) =>
		frame.includes("Allow the agent to Run terminal?")
	);
	await press(setup, { name: "return" });
	await waitForFrame(setup, () => permissionPosts.length === 1);
	expect(permissionPosts[0]).toMatchObject({
		request_id: "permission-1",
		option_id: "allow",
	});
	await waitForFrame(
		setup,
		(frame) => !frame.includes("Allow the agent to Run terminal?")
	);

	await typeAndSubmit(setup, "reject the request");
	await waitForFrame(setup, (frame) =>
		frame.includes("Allow the agent to Run terminal?")
	);
	await press(setup, { name: "escape" });
	await waitForFrame(setup, () => permissionPosts.length === 2);
	expect(permissionPosts[1]).toMatchObject({
		request_id: "permission-2",
		option_id: null,
	});
});

for (const size of [
	{ width: 120, height: 32 },
	{ width: 80, height: 24 },
]) {
	test(`permission prompt replaces the composer with the command and numbered options at ${size.width}x${size.height}`, async () => {
		const permissionPosts: z.infer<typeof permissionRequestObservation>[] = [];
		installResponse(async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname === "/api/chat/stream") {
				return new Response(
					[
						`data: ${JSON.stringify({
							type: "data-ryu-permission",
							data: {
								requestId: "permission-digit",
								toolCall: {
									toolCallId: "t1",
									kind: "execute",
									title: "Run terminal",
									rawInput: { command: "rm -rf build", cwd: "/repo" },
								},
								options: [
									{
										optionId: "allow_once",
										name: "Allow once",
										kind: "allow_once",
									},
									{
										optionId: "allow_always",
										name: "Allow always",
										kind: "allow_always",
									},
									{
										optionId: "reject_once",
										name: "Reject once",
										kind: "reject_once",
									},
								],
							},
						})}`,
						`data: ${JSON.stringify({ type: "finish" })}`,
						"",
					].join("\n"),
					{ status: 200, headers: { "content-type": "text/event-stream" } }
				);
			}
			if (url.pathname === "/api/chat/permission") {
				permissionPosts.push(
					permissionRequestObservation.parse(JSON.parse(String(init?.body)))
				);
				return Response.json({ resolved: true });
			}
			return Response.json({});
		});
		testSetup = await testRender(<App target={LOCAL_TARGET} />, size);
		await testSetup.renderOnce();
		const setup = testSetup;
		await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
		await typeAndSubmit(setup, "clean the build");
		const expectedPromptText = [
			"Permission required",
			"rm -rf build",
			"cwd: /repo",
			"[1] Allow once",
			"[2] Allow always",
			"[3] Reject once",
			"Enter confirm",
		];
		// The prompt header can paint before its body; wait for the whole prompt.
		const frame = await waitForFrame(setup, (current) =>
			expectedPromptText.every((text) => current.includes(text))
		);
		for (const text of expectedPromptText) {
			expect(frame).toContain(text);
		}
		expect(frame).not.toContain("Queue a follow-up");
		expect(frame).not.toContain("Message ·");
		// A digit past the last option does nothing.
		await press(setup, { name: "4" });
		await setup.renderOnce();
		expect(permissionPosts).toHaveLength(0);
		await press(setup, { name: "1" });
		await waitForFrame(setup, () => permissionPosts.length === 1);
		expect(permissionPosts[0]).toMatchObject({
			request_id: "permission-digit",
			option_id: "allow_once",
		});
		await waitForFrame(
			setup,
			(current) => !current.includes("Permission required")
		);
	});
}

/** Stream one permission request for `toolCall` and record the replies. */
function installPermissionStream(
	toolCall: Record<string, unknown>
): z.infer<typeof permissionRequestObservation>[] {
	const posts: z.infer<typeof permissionRequestObservation>[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/chat/stream") {
			return new Response(
				[
					`data: ${JSON.stringify({
						type: "data-ryu-permission",
						data: {
							requestId: "permission-detail",
							toolCall,
							options: [
								{
									optionId: "allow_once",
									name: "Allow once",
									kind: "allow_once",
								},
								{
									optionId: "reject_once",
									name: "Reject once",
									kind: "reject_once",
								},
							],
						},
					})}`,
					`data: ${JSON.stringify({ type: "finish" })}`,
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } }
			);
		}
		if (url.pathname === "/api/chat/permission") {
			posts.push(
				permissionRequestObservation.parse(JSON.parse(String(init?.body)))
			);
			return Response.json({ resolved: true });
		}
		return Response.json({});
	});
	return posts;
}

test("permission prompt sizes a long command to the pane, not the terminal", async () => {
	const command = `rm -rf build ${"dist/".repeat(30)}end`;
	installPermissionStream({
		toolCallId: "t1",
		kind: "execute",
		title: "Run terminal",
		rawInput: { command, cwd: "/repo" },
	});
	// The sidebar leaves the pane far narrower than the terminal, so the
	// command wraps onto more rows than a terminal-width estimate predicts.
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 24,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "clean the build");
	const frame = await waitForFrame(
		setup,
		(current) =>
			current.includes("Permission required") && current.includes("cwd: /repo")
	);
	expect(frame).toContain("$ rm -rf build");
	expect(frame).toContain("end");
	expect(frame).not.toContain("PgUp/PgDn scroll");
});

test("permission prompt pages through an edit diff taller than its row budget", async () => {
	const newText = Array.from(
		{ length: 30 },
		(_, i) => `const line${i} = ${i};`
	).join("\n");
	const posts = installPermissionStream({
		toolCallId: "t1",
		kind: "edit",
		title: "Edit src/app.ts",
		rawInput: { path: "/repo/src/app.ts" },
		content: [
			{
				type: "diff",
				path: "/repo/src/app.ts",
				oldText: "const a = 1;",
				newText,
			},
		],
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 24,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "edit the app");
	const frame = await waitForFrame(setup, (current) =>
		current.includes("PgUp/PgDn scroll")
	);
	for (const text of [
		"Allow the agent to Edit src/app.ts?",
		"+++ /repo/src/app.ts",
		"[1] Allow once",
		"[2] Reject once",
	]) {
		expect(frame).toContain(text);
	}
	expect(frame).not.toContain("const line29 = 29;");
	for (let page = 0; page < 6; page += 1) {
		await press(setup, { name: "pagedown" });
	}
	const scrolled = await waitForFrame(setup, (current) =>
		current.includes("const line29 = 29;")
	);
	expect(scrolled).toContain("[1] Allow once");
	// Ctrl+digit is not a choice; a plain digit is.
	await press(setup, { name: "2", ctrl: true });
	expect(posts).toHaveLength(0);
	await press(setup, { name: "2" });
	await waitForFrame(setup, () => posts.length === 1);
	expect(posts[0]).toMatchObject({
		request_id: "permission-detail",
		option_id: "reject_once",
	});
});

test("stopped reader settling after a resumed send cannot mutate its assistant or clear its controller", async () => {
	const bodies: ChatRequestObservation[] = [];
	const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
	const signals: AbortSignal[] = [];
	const encoder = new TextEncoder();
	const chunk = (text: string) =>
		encoder.encode(
			`data: ${JSON.stringify({ type: "text-delta", delta: text })}\n\n`
		);
	installResponse(async (input, init) => {
		if (!String(input).endsWith("/api/chat/stream")) {
			return Response.json({});
		}
		bodies.push(
			chatRequestObservationSchema.parse(JSON.parse(String(init?.body)))
		);
		if (!init?.signal) {
			throw new Error("production turn missing AbortSignal");
		}
		signals.push(init.signal);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controllers.push(controller);
				controller.enqueue(
					chunk(
						bodies.length === 1
							? "Acknowledged old response"
							: "Resumed response stays owned"
					)
				);
			},
		});
		// The old transport deliberately settles late, even after cancellation.
		return new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 40,
	});
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "old pending turn");
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Acknowledged old response") &&
			frame.includes("Esc interrupt")
	);
	await press(setup, { name: "escape" });
	expect(signals[0]?.aborted).toBe(true);
	await typeAndSubmit(setup, "resumed pending turn");
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Resumed response stays owned") &&
			frame.includes("Esc interrupt")
	);
	const old = controllers[0];
	if (!old) {
		throw new Error("old real reader missing");
	}
	await act(async () => {
		old.enqueue(chunk("STALE OLD DELTA MUST NOT ENTER RESUMED ASSISTANT"));
		old.close();
		await new Promise((resolve) => setTimeout(resolve, 70));
	});
	await setup.renderOnce();
	const afterOldSettlement = setup.captureCharFrame();
	expect(afterOldSettlement).toContain("Resumed response stays owned");
	expect(afterOldSettlement).not.toContain("STALE OLD DELTA");
	expect(afterOldSettlement).toContain("Esc interrupt");
	await press(setup, { name: "escape" });
	expect(signals[1]?.aborted).toBe(true);
	const resumed = controllers[1];
	if (!resumed) {
		throw new Error("resumed real reader missing");
	}
	await act(async () => resumed.close());
	await waitForFrame(setup, (frame) => !frame.includes("Esc interrupt"));
	expect(bodies).toHaveLength(2);
	expect(bodies[0]?.conversation_id).toBe(bodies[1]?.conversation_id);
});

test("40-row transcript follows six turns through Stop and resume while manual scrollback remains stable", async () => {
	const prompts = [
		"advertise commands",
		"/acp-review check staged changes",
		"/acp-review check staged changes",
		"clear commands",
		"hold stream",
		"after stop",
	];
	const bodies: ChatRequestObservation[] = [];
	let held: ReadableStreamDefaultController<Uint8Array> | null = null;
	const resumed: StreamControllerCapture = { current: null };
	const signals: AbortSignal[] = [];
	const encoder = new TextEncoder();
	const delta = (text: string) =>
		encoder.encode(
			`data: ${JSON.stringify({ type: "text-delta", delta: text })}\n\n`
		);
	installResponse(async (input, init) => {
		if (!String(input).endsWith("/api/chat/stream")) {
			return Response.json({});
		}
		bodies.push(
			chatRequestObservationSchema.parse(JSON.parse(String(init?.body)))
		);
		if (!init?.signal) {
			throw new Error("production turn missing signal");
		}
		signals.push(init.signal);
		if (bodies.length === 2) {
			return new Response("temporary refusal", { status: 503 });
		}
		const count = bodies.length;
		const text =
			count === 5
				? "Held stream visible at transcript tail"
				: count === 6
					? "Same-conversation retry completed after Stop."
					: `Turn ${count} acknowledged\n${Array.from({ length: 6 }, (_, index) => `Durable transcript turn ${count} line ${index}`).join("\n")}`;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(delta(text));
				if (count === 1 || count === 3 || count === 4) {
					const name =
						count === 1 ? "acp-review" : count === 3 ? "acp-followup" : null;
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ type: "data-ryu-acp-commands", data: { commands: name ? [{ name, description: `Run ${name} using Review Agent.`, hint: "changes" }] : [] } })}\n\n`
						)
					);
				}

				if (count === 5) {
					held = controller;
					init.signal?.addEventListener("abort", () => controller.close(), {
						once: true,
					});
				} else if (count === 6) {
					resumed.current = controller;
				} else {
					controller.enqueue(encoder.encode('data: {"type":"finish"}\n\n'));
					controller.close();
				}
			},
		});
		return new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 120,
		height: 40,
	});
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	for (let index = 0; index < 5; index++) {
		const prompt = prompts[index];
		if (!prompt) {
			throw new Error("required turn missing");
		}
		await typeAndSubmit(setup, prompt);
		const marker =
			index === 1
				? "HTTP 503"
				: index === 4
					? "Held stream visible at transcript tail"
					: `Durable transcript turn ${index + 1} line 5`;
		await waitForFrame(setup, (frame) => frame.includes(marker));
	}
	expect(held !== null).toBe(true);
	await press(setup, { name: "escape" });
	expect(signals[4]?.aborted).toBe(true);
	await typeAndSubmit(setup, "after stop");
	await waitForFrame(setup, (frame) =>
		frame.includes("Same-conversation retry completed after Stop.")
	);
	const scrolls: ScrollBoxRenderable[] = [];
	function collect(node: BaseRenderable): void {
		if (node instanceof ScrollBoxRenderable) {
			scrolls.push(node);
		}
		for (const child of node.getChildren()) {
			collect(child);
		}
	}
	collect(setup.renderer.root);
	const transcript = scrolls.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
	if (!transcript || transcript.scrollHeight < 40) {
		throw new Error("real overflowing transcript scrollbox missing");
	}
	await act(async () => transcript.scrollBy(-6));
	await setup.renderOnce();
	const scrollbackTop = transcript.scrollTop;
	expect(scrollbackTop).toBeGreaterThan(0);
	const controller = resumed.current;
	if (!controller) {
		throw new Error("resumed real reader missing");
	}
	await act(async () => {
		controller.enqueue(delta("\nLater resumed delta after manual scrollback"));
		await new Promise((resolve) => setTimeout(resolve, 70));
	});
	await setup.renderOnce();
	expect(transcript.scrollTop).toBe(scrollbackTop);
	await act(async () => transcript.scrollTo(transcript.scrollHeight));
	await setup.renderOnce();
	await waitForFrame(setup, (frame) =>
		frame.includes("Later resumed delta after manual scrollback")
	);
	await act(async () => controller.close());
	await waitForFrame(setup, (frame) => !frame.includes("Esc interrupt"));
	expect(bodies).toHaveLength(6);
	const firstConversation = bodies[0]?.conversation_id;
	expect(firstConversation).toBeTypeOf("string");
	for (const body of bodies) {
		expect(body.conversation_id).toBe(firstConversation);
	}
	const lastTexts = bodies.map((body) => {
		const messages = body.messages;
		return messages.at(-1)?.content[0]?.text;
	});
	expect(lastTexts).toEqual(prompts);
});

test("Composer Enter leaves streamed reasoning collapsed to one timed row", async () => {
	const reasoningBody = "hidden reasoning body";
	let streamCount = 0;
	installResponse(async (input) => {
		if (String(input).endsWith("/api/chat/stream")) {
			streamCount += 1;
			return new Response(
				[
					`data: ${JSON.stringify({ type: "reasoning-delta", delta: `**Checking layout**\n${reasoningBody}` })}`,
					`data: ${JSON.stringify({ type: "text-delta", delta: `Answer ${streamCount}` })}`,
					`data: ${JSON.stringify({ type: "finish" })}`,
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } }
			);
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 24,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "first");
	await waitForFrame(
		setup,
		(frame) => frame.includes("Answer 1") && !frame.includes("Esc interrupt")
	);
	// An empty Enter and a real follow-up submit both go to the composer only.
	await act(async () => {
		setup.mockInput.pressEnter();
	});
	await typeAndSubmit(setup, "second");
	const frame = await waitForFrame(
		setup,
		(current) =>
			current.includes("Answer 2") && !current.includes("Esc interrupt")
	);
	expect(frame).not.toContain(reasoningBody);
	const thoughtRows = frame
		.split("\n")
		.filter((line) => line.includes("Thought: Checking layout"));
	expect(thoughtRows).toHaveLength(2);
	for (const row of thoughtRows) {
		expect(row).toMatch(/\+ Thought: Checking layout · \d+\.\ds\s*$/);
	}
});

test("PgUp scrolls the transcript, new output stays put behind a jump strip, and Ctrl+End returns", async () => {
	const encoder = new TextEncoder();
	const delta = (text: string) =>
		encoder.encode(
			`data: ${JSON.stringify({ type: "text-delta", delta: text })}\n\n`
		);
	const stream: StreamControllerCapture = { current: null };
	installResponse(async (input) => {
		if (!String(input).endsWith("/api/chat/stream")) {
			return Response.json({});
		}
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					delta(
						Array.from(
							{ length: 40 },
							(_, index) => `Overflow transcript line ${index}`
						).join("\n")
					)
				);
				stream.current = controller;
			},
		});
		return new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 100,
		height: 24,
	});
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "fill the screen");
	await waitForFrame(setup, (frame) =>
		frame.includes("Overflow transcript line 39")
	);
	const scrolls: ScrollBoxRenderable[] = [];
	function collect(node: BaseRenderable): void {
		if (node instanceof ScrollBoxRenderable) {
			scrolls.push(node);
		}
		for (const child of node.getChildren()) {
			collect(child);
		}
	}
	collect(setup.renderer.root);
	const transcript = scrolls.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
	if (!transcript || transcript.scrollHeight <= transcript.viewport.height) {
		throw new Error("overflowing transcript scrollbox missing");
	}
	const bottomTop = transcript.scrollTop;
	expect(setup.captureCharFrame()).not.toContain("Jump to latest");

	// Plain End belongs to the composer: it moves the cursor, not the transcript.
	await act(async () => {
		await setup.mockInput.typeText("abc");
	});
	await press(setup, { name: "home" });
	await press(setup, { name: "end" });
	await act(async () => {
		await setup.mockInput.typeText("Y");
	});
	await setup.renderOnce();
	expect(setup.renderer.currentFocusedEditor?.plainText).toBe("abcY");
	expect(transcript.scrollTop).toBe(bottomTop);

	await press(setup, { name: "pageup" });
	const scrolledTop = transcript.scrollTop;
	expect(scrolledTop).toBeLessThan(bottomTop);
	await waitForFrame(setup, (frame) => frame.includes("Jump to latest"));

	const controller = stream.current;
	if (!controller) {
		throw new Error("open stream missing");
	}
	await act(async () => {
		controller.enqueue(delta("\nArrived while scrolled away"));
		await new Promise((resolve) => setTimeout(resolve, 70));
	});
	const away = await waitForFrame(setup, (frame) => frame.includes("(1 new)"));
	expect(transcript.scrollTop).toBe(scrolledTop);
	expect(away).not.toContain("Arrived while scrolled away");

	await press(setup, { name: "end", ctrl: true });
	const latest = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Arrived while scrolled away") &&
			!frame.includes("Jump to latest")
	);
	expect(latest).not.toContain("Jump to latest");
	expect(transcript.scrollTop).toBe(
		Math.max(0, transcript.scrollHeight - transcript.viewport.height)
	);
	await act(async () => controller.close());
});

test("Sending a prompt while scrolled back jumps the transcript to the new turn", async () => {
	const encoder = new TextEncoder();
	let turn = 0;
	installResponse(async (input) => {
		if (!String(input).endsWith("/api/chat/stream")) {
			return Response.json({});
		}
		turn += 1;
		const reply = Array.from(
			{ length: 40 },
			(_, index) => `Turn ${turn} line ${index}`
		).join("\n");
		return new Response(
			`data: ${JSON.stringify({ type: "text-delta", delta: reply })}\n\n`,
			{ headers: { "content-type": "text/event-stream" } }
		);
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 24,
	});
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await typeAndSubmit(setup, "first prompt");
	await waitForFrame(
		setup,
		(frame) => frame.includes("Turn 1 line 39") && frame.includes("Message")
	);

	await press(setup, { name: "pageup" });
	await press(setup, { name: "pageup" });
	await waitForFrame(setup, (frame) => frame.includes("Jump to latest"));

	await typeAndSubmit(setup, "second prompt");
	const latest = await waitForFrame(setup, (frame) =>
		frame.includes("Turn 2 line 39")
	);
	expect(latest).not.toContain("Jump to latest");
});

const RECENT_CONVERSATIONS = [
	{
		id: "conv-alpha-0001",
		title: "Plan the release checklist",
		updated_at: "2026-10-01T10:00:00Z",
		message_count: 4,
	},
	{
		id: "conv-beta-0002",
		title: "Debug the gateway timeout",
		updated_at: "2026-09-30T10:00:00Z",
		message_count: 2,
	},
];

function installRecentConversations(): string[] {
	const resumed: string[] = [];
	installResponse((input) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/conversations") {
			return Promise.resolve(
				Response.json({ conversations: RECENT_CONVERSATIONS })
			);
		}
		if (url.pathname === "/api/conversations/conv-alpha-0001") {
			resumed.push(url.pathname);
			return Promise.resolve(
				Response.json({
					id: "conv-alpha-0001",
					title: "Plan the release checklist",
					messages: [
						{ id: "m1", role: "user", content: "Draft the checklist" },
						{ id: "m2", role: "assistant", content: "Checklist drafted" },
					],
				})
			);
		}
		return Promise.resolve(Response.json({}));
	});
	return resumed;
}

const SPLIT_HINT_FRAGMENTS = [
	/Ctrl\+A pick\s*$/,
	/^\W*agent\b/,
	/Ctrl\+Q\s*$/,
	/^\W*queue\b/,
];

for (const size of [
	{ width: 80, height: 24 },
	{ width: 120, height: 36 },
]) {
	test(`Chat empty state centres the hero and lists recent conversations at ${size.width}x${size.height}`, async () => {
		installRecentConversations();
		testSetup = await testRender(<App target={LOCAL_TARGET} />, size);
		await testSetup.renderOnce();
		const frame = await waitForFrame(
			testSetup,
			(current) =>
				current.includes("Ask anything") &&
				current.includes("Resume") &&
				current.includes("Debug the gateway timeout")
		);
		const rows = frame.split("\n");
		const modeRow = rows.findIndex((row) => row.includes("Ask anything"));
		// Centred vertically: the mode line sits well below the top rows.
		expect(modeRow).toBeGreaterThan(1);
		expect(frame).toContain("Ctrl+A pick agent");
		expect(frame).toContain("Ctrl+Q queue");
		expect(frame).toContain("Alt+1");
		expect(frame).toContain("Plan the release checklist");
		// The old command wall is gone; /help and autocomplete own it.
		expect(frame).not.toContain("/proof /check");
		// Centred horizontally inside the transcript area (the composer border
		// marks its columns): the hero block's left and right gutters match.
		const borderRow = rows.find((row) => row.includes("╭")) ?? "";
		const areaStart = borderRow.indexOf("╭") + 1;
		const areaEnd = borderRow.indexOf("╮");
		const heroRows = rows
			.map((row) => row.slice(areaStart, areaEnd))
			.filter((row) => /Ask anything|Ctrl\+A pick agent|Alt\+\d/.test(row));
		const leftGap = Math.min(...heroRows.map((row) => row.search(/\S/)));
		const rightGap = Math.min(
			...heroRows.map((row) => row.length - row.trimEnd().length)
		);
		expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(2);
		for (const row of rows) {
			const content = row.replaceAll(/[│┃|]/g, " ");
			for (const fragment of SPLIT_HINT_FRAGMENTS) {
				expect(content.trim()).not.toMatch(fragment);
			}
		}
	});
}

test("Chat empty state hides recent conversations when Core has none", async () => {
	installResponse(() => Promise.resolve(Response.json({})));
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 24,
	});
	await testSetup.renderOnce();
	const frame = await waitForFrame(testSetup, (current) =>
		current.includes("Ask anything")
	);
	expect(frame).not.toContain("Resume");
	expect(frame).not.toContain("Alt+1");
});

test("Chat Alt+1 on the empty state resumes the first recent conversation", async () => {
	const resumed = installRecentConversations();
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 120,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) =>
		frame.includes("Plan the release checklist")
	);
	await act(async () => {
		setup.renderer.keyInput.emit(
			"keypress",
			new KeyEvent({
				name: "1",
				sequence: "\u001b1",
				ctrl: false,
				shift: false,
				meta: true,
				option: true,
				eventType: "press",
				repeated: false,
				number: true,
				raw: "\u001b1",
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	const frame = await waitForFrame(setup, (current) =>
		current.includes("Checklist drafted")
	);
	expect(resumed).toEqual(["/api/conversations/conv-alpha-0001"]);
	expect(frame).not.toContain("Ask anything");
	expect(composerValue(setup)).toBe("");
});

test("Chat empty state on a short terminal keeps Alt+N to the rows it shows", async () => {
	const resumed = installRecentConversations();
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 12,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	const frame = await waitForFrame(setup, (current) =>
		current.includes("Ask anything")
	);
	// No room for recents: the hero stays above the status line and composer.
	expect(frame).not.toContain("Alt+1");
	const rows = frame.split("\n");
	const statusRow = rows.findIndex((row) => row.includes("route auto"));
	expect(rows[statusRow]).toMatch(/route auto\s+model default\s*$/);
	await act(async () => {
		setup.renderer.keyInput.emit(
			"keypress",
			new KeyEvent({
				name: "1",
				sequence: "\u001b1",
				ctrl: false,
				shift: false,
				meta: true,
				option: true,
				eventType: "press",
				repeated: false,
				number: true,
				raw: "\u001b1",
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	await setup.renderOnce();
	expect(resumed).toEqual([]);
	expect(setup.captureCharFrame()).toContain("Ask anything");
});

test("Chat completion ranks, scrolls, runs bare commands on Enter, and lists @path files", async () => {
	const streamBodies: unknown[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/chat/stream") {
			streamBodies.push(JSON.parse(String(init?.body)));
			return new Response(
				[
					`data: ${JSON.stringify({ type: "text-delta", delta: "Noted" })}`,
					`data: ${JSON.stringify({ type: "finish" })}`,
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } }
			);
		}
		return Response.json({});
	});
	const workspace = mkdtempSync(join(tmpdir(), "ryu-cli-file-mentions-"));
	mkdirSync(join(workspace, "src", "nested"), { recursive: true });
	writeFileSync(join(workspace, "src", "main.ts"), "");
	mkdirSync(join(workspace, "src", "node_modules"));
	const originalCwd = process.cwd();
	process.chdir(workspace);
	try {
		testSetup = await testRender(<App target={LOCAL_TARGET} />, {
			width: 140,
			height: 40,
		});
		await testSetup.renderOnce();
		const setup = testSetup;
		await waitForFrame(setup, (frame) => frame.includes("Ask anything"));

		// Every built-in matches `/`; ten rows show and the rest are counted.
		await act(async () => {
			await setup.mockInput.typeText("/");
		});
		const all = await waitForFrame(setup, (frame) => frame.includes("more"));
		expect(all).toMatch(/↓ \d+ more/);
		expect(all).toMatch(/\/agent\s+choose an agent\s+local/);
		await press(setup, { name: "up" });
		for (let step = 0; step < 10; step += 1) {
			await press(setup, { name: "down" });
		}
		expect(setup.captureCharFrame()).toMatch(/↑ 1 more/);

		// A typo still finds the command by subsequence.
		await act(async () => {
			await setup.mockInput.typeText("hlp");
		});
		const typo = await waitForFrame(setup, (frame) =>
			/› \/help\s+show slash command help/.test(frame)
		);
		expect(typo).not.toContain("No matches");
		await act(async () => {
			await setup.mockInput.typeText("zz");
		});
		await waitForFrame(setup, (frame) => frame.includes("No matches"));
		await press(setup, { name: "escape" });
		for (let index = 0; index < "/hlpzz".length; index += 1) {
			await press(setup, { name: "backspace" });
		}
		expect(composerValue(setup)).toBe("");

		await typeAndSubmit(setup, "Remember this line");
		await waitForFrame(
			setup,
			(frame) => frame.includes("Noted") && !frame.includes("Esc interrupt")
		);
		// One Enter runs a bare no-argument command; it is not just completed.
		await act(async () => {
			await setup.mockInput.typeText("/new");
		});
		await waitForFrame(setup, (frame) =>
			/› \/new\s+start a new chat/.test(frame)
		);
		await press(setup, { name: "return" });
		const fresh = await waitForFrame(
			setup,
			(frame) =>
				frame.includes("Ask anything") && !frame.includes("Remember this line")
		);
		expect(fresh).not.toContain("Complete");
		expect(composerValue(setup)).toBe("");
		// A stray second Enter on the empty composer sends nothing.
		await press(setup, { name: "return" });
		expect(streamBodies).toHaveLength(1);

		// `@dir/` lists that directory one level deep, skipping node_modules.
		await act(async () => {
			await setup.mockInput.typeText("Read @src/");
		});
		const files = await waitForFrame(setup, (frame) =>
			frame.includes("@src/main.ts")
		);
		expect(files).toMatch(/@src\/nested\/\s+folder/);
		expect(files).toMatch(/@src\/main\.ts\s+file/);
		expect(files).not.toContain("node_modules");
		await press(setup, { name: "tab" });
		expect(composerValue(setup)).toBe("Read @src/nested/");
	} finally {
		process.chdir(originalCwd);
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Chat completion on a short terminal keeps its header and selection on screen", async () => {
	installResponse(async () => Response.json({}));
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 16,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await act(async () => {
		await setup.mockInput.typeText("/");
	});
	const frame = await waitForFrame(setup, (current) =>
		current.includes("more")
	);
	const lines = frame.split("\n");
	// The floating list fits above the composer instead of clipping off the top.
	const header = lines.findIndex((line) => line.includes("Complete"));
	expect(header).toBeGreaterThan(0);
	expect(lines[header - 1]).toContain("╭");
	expect(frame).toMatch(/› \/agent\s+choose an agent\s+local/);
	expect(frame).toMatch(/↓ \d+ more/);
});
