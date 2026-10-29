/* @jsxImportSource @opentui/react */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";

const chatBodyStringSchema = z.string({
	error: "Expected a primitive request-body string",
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { App } from "../App.tsx";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import { testRender } from "./cli-test-render.ts";
import {
	credentialFreeCoreProbe,
	useFetchBackedLoopback,
} from "./core-identity-fixture.ts";

const target = {
	url: "http://127.0.0.1:7980",
	token: "isolated-node-admission",
};
const realFetch = globalThis.fetch;

// The node's loopback connections go to this file's fetch stub, not sockets.
let restoreLoopback: (() => void) | null = null;
beforeAll(() => {
	restoreLoopback = useFetchBackedLoopback();
});
afterAll(() => {
	restoreLoopback?.();
});
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let home: string | undefined;
let rendered: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => {
	await act(async () => {
		rendered?.renderer.destroy();
	});
	rendered = undefined;
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
	if (home) {
		rmSync(home, { recursive: true, force: true });
	}
	home = undefined;
});
async function frameUntil(predicate: (frame: string) => boolean) {
	if (!rendered) {
		throw new Error("Missing CLI renderer");
	}
	const setup = rendered;
	let frame = setup.captureCharFrame();
	const deadline = performance.now() + 1500;
	while (!predicate(frame) && performance.now() < deadline) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await setup.renderOnce();
		});
		frame = setup.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`CLI resume did not reach expected state:\n${frame}`);
	}
	return frame;
}
async function submit(value: string) {
	if (!rendered) {
		throw new Error("Missing CLI renderer");
	}
	const setup = rendered;
	await act(async () => {
		await setup.mockInput.typeText(value);
	});
	await setup.flush({ maxPasses: 12 });
	await act(async () => {
		setup.mockInput.pressEnter();
	});
	await setup.renderOnce();
}

