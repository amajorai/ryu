/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import { z } from "zod";
import { App } from "../App.tsx";
import { runsOnEnter } from "../core/autocomplete.ts";
import {
	defaultProductModePreference,
	type ProductMode,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import { testRender } from "./cli-test-render.ts";

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

function installResponse(
	provide: (
		...args: Parameters<typeof realFetch>
	) => ReturnType<typeof realFetch>
): void {
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});
}
const TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;

let testHome: string | null = null;
type RenderedApp = Awaited<ReturnType<typeof testRender>>;
let setup: RenderedApp | null = null;

afterEach(async () => {
	globalThis.fetch = realFetch;
	if (originalConfigDir === undefined) {
		delete process.env.RYU_CLI_CONFIG_DIR;
	} else {
		process.env.RYU_CLI_CONFIG_DIR = originalConfigDir;
	}
	if (testHome) {
		rmSync(testHome, { force: true, recursive: true });
		testHome = null;
	}
	await act(async () => {
		setup?.renderer.destroy();
		await Promise.resolve();
	});
	setup = null;
});

function configureMode(mode: ProductMode, surface?: string): void {
	testHome = mkdtempSync(join(tmpdir(), "ryu-cli-bot-parity-"));
	process.env.RYU_CLI_CONFIG_DIR = join(testHome, ".ryu");
	const directory = join(testHome, ".ryu");
	mkdirSync(directory, { recursive: true });
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), mode, surface),
		productModePreferencePath(testHome)
	);
}

async function renderApp(): Promise<RenderedApp> {
	let rendered: RenderedApp | null = null;
	await act(async () => {
		const next = await testRender(<App target={TARGET} />, {
			height: 36,
			width: 140,
		});
		rendered = next;
		await next.renderOnce();
	});
	if (!rendered) {
		throw new Error("OpenTUI did not render the CLI app");
	}
	setup = rendered;
	return rendered;
}

interface KeyInput {
	ctrl?: boolean;
	name: string;
}

async function press(renderer: RenderedApp, key: KeyInput): Promise<void> {
	const keyInput = renderer.renderer.keyInput;
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
		await renderer.renderOnce();
	});
}

async function waitForFrame(
	renderer: RenderedApp,
	predicate: (frame: string) => boolean
): Promise<string> {
	let frame = renderer.captureCharFrame();
	// Finished transcript markdown paints after async highlighting, so poll a
	// bounded real deadline rather than a count of zero-delay passes.
	const deadline = performance.now() + 3000;
	await act(async () => {
		while (!predicate(frame) && performance.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await renderer.renderOnce();
			frame = renderer.captureCharFrame();
		}
	});
	if (!predicate(frame)) {
		throw new Error(`Chat render did not reach the expected state:\n${frame}`);
	}
	return frame;
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
	renderer: RenderedApp,
	value: string
): Promise<void> {
	await act(async () => {
		await renderer.mockInput.typeText(value);
	});
	await renderer.flush({ maxPasses: 12 });
	await act(async () => {
		renderer.mockInput.pressEnter();
	});
	await renderer.renderOnce();
	if (needsSecondEnter(value)) {
		await renderer.flush({ maxPasses: 12 });
		await act(async () => {
			renderer.mockInput.pressEnter();
		});
		await renderer.renderOnce();
	}
}

function streamResponse(): Response {
	return new Response(`data: ${JSON.stringify({ type: "finish" })}\n\n`, {
		headers: { "content-type": "text/event-stream" },
		status: 200,
	});
}

const AGENT_FIXTURES = {
	agents: [
		{ id: "agent-alpha", name: "Alpha Agent" },
		{ id: "agent-beta", name: "Beta Agent" },
	],
};

const TEAM_FIXTURES = {
	teams: [
		{
			id: "team-research",
			name: "Research group",
			coordination: "round-robin",
			members: ["agent-alpha"],
		},
		{
			id: "team-review",
			name: "Review group",
			coordination: "debate-synthesis",
			members: ["agent-beta"],
		},
	],
};

