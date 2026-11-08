// `ryu-cli secrets run --watch` restart triggers: the run's own lease events
// reach it under `--env` (Core's environment filter would drop them), the
// watch survives any number of successful reconnects, and `--tags` is
// resolved again on every restart. Core's SSE stream is a controllable fake
// that applies Core's event filter semantics.

import { expect, test } from "bun:test";
import type { VaultEventMessage } from "@ryuhq/core-client/vault-events";
import { runWatching } from "../cli/secrets-watch.ts";
import type { ProcessRunner } from "../cli/types.ts";
import type { SignalGuard } from "../cli/vaultIsolation.ts";
import {
	credential,
	fakeNode,
	jsonExport,
	lease,
	listBody,
	runSecrets,
	secretRow,
} from "./secrets-fixture.ts";

interface FakeEvent {
	environment?: string;
	leaseId?: string;
	name?: string;
	type: string;
}

/** Core's `/api/vault/events`: drops events the query's `types` and
 *  `environment` exclude, as `EventFilter::matches` does. */
function fakeEventStream(node: ReturnType<typeof fakeNode>) {
	const urls: URL[] = [];
	let push: (event: FakeEvent) => void = () => undefined;
	const baseFetch = node.target.fetch;
	node.target.fetch = (input, init) => {
		const url = new URL(String(input));
		if (url.pathname !== "/api/vault/events") {
			return baseFetch?.(input, init) ?? Promise.reject(new Error("no fetch"));
		}
		urls.push(url);
		const types = url.searchParams.get("types")?.split(",");
		const environment = url.searchParams.get("environment");
		const encoder = new TextEncoder();
		let seq = 0;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				push = (event) => {
					if (types && !types.includes(event.type)) {
						return;
					}
					if (environment !== null && event.environment !== environment) {
						return;
					}
					seq += 1;
					const frame = {
						seq,
						at: "2026-01-01T00:00:00Z",
						action: "x",
						...event,
					};
					controller.enqueue(
						encoder.encode(`event: vault\ndata: ${JSON.stringify(frame)}\n\n`)
					);
				};
				init?.signal?.addEventListener("abort", () => controller.close(), {
					once: true,
				});
			},
		});
		return Promise.resolve(new Response(body));
	};
	return { urls, push: (event: FakeEvent) => push(event) };
}

function blockingChild(signal: AbortSignal | undefined): Promise<number> {
	return new Promise((resolve) => {
		signal?.addEventListener("abort", () => resolve(143), { once: true });
	});
}

test("run --watch --env restarts on its own lease's revoke, not on another environment", async () => {
	let issued = 0;
	const node = fakeNode({
		"POST /api/vault/export": () => Response.json(jsonExport({ API_KEY: "k" })),
		"POST /api/vault/dynamic/issue/db": () => {
			issued += 1;
			return Response.json(credential(`vl_${issued}`, { password: "p" }));
		},
		"POST /api/vault/leases/vl_1/revoke": () =>
			Response.json({ lease: lease("vl_1", "db", true) }),
		"POST /api/vault/leases/vl_2/revoke": () =>
			Response.json({ lease: lease("vl_2", "db", true) }),
	});
	const events = fakeEventStream(node);
	let runs = 0;
	const spawn: ProcessRunner = (_cmd, _env, options) => {
		runs += 1;
		if (runs === 1) {
			// A change in another environment must not restart the run.
			events.push({ type: "kv-write", environment: "prod", name: "OTHER" });
			// Lease audit rows carry no environment.
			events.push({ type: "lease-revoke", leaseId: "vl_1" });
			return blockingChild(options?.signal);
		}
		return Promise.resolve(0);
	};
	const result = await runSecrets(
		[
			"run",
			"--no-project",
			"--env",
			"dev",
			"--lease",
			"db",
			"--watch",
			"--",
			"node",
		],
		node,
		{ spawn }
	);
	expect(result.code).toBe(0);
	expect(runs).toBe(2);
	expect(events.urls[0]?.searchParams.has("environment")).toBe(false);
	expect(result.err).toContain("vault values changed (vl_1); restarting.");
	expect(result.err).not.toContain("OTHER");
});

const quietGuard: SignalGuard = {
	abort: new AbortController().signal,
	dispose: () => undefined,
	forwardTo: () => undefined,
	throwIfCancelled: () => undefined,
};

async function* endsAtOnce(): AsyncGenerator<VaultEventMessage> {
	// A stream drop, for example Core restarting.
}

test("a watch survives more stream drops than its retry budget when each reconnect succeeds", async () => {
	const DROPS = 5;
	let opens = 0;
	let errors = "";
	const code = await runWatching(
		{
			io: {
				out: () => undefined,
				err: (text: string) => {
					errors += text;
				},
			},
			// The command finishes once the stream has dropped DROPS times.
			spawn: (_cmd, _env, options) =>
				opens > DROPS ? Promise.resolve(0) : blockingChild(options?.signal),
		},
		{
			command: ["node"],
			guard: quietGuard,
			timing: { debounceMs: 0, reconnectMs: [0] },
			events: () => {
				opens += 1;
				return Promise.resolve(
					opens > DROPS
						? (async function* () {
								await new Promise(() => undefined);
							})()
						: endsAtOnce()
				);
			},
			prepare: () =>
				Promise.resolve({
					env: {},
					leaseIds: new Set<string>(),
					cleanup: () => Promise.resolve(),
				}),
		}
	);
	expect(code).toBe(0);
	expect(opens).toBe(DROPS + 1);
	expect(errors).not.toContain("could not be reopened");
});

test("run --watch --tags selects names again on every restart", async () => {
	let lists = 0;
	const exported: unknown[] = [];
	const node = fakeNode({
		"GET /api/vault/secrets": () => {
			lists += 1;
			// B loses the `web` tag between the first and second run.
			return Response.json(
				listBody([
					secretRow("A", ["web"]),
					secretRow("B", lists === 1 ? ["web"] : ["prod-only"]),
				])
			);
		},
		"POST /api/vault/export": (call) => {
			const names: string[] = JSON.parse(call.body).names;
			exported.push(names);
			const all: Record<string, string> = { A: "a", B: "b" };
			return Response.json(
				jsonExport(
					Object.fromEntries(names.map((name) => [name, all[name] ?? ""]))
				)
			);
		},
	});
	const events = fakeEventStream(node);
	const seen: Record<string, string>[] = [];
	const spawn: ProcessRunner = (_cmd, env, options) => {
		seen.push(env);
		if (seen.length === 1) {
			events.push({ type: "kv-write", environment: "dev", name: "B" });
			return blockingChild(options?.signal);
		}
		return Promise.resolve(0);
	};
	const result = await runSecrets(
		[
			"run",
			"--no-project",
			"--env",
			"dev",
			"--tags",
			"web",
			"--watch",
			"--",
			"node",
		],
		node,
		{ spawn }
	);
	expect(result.code).toBe(0);
	expect(exported).toEqual([["A", "B"], ["A"]]);
	expect(seen[0]?.B).toBe("b");
	expect(seen[1]?.B).toBeUndefined();
	expect(seen[1]?.A).toBe("a");
});
