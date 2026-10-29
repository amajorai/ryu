import { afterAll, expect, test } from "bun:test";
import {
	type ChatCheckpoint,
	type CheckpointRestoreResult,
	fetchCheckpointChanges,
	listChatCheckpoints,
	restoreChatCheckpoint,
} from "./chat-checkpoints.ts";

// The rewind client against a real HTTP listener answering Core's checkpoint
// routes, so a body decoded by `readJsonBody` is checked end to end.
const checkpoint: ChatCheckpoint = {
	createdAt: "2026-10-12T00:00:00.000Z",
	hasFiles: true,
	id: "cp-1",
	kind: "turn",
	messageId: "m-1",
	preview: "Fix the bug",
	skipReason: null,
	workspace: "/work",
};
const replies = new Map<string, { status: number; body: string }>();
const seen: { method: string; path: string; body: string }[] = [];

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		seen.push({
			body: await request.text(),
			method: request.method,
			path: url.pathname,
		});
		const reply = replies.get(`${request.method} ${url.pathname}`);
		if (!reply) {
			return new Response("unexpected route", { status: 599 });
		}
		return new Response(reply.body, {
			headers: { "content-type": "application/json" },
			status: reply.status,
		});
	},
});
afterAll(() => server.stop(true));

const target = { token: "checkpoint-token", url: server.url.origin };
const base = "/api/conversations/conv%201/checkpoints";

test("lists, diffs and restores checkpoints from Core's JSON replies", async () => {
	replies.set(`GET ${base}`, {
		body: JSON.stringify({ checkpoints: [checkpoint] }),
		status: 200,
	});
	replies.set(`GET ${base}/cp-1/changes`, {
		body: JSON.stringify({
			changes: [{ kind: "modified", path: "src/main.rs" }],
			workspace: "/work",
		}),
		status: 200,
	});
	const restored: CheckpointRestoreResult = {
		conversation: null,
		files: {
			removed: [],
			restored: ["src/main.rs"],
			skipped: [],
			undoCheckpoint: { ...checkpoint, id: "undo", kind: "preRestore" },
		},
	};
	replies.set(`POST ${base}/cp-1/restore`, {
		body: JSON.stringify(restored),
		status: 200,
	});

	expect(await listChatCheckpoints(target, "conv 1")).toEqual([checkpoint]);
	expect(await fetchCheckpointChanges(target, "conv 1", "cp-1")).toEqual([
		{ kind: "modified", path: "src/main.rs" },
	]);
	expect(await restoreChatCheckpoint(target, "conv 1", "cp-1", "code")).toEqual(
		restored
	);
	expect(seen.at(-1)).toEqual({
		body: JSON.stringify({ mode: "code" }),
		method: "POST",
		path: `${base}/cp-1/restore`,
	});
});

test("a reply outside the checkpoint contract or a Core error is reported, never returned", async () => {
	replies.set(`GET ${base}`, {
		body: JSON.stringify({ checkpoints: [{ id: "cp-1" }] }),
		status: 200,
	});
	await expect(listChatCheckpoints(target, "conv 1")).rejects.toThrow(
		"checkpoints returned an invalid response."
	);
	replies.set(`GET ${base}/cp-1/changes`, {
		body: JSON.stringify({ error: "checkpoint not found" }),
		status: 404,
	});
	await expect(
		fetchCheckpointChanges(target, "conv 1", "cp-1")
	).rejects.toThrow("checkpoint not found");
	replies.set(`POST ${base}/cp-1/restore`, { body: "", status: 200 });
	await expect(
		restoreChatCheckpoint(target, "conv 1", "cp-1", "conversation")
	).rejects.toThrow("invalid checkpoint restore response");
});