test("Bot hides agent/group targeting and pins the actual chat request to Ryu", async () => {
	configureMode("bot");
	const chatPosts: ChatRequestObservation[] = [];
	let agentCatalogRequests = 0;
	let teamCatalogRequests = 0;
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/auth/status") {
			return Response.json({ authenticated: false, token: null });
		}
		if (url.pathname === "/api/agents") {
			agentCatalogRequests += 1;
			return Response.json(AGENT_FIXTURES);
		}
		if (url.pathname === "/api/teams") {
			teamCatalogRequests += 1;
			return Response.json(TEAM_FIXTURES);
		}
		if (url.pathname === "/api/chat/stream" && init?.method === "POST") {
			chatPosts.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init.body)))
			);
			return streamResponse();
		}
		return Response.json({});
	});

	const renderer = await renderApp();
	const initial = await waitForFrame(
		renderer,
		(frame) =>
			frame.includes("route agent:ryu") && frame.includes("Chat with Ryu")
	);
	expect(initial).toContain("pinned to Ryu");
	expect(initial).not.toContain("Ctrl+A pick agent");
	const initialAgentRequests = agentCatalogRequests;
	const initialTeamRequests = teamCatalogRequests;

	await press(renderer, { ctrl: true, name: "a" });
	let frame = await waitForFrame(renderer, (candidate) =>
		candidate.includes("pinned to Ryu")
	);
	expect(frame).not.toContain("Select agent");
	expect(agentCatalogRequests).toBe(initialAgentRequests);

	await typeAndSubmit(renderer, "/gr");
	frame = await waitForFrame(renderer, (candidate) =>
		candidate.includes("route agent:ryu")
	);
	expect(frame).not.toContain("route turns to a group");
	await typeAndSubmit(renderer, "/agent");
	await typeAndSubmit(renderer, "/group team-review");
	await typeAndSubmit(renderer, "/team team-review");
	await typeAndSubmit(renderer, "/group");
	frame = await waitForFrame(renderer, (candidate) =>
		candidate.includes("route agent:ryu")
	);
	expect(frame).not.toContain("Select agent");
	expect(frame).not.toContain("Select group");
	expect(teamCatalogRequests).toBe(initialTeamRequests);

	// Bare /help opens the shortcuts overlay; its command list follows the mode.
	await typeAndSubmit(renderer, "/help");
	await waitForFrame(renderer, (candidate) =>
		candidate.includes("Filter shortcuts and commands")
	);
	await act(async () => {
		await renderer.mockInput.typeText("/");
	});
	const botHelp = await waitForFrame(renderer, (candidate) =>
		candidate.includes("/check")
	);
	expect(botHelp).not.toContain("/group");
	expect(botHelp).not.toContain("/agent");
	await press(renderer, { name: "escape" });
	await press(renderer, { ctrl: true, name: "?" });
	const botKeymap = await waitForFrame(
		renderer,
		(candidate) =>
			candidate.includes("Keyboard shortcuts") && candidate.includes("Ctrl+?")
	);
	// "Ctrl+Alt+S" also starts with "Ctrl+A", so assert on the Ctrl+A row label.
	expect(botKeymap).not.toContain("choose agent");
	expect(botKeymap).not.toContain("switch node");
	// The keymap modal scrolls; its later groups still omit agent targeting.
	for (let page = 0; page < 6; page += 1) {
		await press(renderer, { name: "pagedown" });
	}
	const botKeymapEnd = await waitForFrame(
		renderer,
		(candidate) =>
			candidate.includes("Keyboard shortcuts") && candidate.includes("/check")
	);
	expect(botKeymapEnd).not.toContain("choose agent");
	expect(botKeymapEnd).not.toContain("/agent");
	await press(renderer, { name: "escape" });

	await typeAndSubmit(renderer, "Use the Bot route");
	await waitForFrame(renderer, (candidate) =>
		candidate.includes("Use the Bot route")
	);
	for (let pass = 0; pass < 30 && chatPosts.length === 0; pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await renderer.renderOnce();
	}
	expect(chatPosts).toHaveLength(1);
	expect(chatPosts[0]).toMatchObject({
		agent_id: "ryu",
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "Use the Bot route" }],
			},
		],
	});
	expect("team_id" in (chatPosts[0] ?? {})).toBe(false);
});

test("Console retains agent selection and named group routing in chat requests", async () => {
	configureMode("console", "/chat");
	const chatPosts: ChatRequestObservation[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/agents") {
			return Response.json(AGENT_FIXTURES);
		}
		if (url.pathname === "/api/teams") {
			return Response.json(TEAM_FIXTURES);
		}
		if (url.pathname === "/api/chat/stream" && init?.method === "POST") {
			chatPosts.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init.body)))
			);
			return streamResponse();
		}
		return Response.json({});
	});

	const renderer = await renderApp();
	await waitForFrame(
		renderer,
		(frame) =>
			frame.includes("route auto") && frame.includes("Ctrl+A pick agent")
	);
	await press(renderer, { ctrl: true, name: "a" });
	await waitForFrame(renderer, (frame) => frame.includes("Select agent"));
	await press(renderer, { name: "down" });
	await press(renderer, { name: "return" });
	await typeAndSubmit(renderer, "Use the selected agent");
	await waitForFrame(renderer, (frame) =>
		frame.includes("Use the selected agent")
	);
	for (let pass = 0; pass < 30 && chatPosts.length < 1; pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await renderer.renderOnce();
	}

	await typeAndSubmit(renderer, "/group");
	await waitForFrame(renderer, (frame) => frame.includes("team-review"));
	await press(renderer, { name: "down" });
	await press(renderer, { name: "return" });
	await waitForFrame(renderer, (frame) => frame.includes("team:team-review"));
	await typeAndSubmit(renderer, "Use the selected group");
	await waitForFrame(renderer, (frame) =>
		frame.includes("Use the selected group")
	);
	for (let pass = 0; pass < 30 && chatPosts.length < 2; pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await renderer.renderOnce();
	}

	expect(chatPosts).toHaveLength(2);
	expect(chatPosts[0]).toMatchObject({ agent_id: "agent-beta" });
	expect("team_id" in (chatPosts[0] ?? {})).toBe(false);
	expect(chatPosts[1]).toMatchObject({ team_id: "team-review" });
	expect("agent_id" in (chatPosts[1] ?? {})).toBe(false);
});
