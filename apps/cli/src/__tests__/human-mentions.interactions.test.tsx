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

// Complete method/args payload published by core/humanMentions notifyMentionedUsers.
const notificationFieldsSchema = z.looseObject({
	method: z.literal("notifications.send"),
	args: z.looseObject({
		body: z.string(),
		target_user_id: z.string(),
		title: z.string(),
	}),
});
type NotificationRequestObservation = z.infer<typeof notificationFieldsSchema>;
const notificationRequestObservationSchema =
	z.custom<NotificationRequestObservation>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			notificationFieldsSchema.safeParse(value).success
	);
/** A completion row: the visible name, then the right-aligned kind tag. */
const PERSON_ROW = /@Ada Lovelace\s+person/;
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
const TARGET = { url: "http://127.0.0.1:7980", token: null };
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

async function press(
	setup: Awaited<ReturnType<typeof testRender>>,
	name: string
): Promise<void> {
	const keyInput = setup.renderer.keyInput;
	await act(async () => {
		keyInput.emit(
			"keypress",
			new KeyEvent({
				name,
				sequence: name.length === 1 ? name : "",
				ctrl: false,
				shift: false,
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
	await act(async () => {
		while (!predicate(frame) && performance.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await setup.renderOnce();
			frame = setup.captureCharFrame();
		}
	});
	if (!predicate(frame)) {
		throw new Error(`TUI did not render the expected state: ${frame}`);
	}
	return frame;
}

function appWire(enabled: boolean) {
	return {
		built_in: true,
		companion: { icon: null, label: "Inbox", shortcut: null },
		enabled,
		id: "@ryu/approvals",
		installed: true,
		installed_version: "1.0.0",
		local_only: false,
		name: "Approvals",
		permission_grants: ["notifications:send-to-user"],
		runnables: [],
		sidecar_name: null,
		surfaces: {},
		targets: ["cli"],
		version: "1.0.0",
		windows_first: false,
	};
}

function accountsWire() {
	return {
		activeUserId: "sender-id",
		accounts: [
			{
				userId: "sender-id",
				name: "Ryu User",
				email: "ryu@example.test",
			},
		],
	};
}

function streamResponse(reply = "Reply") {
	return new Response(
		[
			`data: ${JSON.stringify({ type: "text-delta", delta: reply })}`,
			`data: ${JSON.stringify({ type: "finish" })}`,
			"",
		].join("\n"),
		{ status: 200, headers: { "content-type": "text/event-stream" } }
	);
}

test("CLI chat completes a human mention, sends to Core, and reports recipient permission failures", async () => {
	const chatBodies: ChatRequestObservation[] = [];
	const hostBodies: NotificationRequestObservation[] = [];
	let hostStatus = 403;
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/auth/accounts") {
			return Response.json(accountsWire());
		}
		if (url.pathname === "/api/agents") {
			return Response.json({ agents: [] });
		}
		if (url.pathname === "/api/plugins") {
			return Response.json({ apps: [appWire(true)] });
		}
		if (url.pathname === "/api/notifications/mention-targets") {
			return Response.json({
				users: [
					{
						userId: "ada-id",
						name: "Ada Lovelace",
						email: "ada@example.test",
					},
					{
						userId: "sender-id",
						name: "Ryu User",
						email: "ryu@example.test",
					},
				],
			});
		}
		if (url.pathname === "/workflows") {
			return Response.json({ workflows: [] });
		}
		if (url.pathname === "/api/notifications/stream") {
			return new Response(new ReadableStream({ start: () => undefined }), {
				headers: { "content-type": "text/event-stream" },
			});
		}
		if (url.pathname === "/api/chat/stream" && init?.method === "POST") {
			chatBodies.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init.body)))
			);
			return streamResponse("Reply");
		}
		if (url.pathname === "/api/plugins/%40ryu%2Fapprovals/host") {
			hostBodies.push(
				notificationRequestObservationSchema.parse(
					JSON.parse(String(init?.body))
				)
			);
			return hostStatus === 403
				? Response.json(
						{ error: { code: "denied", message: "notification grant denied" } },
						{ status: hostStatus }
					)
				: Response.json({ result: { notification_id: "mention-1" } });
		}
		return Response.json({});
	});

	testSetup = await testRender(<App target={TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await act(async () => {
		await setup.mockInput.typeText("Review @Ada");
	});
	const suggestionFrame = await waitForFrame(setup, (frame) =>
		PERSON_ROW.test(frame)
	);
	expect(suggestionFrame).not.toContain("@sender-id — Ryu User");
	await press(setup, "tab");
	const editor = setup.renderer.currentFocusedEditor;
	expect(editor?.plainText).toBe("Review @Ada Lovelace ");
	await act(async () => {
		await setup.mockInput.typeText("please review");
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, "return");
	await waitForFrame(setup, (frame) => frame.includes("Reply"));
	await waitForFrame(setup, (frame) =>
		frame.includes("Couldn't notify Ada Lovelace")
	);
	expect(chatBodies[0]?.messages).toEqual([
		{
			role: "user",
			content: [{ type: "text", text: "Review @Ada Lovelace please review" }],
		},
	]);
	expect(hostBodies).toEqual([
		{
			method: "notifications.send",
			args: {
				target_user_id: "ada-id",
				title: "Ryu User mentioned you",
				body: "Ryu User mentioned you in chat:\nReview @Ada Lovelace please review",
			},
		},
	]);

	hostStatus = 200;
	await act(async () => {
		await setup.mockInput.typeText("@Ada");
	});
	await waitForFrame(setup, (frame) => PERSON_ROW.test(frame));
	await press(setup, "tab");
	await act(async () => {
		await setup.mockInput.typeText("second pass");
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, "return");
	await waitForFrame(setup, (frame) => frame.includes("Reply"));
	await act(async () => {
		for (let pass = 0; pass < 40 && hostBodies.length < 2; pass += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await setup.renderOnce();
		}
	});
	expect(hostBodies).toHaveLength(2);
});

test("disabled Inbox hides human candidates and never sends a mention notification", async () => {
	const paths: string[] = [];
	const chatBodies: ChatRequestObservation[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		paths.push(url.pathname);
		if (url.pathname === "/api/auth/accounts") {
			return Response.json(accountsWire());
		}
		if (url.pathname === "/api/agents") {
			return Response.json({ agents: [] });
		}
		if (url.pathname === "/api/plugins") {
			return Response.json({ apps: [appWire(false)] });
		}
		if (url.pathname === "/workflows") {
			return Response.json({ workflows: [] });
		}
		if (url.pathname === "/api/notifications/stream") {
			return new Response(new ReadableStream({ start: () => undefined }), {
				headers: { "content-type": "text/event-stream" },
			});
		}
		if (url.pathname === "/api/chat/stream" && init?.method === "POST") {
			chatBodies.push(
				chatRequestObservationSchema.parse(JSON.parse(String(init.body)))
			);
			return streamResponse("Reply");
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	await waitForFrame(setup, (frame) => frame.includes("Ask anything"));
	await act(async () => {
		await setup.mockInput.typeText("Please review @Ada");
	});
	await act(async () => {
		for (let pass = 0; pass < 20; pass += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await setup.renderOnce();
		}
	});
	expect(setup.captureCharFrame()).not.toMatch(PERSON_ROW);
	await act(async () => setup.mockInput.pressEnter());
	await waitForFrame(setup, (frame) => frame.includes("Reply"));
	expect(chatBodies[0]?.messages).toEqual([
		{
			role: "user",
			content: [{ type: "text", text: "Please review @Ada" }],
		},
	]);
	expect(paths).not.toContain("/api/notifications/mention-targets");
	expect(paths).not.toContain("/api/plugins/%40ryu%2Fapprovals/host");
});

test("CLI shell renders a per-user notification once and rejects another recipient", async () => {
	let streamPath = "";
	const event = {
		title: "Ada mentioned you",
		body: "Please review this change.",
		level: "info",
		target_user_id: "sender-id",
		notification_id: "mention-1",
	};
	const frames = [{ ...event, target_user_id: "other-user" }, event, event].map(
		(value) => `data: ${JSON.stringify(value)}\n\n`
	);
	installResponse(async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/auth/accounts") {
			return Response.json(accountsWire());
		}
		if (url.pathname === "/api/notifications/stream") {
			streamPath = url.href;
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(frames.join("")));
						controller.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } }
			);
		}
		return Response.json({});
	});
	testSetup = await testRender(<App target={TARGET} />, {
		width: 140,
		height: 36,
	});
	await testSetup.renderOnce();
	const setup = testSetup;
	const frame = await waitForFrame(setup, (value) =>
		value.includes("Ada mentioned you")
	);
	expect(new URL(streamPath).searchParams.get("user_id")).toBe("sender-id");
	expect(frame.match(/Ada mentioned you/g)).toHaveLength(1);
	expect(frame).toContain("Please review this change.");
});
