/* @jsxImportSource @opentui/react */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import {
	type appRequestValueSchema,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import { z } from "zod";
import { App } from "../App.tsx";
import { runsOnEnter } from "../core/autocomplete.ts";
import {
	defaultProductModePreference,
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
let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(async () => {
	globalThis.fetch = realFetch;
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
	// Finished transcript markdown paints after async highlighting, so poll a
	// bounded real deadline rather than a count of zero-delay passes.
	const deadline = performance.now() + 3000;
	while (!predicate(frame) && performance.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
		frame = setup.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Chat render did not match: ${frame}`);
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

function jsonResponse(
	value: z.infer<typeof appRequestValueSchema>,
	status = 200
): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const TEAM_FIXTURES = {
	teams: [
		{
			id: "team-research",
			name: "Research group",
			coordination: "round-robin",
			members: ["agent-research"],
		},
		{
			id: "team-review",
			name: "Review group",
			coordination: "debate-synthesis",
			members: ["agent-review", "agent-editor"],
		},
	],
};

test("/group opens the named picker and selected team routes a real chat POST", async () => {
	const chatPosts: ChatRequestObservation[] = [];
	let teamListRequests = 0;
	installResponse(async (input, init) => {
		const url = String(input);
		if (url.endsWith("/api/teams")) {
			teamListRequests += 1;
			return jsonResponse(TEAM_FIXTURES);
		}
		if (url.endsWith("/api/chat/stream") && init?.method === "POST") {
			chatPosts.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init.body)))
			);
			return new Response(`data: ${JSON.stringify({ type: "finish" })}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}
		return jsonResponse({});
	});

	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	const setup = testSetup;
	await setup.renderOnce();
	const requestsBeforePicker = teamListRequests;
	await typeAndSubmit(setup, "/group");
	const picker = await waitForFrame(
		setup,
		(frame) => frame.includes("Select group") && frame.includes("Review group")
	);
	expect(picker).toContain("Research group");
	expect(teamListRequests).toBe(requestsBeforePicker + 1);

	await press(setup, { name: "down" });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("team:team-review"));
	await typeAndSubmit(setup, "Use the selected review group");
	await waitForFrame(setup, (frame) =>
		frame.includes("Use the selected review group")
	);
	for (let pass = 0; pass < 30 && chatPosts.length === 0; pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
	}
	expect(chatPosts).toHaveLength(1);
	expect(chatPosts[0]?.team_id).toBe("team-review");
	expect(chatPosts[0]?.agent_id).toBeUndefined();
});

test("/group shows a useful empty state and Escape closes the picker", async () => {
	installResponse(async (input) => {
		if (String(input).endsWith("/api/teams")) {
			return jsonResponse({ teams: [] });
		}
		return jsonResponse({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	const setup = testSetup;
	await setup.renderOnce();
	await typeAndSubmit(setup, "/group");
	const emptyState = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Select group") && frame.includes("No groups available")
	);
	expect(emptyState).toContain("Esc cancel");
	await press(setup, { name: "escape" });
	expect(
		await waitForFrame(setup, (frame) => !frame.includes("Select group"))
	).not.toContain("No groups available");
});

test("group catalog failures can be retried and dismissed with Escape", async () => {
	let teamListRequests = 0;
	let failNextTeamsRequest = false;
	installResponse(async (input) => {
		if (String(input).endsWith("/api/teams")) {
			teamListRequests += 1;
			if (failNextTeamsRequest) {
				failNextTeamsRequest = false;
				return jsonResponse({ error: "fixture unavailable" }, 503);
			}
			return jsonResponse(TEAM_FIXTURES);
		}
		return jsonResponse({});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	const setup = testSetup;
	await setup.renderOnce();
	for (let pass = 0; pass < 30 && teamListRequests === 0; pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
	}
	failNextTeamsRequest = true;
	await typeAndSubmit(setup, "/group");
	const errorState = await waitForFrame(
		setup,
		(frame) => frame.includes("Groups failed") && frame.includes("r retry")
	);
	expect(errorState).toContain("/api/teams failed: 503");
	await press(setup, { name: "r" });
	const retried = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Select group") && frame.includes("Research group")
	);
	expect(retried).toContain("Review group");
	expect(teamListRequests).toBeGreaterThanOrEqual(3);
	await press(setup, { name: "escape" });
	expect(
		await waitForFrame(
			setup,
			(frame) =>
				frame.includes("Ask anything") && !frame.includes("Select group")
		)
	).toContain("Ask anything");
});