test.each([
	"success",
	"failure",
])("late resume %s cannot replace a newer conversation or its exact persisted stream/readback", async (lateResult) => {
	home = mkdtempSync(join(tmpdir(), "ryu-cli-resume-race-"));
	process.env.HOME = home;
	delete process.env.USERPROFILE;
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath(home)
	);
	let releaseOld = (_response: Response): void => {
		throw new Error("Old resume not requested");
	};
	const oldRead = new Promise<Response>((resolve) => {
		releaseOld = resolve;
	});
	const unknown: string[] = [];
	const sequence: string[] = [];
	const streamBodies: unknown[] = [];
	let currentReads = 0;
	const saved = {
		id: "resume-current",
		title: "Current conversation",
		messages: [
			{
				id: "current-message",
				role: "assistant",
				content: "CURRENT CONVERSATION REPLY",
			},
		],
	};
	const reads = new Map<string, unknown>([
		["/api/auth/status", { authenticated: false, token: null }],
		["/api/auth/accounts", { accounts: [], activeUserId: null }],
		["/api/health", { status: "ok" }],
		["/api/plugins", { apps: [] }],
		["/api/plugins/contributions", { views: [], slash_commands: [] }],
		["/api/agents", { agents: [] }],
		["/api/teams", { teams: [] }],
		["/api/spaces", { spaces: [] }],
		["/api/meetings", { meetings: [] }],
		["/api/conversations", { conversations: [] }],
		["/workflows", { workflows: [] }],
		["/api/preferences/terminal-theme", { value: JSON.stringify("dark") }],
		["/api/preferences/theme", { value: JSON.stringify("dark") }],
		[
			"/api/preferences/auto-updates",
			{ value: JSON.stringify({ enabled: false }) },
		],
		[
			"/api/update/check",
			{
				current: "0.4.0",
				latest: "0.4.0",
				update_available: false,
				html_url: null,
			},
		],
	]);
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const request = input instanceof Request ? input : null;
			const url = new URL(request?.url ?? String(input));
			const method = init?.method ?? request?.method ?? "GET";
			const headers = new Headers(init?.headers ?? request?.headers);
			const path = url.pathname;
			// A loopback Core is probed with no credential and must answer the
			// identity challenge before it is sent the node token.
			const probe = credentialFreeCoreProbe(url, method, headers, target);
			if (probe) {
				return probe;
			}
			if (
				url.origin !== target.url ||
				url.search ||
				headers.get("authorization") !== `Bearer ${target.token}` ||
				headers.get("x-ryu-user-jwt") !== null
			) {
				unknown.push(`${method} ${url.href}: incorrect transport/auth`);
				throw new Error("Unexpected resume fixture transport/auth");
			}
			if (method === "GET" && init?.body == null && request?.body == null) {
				if (path === "/api/conversations/resume-old") {
					sequence.push(`GET ${path}`);
					return await oldRead;
				}
				if (path === "/api/conversations/resume-current") {
					sequence.push(`GET ${path}`);
					currentReads += 1;
					if (currentReads === 2) {
						return Response.json(
							{ error: "temporary current conversation failure" },
							{ status: 503 }
						);
					}
					return Response.json(saved);
				}
				if (reads.has(path)) {
					return Response.json(reads.get(path));
				}
			}
			if (
				method === "POST" &&
				path === "/api/chat/stream" &&
				chatBodyStringSchema.safeParse(init?.body).success
			) {
				sequence.push(`POST ${path}`);
				const body = appResponseValueSchema.parse(
					JSON.parse(String(init?.body))
				);
				streamBodies.push(body);
				expect(body).toEqual({
					enable_long_term: false,
					conversation_id: "resume-current",
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text: "CURRENT CONVERSATION REPLY" }],
						},
						{
							role: "user",
							content: [
								{ type: "text", text: "Continue current conversation" },
							],
						},
					],
				});
				saved.messages.push(
					{
						id: "saved-user",
						role: "user",
						content: "Continue current conversation",
					},
					{
						id: "saved-assistant",
						role: "assistant",
						content: "PERSISTED CURRENT REPLY",
					}
				);
				return new Response(
					`data: ${JSON.stringify({ type: "text-delta", delta: "PERSISTED CURRENT REPLY" })}\n\ndata: ${JSON.stringify({ type: "finish" })}\n\n`,
					{ headers: { "content-type": "text/event-stream" } }
				);
			}
			// The composer seals its prompt history through the local Core; echo the
			// value back so the exchange under test is the only traffic it observes.
			if (
				method === "POST" &&
				(path === "/api/local-content/seal" ||
					path === "/api/local-content/open")
			) {
				const { value } = JSON.parse(String(init?.body ?? "{}")) as {
					value: string;
				};
				return Response.json(
					path.endsWith("/seal") ? { sealed: value } : { value }
				);
			}
			unknown.push(`${method} ${url.href}: unknown route/body`);
			throw new Error("Unexpected resume fixture route/body");
		},
		{ preconnect: realFetch.preconnect }
	);
	await act(async () => {
		rendered = await testRender(<App target={target} />, {
			width: 140,
			height: 40,
		});
		await rendered.renderOnce();
	});
	await frameUntil((frame) => frame.includes("Ask anything"));
	await submit("/resume resume-old");
	await frameUntil(() => sequence.length === 1);
	await submit("/resume resume-current");
	await frameUntil((frame) => frame.includes("CURRENT CONVERSATION REPLY"));
	await act(async () => {
		releaseOld(
			lateResult === "success"
				? Response.json({
						id: "resume-old",
						title: "Stale conversation",
						messages: [
							{
								id: "old-message",
								role: "assistant",
								content: "STALE CONVERSATION REPLY",
							},
						],
					})
				: Response.json({ error: "old request unavailable" }, { status: 503 })
		);
	});
	const retained = await frameUntil((frame) =>
		frame.includes("CURRENT CONVERSATION REPLY")
	);
	expect(retained).not.toContain("STALE CONVERSATION REPLY");
	expect(retained).not.toContain("conversation failed: 503");
	await submit("Continue current conversation");
	await frameUntil((frame) => frame.includes("PERSISTED CURRENT REPLY"));
	expect(streamBodies).toHaveLength(1);
	await submit("/resume resume-current");
	const currentFailure = await frameUntil(
		(frame) =>
			frame.includes("conversation failed: 503") && sequence.length === 4
	);
	expect(currentFailure).toContain("PERSISTED CURRENT REPLY");
	await submit("/resume resume-current");
	const readback = await frameUntil(
		(frame) =>
			frame.includes("PERSISTED CURRENT REPLY") && sequence.length === 5
	);
	expect(readback).toContain("Continue current conversation");
	expect(readback).not.toContain("STALE CONVERSATION REPLY");
	expect(saved.messages.map((message) => message.content)).toEqual([
		"CURRENT CONVERSATION REPLY",
		"Continue current conversation",
		"PERSISTED CURRENT REPLY",
	]);
	expect(sequence).toEqual([
		"GET /api/conversations/resume-old",
		"GET /api/conversations/resume-current",
		"POST /api/chat/stream",
		"GET /api/conversations/resume-current",
		"GET /api/conversations/resume-current",
	]);
	expect(currentReads).toBe(3);
	expect(unknown).toEqual([]);
});
