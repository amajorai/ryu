import { expect, test } from "bun:test";
import type { z } from "zod";
import {
	fetchRuns,
	loadRetryCandidates,
	RECONNECT_RETRY_TTL_MS,
} from "../reconnect-retry.ts";
import {
	runStreamFrameSchema,
	runSummarySchema,
} from "./run-wire-contracts.ts";
import { type RunStreamFrame, streamRuns } from "./runStream.ts";

const run = {
	agent_id: null,
	branch: null,
	created_at: 1,
	folder_path: null,
	id: "run",
	message_count: 2,
	run_status: "future-status",
	title: null,
	updated_at: 2,
	worktree_path: null,
	archived: false,
	pinned: true,
	visibility: "future-visibility",
	thread_role: "future-role",
	participants: ["agent"],
	owner_kind: "future-owner",
	project_id: null,
	future: JSON.parse('{"__proto__":{"retained":true}}'),
} satisfies z.output<typeof runSummarySchema>;

test("complete run records keep future metadata and reject malformed known fields", () => {
	expect(runSummarySchema.parse(run)).toBe(run);
	expect(runSummarySchema.safeParse({ ...run, created_at: "1" }).success).toBe(
		false
	);
	expect(runSummarySchema.safeParse({ ...run, pinned: "true" }).success).toBe(
		false
	);
	expect(runSummarySchema.safeParse({ ...run, project_id: 12 }).success).toBe(
		false
	);
	const frame = {
		type: "snapshot",
		runs: [run],
		future: { revision: 3 },
	} satisfies z.output<typeof runStreamFrameSchema>;
	const decoded = runStreamFrameSchema.parse(frame);
	expect(decoded).toBe(frame);
	if (decoded.type !== "snapshot") {
		throw new Error("Expected a snapshot frame");
	}
	expect(decoded.runs).toBe(frame.runs);
	expect(
		runStreamFrameSchema.safeParse({ type: "run", run: { ...run, id: null } })
			.success
	).toBe(false);
});

test("real run HTTP and SSE boundaries filter malformed data and preserve valid records", async () => {
	let rejectRuns = false;
	const authorization: (string | null)[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			authorization.push(request.headers.get("authorization"));
			if (new URL(request.url).pathname.endsWith("/stream")) {
				const frames = [
					{ type: "run", run: { ...run, id: 3 } },
					{ type: "snapshot", runs: [run] },
					{ type: "run", run: { ...run, run_status: "completed" } },
				];
				return new Response(
					frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
					{ headers: { "content-type": "text/event-stream" } }
				);
			}
			return rejectRuns
				? new Response("unavailable", { status: 503 })
				: Response.json({ runs: [run, null, { ...run, message_count: "2" }] });
		},
	});
	try {
		const target = { url: server.url.href, token: "node", userJwt: "identity" };
		expect(await fetchRuns(target)).toEqual([run]);
		const frames: RunStreamFrame[] = [];
		await streamRuns(
			target,
			(frame) => frames.push(frame),
			new AbortController().signal
		);
		expect(frames).toEqual([
			{ type: "snapshot", runs: [run] },
			{ type: "run", run: { ...run, run_status: "completed" } },
		]);
		rejectRuns = true;
		await expect(fetchRuns(target)).rejects.toThrow("run snapshot failed: 503");
		expect(authorization).toEqual([
			"Bearer node",
			"Bearer node",
			"Bearer node",
		]);
	} finally {
		server.stop(true);
	}
});

test("saved retry queues keep their null-row fallback and filter invalid non-null records", () => {
	const values = new Map<string, string>();
	const storage = {
		get length() {
			return values.size;
		},
		clear() {
			values.clear();
		},
		getItem(key: string) {
			return values.get(key) ?? null;
		},
		key(index: number) {
			return [...values.keys()][index] ?? null;
		},
		removeItem(key: string) {
			values.delete(key);
		},
		setItem(key: string, value: string) {
			values.set(key, value);
		},
	} satisfies Storage;
	const descriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage"
	);
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
	});
	try {
		const valid = {
			attempts: 0,
			capturedAt: Date.now() - 1000,
			conversationId: " run ",
		};
		storage.setItem("queue", JSON.stringify([valid, null]));
		expect(loadRetryCandidates("queue")).toEqual([]);
		storage.setItem(
			"queue",
			JSON.stringify([
				valid,
				{},
				{ ...valid, capturedAt: valid.capturedAt - RECONNECT_RETRY_TTL_MS },
				{ ...valid, attempts: 0.5 },
			])
		);
		expect(loadRetryCandidates("queue")).toEqual([valid]);
		storage.setItem("queue", "invalid");
		expect(loadRetryCandidates("queue")).toEqual([]);
	} finally {
		if (descriptor) {
			Object.defineProperty(globalThis, "localStorage", descriptor);
		} else {
			Reflect.deleteProperty(globalThis, "localStorage");
		}
	}
});
