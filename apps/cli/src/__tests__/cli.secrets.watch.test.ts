// `ryu-cli secrets run --watch`: the command restarts on a vault change event
// with fresh values, a refused subscription never starts it, and a lost event
// stream stops it (fail closed). Core's SSE stream is a controllable fake.

import { expect, test } from "bun:test";
import { ApiError } from "@ryuhq/core-client/client";
import type { VaultEventMessage } from "@ryuhq/core-client/vault-events";
import { runWatching } from "../cli/secrets-watch.ts";
import type { ProcessRunner } from "../cli/types.ts";
import type { SignalGuard } from "../cli/vaultIsolation.ts";
import { fakeNode, json, jsonExport, runSecrets } from "./secrets-fixture.ts";

function sseStream(signal: AbortSignal | null | undefined) {
	const encoder = new TextEncoder();
	let push: (frame: string) => void = () => undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			push = (frame) => controller.enqueue(encoder.encode(frame));
			signal?.addEventListener("abort", () => controller.close(), {
				once: true,
			});
		},
	});
	return { body, push: (frame: string) => push(frame) };
}

/** A child that runs until its signal aborts, then exits 143. */
function blockingChild(signal: AbortSignal | undefined): Promise<number> {
	return new Promise((resolve) => {
		signal?.addEventListener("abort", () => resolve(143), { once: true });
	});
}

const KV_WRITE = {
	seq: 1,
	at: "2026-01-01T00:00:00Z",
	type: "kv-write",
	action: "secret.update",
	environment: "dev",
	path: "/",
	name: "API_KEY",
	version: 2,
};

test("run --watch restarts the command with fresh values after a change", async () => {
	let exports = 0;
	let pushEvent: (frame: string) => void = () => undefined;
	const node = fakeNode({
		"POST /api/vault/export": () => {
			exports += 1;
			return Response.json(jsonExport({ API_KEY: `v${exports}` }));
		},
	});
	const baseFetch = node.target.fetch;
	node.target.fetch = (input, init) => {
		if (new URL(String(input)).pathname === "/api/vault/events") {
			const stream = sseStream(init?.signal);
			pushEvent = stream.push;
			return Promise.resolve(new Response(stream.body));
		}
		return baseFetch?.(input, init) ?? Promise.reject(new Error("no fetch"));
	};
	const seen: string[] = [];
	const spawn: ProcessRunner = (_cmd, env, options) => {
		seen.push(env.API_KEY ?? "");
		if (seen.length === 1) {
			pushEvent(`event: vault\ndata: ${JSON.stringify(KV_WRITE)}\n\n`);
			return blockingChild(options?.signal);
		}
		return Promise.resolve(0);
	};
	const result = await runSecrets(
		["run", "--no-project", "--env", "dev", "--watch", "--", "node", "app.js"],
		node,
		{ spawn }
	);
	expect(result.code).toBe(0);
	expect(seen).toEqual(["v1", "v2"]);
	expect(result.err).toContain("vault values changed (API_KEY); restarting.");
	expect(result.err).not.toContain("v2");
});

test("run --watch never starts the command when Core refuses the event stream", async () => {
	const node = fakeNode({
		"GET /api/vault/events": () =>
			Response.json({ error: "forbidden" }, { status: 403 }),
		"POST /api/vault/export": json(jsonExport({ API_KEY: "v1" })),
	});
	let spawned = false;
	const result = await runSecrets(
		["run", "--no-project", "--watch", "--", "node"],
		node,
		{
			spawn: () => {
				spawned = true;
				return Promise.resolve(0);
			},
		}
	);
	expect(result.code).toBe(1);
	expect(spawned).toBe(false);
	expect(node.calls.map((call) => call.route)).not.toContain(
		"POST /api/vault/export"
	);
});

const quietGuard: SignalGuard = {
	abort: new AbortController().signal,
	dispose: () => undefined,
	forwardTo: () => undefined,
	throwIfCancelled: () => undefined,
};

async function* endsAtOnce(): AsyncGenerator<VaultEventMessage> {
	// Core closed the stream (for example, the caller's access was revoked).
}

test("a lost event stream stops the command and revokes its leases", async () => {
	let opens = 0;
	let cleanups = 0;
	let stopped = false;
	const code = await runWatching(
		{
			io: { out: () => undefined, err: () => undefined },
			spawn: (_cmd, _env, options) =>
				blockingChild(options?.signal).then((exit) => {
					stopped = true;
					return exit;
				}),
		},
		{
			command: ["node"],
			guard: quietGuard,
			timing: { debounceMs: 0, reconnectMs: [0] },
			events: () => {
				opens += 1;
				return opens === 1
					? Promise.resolve(endsAtOnce())
					: Promise.reject(new ApiError("/api/vault/events", 403, "forbidden"));
			},
			prepare: () =>
				Promise.resolve({
					env: {},
					leaseIds: new Set(["vl_1"]),
					cleanup: () => {
						cleanups += 1;
						return Promise.resolve();
					},
				}),
		}
	);
	expect(code).toBe(143);
	expect(stopped).toBe(true);
	expect(cleanups).toBe(1);
	expect(opens).toBe(2);
});

test("a revoked lease of the run restarts it; another lease does not", async () => {
	const frames: VaultEventMessage[] = [
		{
			kind: "event",
			event: {
				...KV_WRITE,
				type: "lease-revoke",
				name: undefined,
				leaseId: "vl_other",
			},
		},
		{
			kind: "event",
			event: {
				...KV_WRITE,
				type: "lease-expire",
				name: undefined,
				leaseId: "vl_1",
			},
		},
	];
	let runs = 0;
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	async function* stream(): AsyncGenerator<VaultEventMessage> {
		await gate;
		yield* frames;
		await new Promise(() => undefined);
	}
	let errors = "";
	const code = await runWatching(
		{
			io: {
				out: () => undefined,
				err: (text: string) => {
					errors += text;
				},
			},
			spawn: (_cmd, _env, options) => {
				runs += 1;
				if (runs === 1) {
					release();
					return blockingChild(options?.signal);
				}
				return Promise.resolve(0);
			},
		},
		{
			command: ["node"],
			guard: quietGuard,
			timing: { debounceMs: 0, reconnectMs: [] },
			events: () => Promise.resolve(stream()),
			prepare: () =>
				Promise.resolve({
					env: {},
					leaseIds: new Set([`vl_${runs + 1}`]),
					cleanup: () => Promise.resolve(),
				}),
		}
	);
	expect(code).toBe(0);
	expect(runs).toBe(2);
	expect(errors).toContain("(vl_1)");
	expect(errors).not.toContain("vl_other");
});
