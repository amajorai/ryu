/* @jsxImportSource @opentui/react */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import { z } from "zod";
import { App } from "../App.tsx";
import {
	applyAutocomplete,
	commandSuggestions,
	getAutocompleteContext,
	runsOnEnter,
} from "../core/autocomplete.ts";
import { isContributedPluginCommand } from "../core/commands.ts";
import {
	contributedContentFromResponse,
	contributedSlashCommandsFromResponse,
} from "../core/contributions.ts";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import { testRender } from "./cli-test-render.ts";

// Complete payload published by core/chatStream.ts buildBody, retaining raw
// parsed JSON references and all unknown future fields after native JSON admission.
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

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
const servers: ReturnType<typeof Bun.serve>[] = [];
type ResponseProvider = (
	...args: Parameters<typeof realFetch>
) => Response | Promise<Response>;

function installResponse(provide: ResponseProvider): void {
	const pending = new Map<string, () => Response | Promise<Response>>();
	let nextRequestId = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const id = request.headers.get("x-ryu-fixture-request") ?? "";
			const respond = pending.get(id);
			pending.delete(id);
			if (!respond) {
				throw new Error("Unexpected conversation fixture request");
			}
			return respond();
		},
	});
	servers.push(server);
	globalThis.fetch = Object.assign(
		(
			input: Parameters<typeof realFetch>[0],
			init?: Parameters<typeof realFetch>[1]
		) => {
			const request = new Request(input, init);
			const id = String(nextRequestId++);
			pending.set(id, () => provide(input, init));
			const destination = new URL(request.url);
			destination.host = server.url.host;
			destination.protocol = server.url.protocol;
			const forwarded = new Request(destination, request);
			forwarded.headers.set("x-ryu-fixture-request", id);
			return realFetch(forwarded).finally(() => pending.delete(id));
		},
		{ preconnect: realFetch.preconnect }
	);
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

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(async () => {
	globalThis.fetch = realFetch;
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
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
	predicate: (frame: string) => boolean
): Promise<string> {
	let frame = setup.captureCharFrame();
	// Fixture replies cross a real loopback socket, active streams coalesce
	// redraws for 50 ms, and finished transcript markdown paints after async
	// highlighting, so a fixed count of zero-delay polls can finish before the
	// reply or its first production redraw. Poll a bounded real deadline.
	const deadline = performance.now() + 3000;
	while (!predicate(frame) && performance.now() < deadline) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await setup.renderOnce();
		});
		frame = setup.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Contributed command render did not match: ${frame}`);
	}
	return frame;
}

function currentEditorValue(
	setup: Awaited<ReturnType<typeof testRender>>
): string {
	// The composer textarea exposes the native EditBuffer plainText getter.
	return setup.renderer.currentFocusedEditor?.plainText ?? "";
}

async function typeText(
	setup: Awaited<ReturnType<typeof testRender>>,
	value: string
): Promise<void> {
	await act(async () => {
		await setup.mockInput.typeText(value);
	});
	await setup.flush({ maxPasses: 20 });
}

async function typeAndSubmit(
	setup: Awaited<ReturnType<typeof testRender>>,
	value: string
): Promise<void> {
	await typeText(setup, value);
	await press(setup, { name: "return" });
	const name = value.trim().slice(1);
	// A bare no-argument built-in runs on the first Enter; others complete first.
	if (
		value.trim().startsWith("/") &&
		!name.includes(" ") &&
		!runsOnEnter(value, { description: "", kind: "command", name })
	) {
		await press(setup, { name: "return" });
	}
}

test("Core contributed slash commands validate and never shadow local commands", () => {
	const payload = {
		slash_commands: [
			{
				command: "/advisor",
				description: "Review this approach",
				plugin: "@ryu/advisor",
			},
			{
				command: "/goal",
				description: "Plugin duplicate",
				plugin: "@ryu/goal",
			},
			{ command: "/bad name", plugin: "@ryu/bad" },
			{ command: 7, plugin: "@ryu/bad" },
			{ command: "/unowned", description: "No plugin or body" },
			{ body: "Draft a release summary", command: "/release-note" },
		],
		views: [{ id: "surface:tasks", view: "list" }],
	};
	const commands = contributedSlashCommandsFromResponse(payload);
	expect(commands.map(({ name }) => name)).toEqual([
		"advisor",
		"goal",
		"release-note",
	]);
	expect(contributedContentFromResponse(payload).views).toHaveLength(1);
	expect(commandSuggestions("g", commands).map(({ name }) => name)).toEqual([
		"group",
		"goal",
	]);
	expect(commandSuggestions("adv", commands)).toEqual([
		{
			description: "Review this approach",
			kind: "command",
			name: "advisor",
		},
	]);
	const template = commandSuggestions("release", commands)[0];
	const releaseContext = getAutocompleteContext("/release");
	if (!releaseContext) {
		throw new Error("Expected release command autocomplete context");
	}
	expect(
		template && applyAutocomplete("/release", releaseContext, template)
	).toBe("Draft a release summary");
	expect(
		isContributedPluginCommand("/advisor is this the right approach?", commands)
	).toBe(true);
	expect(isContributedPluginCommand("/goal verify this", commands)).toBe(false);
	expect(isContributedPluginCommand("/unlisted command", commands)).toBe(false);
});

test("CLI retries the plugin command catalog, selects by keyboard, and sends the exact command text to Core", async () => {
	let contributionRequests = 0;
	const chatBodies: ChatRequestObservation[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/plugins/contributions") {
			contributionRequests += 1;
			if (contributionRequests === 1) {
				return new Response("temporary Core error", { status: 503 });
			}
			return Response.json({
				slash_commands: [
					{
						command: "/advisor",
						description: "Ask a stronger advisor to review the conversation.",
						plugin: "@ryu/advisor",
					},
					{
						command: "/goal",
						description: "Set a completion condition.",
						plugin: "@ryu/goal",
					},
				],
			});
		}
		if (url.pathname === "/api/chat/stream") {
			chatBodies.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init?.body)))
			);
			if (chatBodies.length === 1) {
				return new Response("temporarily unavailable", { status: 503 });
			}
			return new Response(
				[
					`data: ${JSON.stringify({ type: "text-delta", delta: "Advice: validate the assumptions first." })}`,
					`data: ${JSON.stringify({ type: "finish" })}`,
					"",
				].join("\n"),
				{ headers: { "content-type": "text/event-stream" } }
			);
		}
		return Response.json({});
	});

	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	const setup = testSetup;
	await setup.renderOnce();
	await act(async () => {
		await setup.mockInput.typeText("/a");
	});
	await setup.flush({ maxPasses: 20 });
	await waitForFrame(setup, (frame) =>
		frame.includes("Retry contributed commands")
	);

	await press(setup, { name: "down" });
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("/advisor"));
	expect(contributionRequests).toBe(2);

	// Name-prefix hits (`/agent`, `/advisor`) rank above the `/acp` alias of
	// `/config`.
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	expect(currentEditorValue(setup)).toBe("/advisor ");
	await act(async () => {
		await setup.mockInput.typeText("review this approach");
	});
	await press(setup, { name: "return" });
	const failedTurn = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("HTTP 503") &&
			frame.includes("/advisor review this approach")
	);
	expect(failedTurn).toContain("/advisor review this approach");
	expect(chatBodies[0]?.messages).toEqual([
		{
			role: "user",
			content: [{ type: "text", text: "/advisor review this approach" }],
		},
	]);
	expect(chatBodies[0]?.conversation_id).toEqual(expect.any(String));

	await act(async () => {
		await setup.mockInput.typeText("/advisor review this approach");
	});
	await press(setup, { name: "return" });
	const completed = await waitForFrame(setup, (frame) =>
		frame.includes("Advice: validate the assumptions first.")
	);
	expect(completed).toContain("Advice: validate the assumptions first.");
	// The failed turn renders as an inline error row; its empty assistant
	// message is dropped from history so the error never reaches the model.
	expect(failedTurn).toContain("Error: HTTP 503 · temporarily unavailable");
	expect(failedTurn).toContain("edit & resend · /model switch");
	expect(JSON.stringify(chatBodies[1])).not.toContain("[error:");
	expect(JSON.stringify(chatBodies[1])).not.toContain("HTTP 503");
	expect(chatBodies[1]?.messages).toEqual([
		{
			role: "user",
			content: [{ type: "text", text: "/advisor review this approach" }],
		},
		{
			role: "user",
			content: [{ type: "text", text: "/advisor review this approach" }],
		},
	]);
});

test("structured plugin choices advance arguments and retry the exact team-routed command", async () => {
	const chatBodies: ChatRequestObservation[] = [];
	let chatAttempts = 0;
	// While `holdTeams` is set, Core's group list waits for `teamsGate`, so the
	// picker's loading state lasts exactly as long as this test needs it to.
	const teamsGate = Promise.withResolvers<void>();
	let holdTeams = false;
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/plugins/contributions") {
			return Response.json({
				slash_commands: [
					{
						args: [
							{
								name: "environment",
								options: [
									{ label: "Staging", value: "staging" },
									{ label: "Production", value: "production" },
								],
							},
							{
								allow_custom: true,
								name: "version",
								options: [{ label: "Latest", value: "latest" }],
							},
						],
						command: "/shipit",
						description: "Deploy a release",
						plugin: "@ryu/deploy",
					},
				],
			});
		}
		if (url.pathname === "/api/teams") {
			if (holdTeams) {
				await teamsGate.promise;
			}
			return Response.json({
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
						members: ["agent-reviewer"],
					},
				],
			});
		}
		if (url.pathname === "/api/chat/stream" && init?.method === "POST") {
			chatAttempts += 1;
			chatBodies.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init.body)))
			);
			if (chatAttempts === 1) {
				return new Response("temporary Core outage", { status: 503 });
			}
			return new Response(
				[
					`data: ${JSON.stringify({ type: "text-delta", delta: "Deployment accepted." })}`,
					`data: ${JSON.stringify({ type: "finish" })}`,
					"",
				].join("\n"),
				{ headers: { "content-type": "text/event-stream" } }
			);
		}
		return Response.json({});
	});

	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 150,
		height: 40,
	});
	const setup = testSetup;
	await setup.renderOnce();
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	holdTeams = true;
	await typeAndSubmit(setup, "/group");
	await waitForFrame(setup, (frame) => frame.includes("Loading groups"));
	// The picker ignores keys until Core's group list arrives, so neither key
	// chooses a group while it is still loading.
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	const loading = await waitForFrame(setup, (frame) =>
		frame.includes("Loading groups")
	);
	expect(loading).toContain("route auto");
	teamsGate.resolve();
	// The sidebar already lists the same group names, so a name alone does not
	// show the picker has loaded; its rows also carry the group id as an
	// accessory, which only the loaded picker renders.
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Select group") && /Review group\s+team-review/.test(frame)
	);
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("team:team-review"));

	await typeText(setup, "/ship");
	await waitForFrame(setup, (frame) =>
		/\/shipit\s+Deploy a release\s+plugin/.test(frame)
	);
	await press(setup, { name: "return" });
	await waitForFrame(
		setup,
		(frame) => frame.includes("Staging") && frame.includes("Production")
	);
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	expect(currentEditorValue(setup)).toBe("/shipit production ");
	await waitForFrame(setup, (frame) => frame.includes("Latest"));
	await typeText(setup, "2.4.0");
	await waitForFrame(setup, (frame) => frame.includes('Use "2.4.0"'));
	await press(setup, { name: "return" });
	expect(currentEditorValue(setup)).toBe("/shipit production 2.4.0");
	await press(setup, { name: "return" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("HTTP 503") && frame.includes("/shipit production 2.4.0")
	);
	expect(chatBodies).toHaveLength(1);
	expect(chatBodies[0]).toMatchObject({
		team_id: "team-review",
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "/shipit production 2.4.0" }],
			},
		],
	});
	expect("agent_id" in (chatBodies[0] ?? {})).toBe(false);

	await typeText(setup, "/shipit production 2.4.0");
	await waitForFrame(setup, (frame) => frame.includes('Use "2.4.0"'));
	await press(setup, { name: "return" });
	await press(setup, { name: "return" });
	const completed = await waitForFrame(setup, (frame) =>
		frame.includes("Deployment accepted.")
	);
	expect(completed).toContain("Deployment accepted.");
	expect(chatBodies).toHaveLength(2);
	expect(chatBodies[1]?.team_id).toBe("team-review");
	expect("agent_id" in (chatBodies[1] ?? {})).toBe(false);
	expect(chatBodies[1]?.conversation_id).toBe(chatBodies[0]?.conversation_id);
	expect(chatBodies[1]?.messages.at(-1)).toEqual({
		role: "user",
		content: [{ type: "text", text: "/shipit production 2.4.0" }],
	});
});

test("ACP advertised slash commands submit through their agent and replace on an empty update", async () => {
	const chatBodies: ChatRequestObservation[] = [];
	let chatAttempts = 0;
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/agents") {
			return Response.json({
				agents: [
					{ id: "agent-alpha", name: "Alpha Agent" },
					{ id: "agent-reviewer", name: "Review Agent" },
				],
			});
		}
		if (url.pathname === "/api/plugins/contributions") {
			return Response.json({ slash_commands: [] });
		}
		if (url.pathname === "/api/chat/stream" && init?.method === "POST") {
			chatAttempts += 1;
			chatBodies.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init.body)))
			);
			if (chatAttempts === 1) {
				return new Response(
					[
						`data: ${JSON.stringify({
							type: "data-ryu-acp-commands",
							data: {
								commands: [
									{
										name: "acp-review",
										description: "Review using the active ACP agent.",
										hint: "changes",
									},
								],
							},
						})}`,
						`data: ${JSON.stringify({ type: "text-delta", delta: "ACP command ready." })}`,
						`data: ${JSON.stringify({ type: "finish" })}`,
						"",
					].join("\n"),
					{ headers: { "content-type": "text/event-stream" } }
				);
			}
			if (chatAttempts === 2) {
				return new Response("temporary ACP route failure", { status: 503 });
			}
			return new Response(
				[
					`data: ${JSON.stringify({
						type: "data-ryu-acp-commands",
						data: { commands: [] },
					})}`,
					`data: ${JSON.stringify({ type: "text-delta", delta: "Review complete." })}`,
					`data: ${JSON.stringify({ type: "finish" })}`,
					"",
				].join("\n"),
				{ headers: { "content-type": "text/event-stream" } }
			);
		}
		return Response.json({});
	});

	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 150,
		height: 40,
	});
	const setup = testSetup;
	await setup.renderOnce();
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await press(setup, { ctrl: true, name: "a" });
	await waitForFrame(setup, (frame) => frame.includes("Select agent"));
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("agent:agent-reviewer"));

	await typeAndSubmit(setup, "Start ACP session");
	await waitForFrame(setup, (frame) => frame.includes("ACP command ready."));
	expect(currentEditorValue(setup)).toBe("");
	expect(chatBodies[0]?.agent_id).toBe("agent-reviewer");
	expect("team_id" in (chatBodies[0] ?? {})).toBe(false);

	await typeText(setup, "/acp");
	expect(currentEditorValue(setup)).toBe("/acp");
	const advertised = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("/acp-review") && /\/acp-review\s.*\sACP/.test(frame)
	);
	expect(advertised).toContain("Review using the active ACP agent.");
	// `/acp` is an exact alias of `/config`, which ranks first; the advertised
	// command is the next row.
	expect(advertised.indexOf("/config")).toBeLessThan(
		advertised.indexOf("/acp-review")
	);
	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	expect(currentEditorValue(setup)).toBe("/acp-review ");
	await typeText(setup, "check the staged change");
	await press(setup, { name: "return" });
	const failed = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("HTTP 503") &&
			frame.includes("/acp-review check the staged change")
	);
	expect(failed).toContain("HTTP 503");
	expect(chatBodies[1]?.agent_id).toBe("agent-reviewer");
	expect("team_id" in (chatBodies[1] ?? {})).toBe(false);
	expect(chatBodies[1]?.messages.at(-1)).toEqual({
		role: "user",
		content: [{ type: "text", text: "/acp-review check the staged change" }],
	});

	await typeAndSubmit(setup, "/acp-review check the staged change");
	const completed = await waitForFrame(setup, (frame) =>
		frame.includes("Review complete.")
	);
	expect(completed).toContain("Review complete.");
	expect(chatBodies).toHaveLength(3);
	expect(chatBodies[2]?.agent_id).toBe("agent-reviewer");
	expect("team_id" in (chatBodies[2] ?? {})).toBe(false);
	expect(chatBodies[2]?.messages.at(-1)).toEqual({
		role: "user",
		content: [{ type: "text", text: "/acp-review check the staged change" }],
	});

	await typeText(setup, "/acp");
	const cleared = await waitForFrame(setup, (frame) => frame.includes("/acp"));
	expect(cleared).not.toContain("Review using the active ACP agent.");
});
