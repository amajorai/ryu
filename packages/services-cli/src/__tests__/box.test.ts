import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { type RyuFetch, toResult } from "@ryuhq/services";
import { type CliIo, runCli } from "../cli.ts";
import { boxCommands, stopAndReread } from "../commands/box.ts";
import { createServicesMcpServer } from "../mcp/server.ts";
import { commandLine } from "../registry.ts";
import { unwrapSettled } from "../settled.ts";

interface Recorded {
	body: string | null;
	headers: Headers;
	method: string;
	url: string;
}

function stubFetch(
	respond: (request: Recorded) => Response | Promise<Response>
) {
	const calls: Recorded[] = [];
	const fetch: RyuFetch = async (input, init) => {
		const request = new Request(input, init);
		const recorded: Recorded = {
			body: request.body === null ? null : await request.text(),
			headers: request.headers,
			method: request.method,
			url: request.url,
		};
		calls.push(recorded);
		return await respond(recorded);
	};
	return { calls, fetch };
}

const BASE = "http://127.0.0.1:8090";
const ENV = { RYU_BOX_URL: BASE, RYU_BOX_API_KEY: "box-cli-secret" };
const BOX_ID = "bx_0123456789abcdef0123456789abcdef";
const NOW = "2026-10-21T12:00:00.000Z";

function box(status = "ready") {
	return {
		allowedHosts: [],
		createdAt: NOW,
		driver: "docker",
		envNames: [],
		id: BOX_ID,
		image: "ubuntu:24.04",
		lastError: null,
		name: "cli-box",
		network: "none",
		repo: null,
		secrets: [],
		size: "small",
		snapshotId: null,
		status,
		stoppedAt: null,
		ttlSeconds: 86_400,
		updatedAt: NOW,
	};
}

const PROCESS = {
	args: ["-la"],
	background: false,
	boxId: BOX_ID,
	command: "ls",
	cwd: "/workspace",
	durationMs: null,
	endedAt: null,
	exitCode: null,
	id: "proc_1",
	kind: "command",
	outputTruncated: false,
	startedAt: NOW,
	status: "running",
};

function sseFrames(exitCode: number): string[] {
	return [
		`event: process\ndata: ${JSON.stringify(PROCESS)}\n\n`,
		'event: stdout\nid: 1\ndata: {"data":"total 0\\n"}\n\n',
		'event: stderr\nid: 2\ndata: {"data":"warning: slow disk\\n"}\n\n',
		'event: stdout\nid: 3\ndata: {"data":"package.json\\n"}\n\n',
		`event: exit\ndata: ${JSON.stringify({ exitCode, status: "exited", durationMs: 9 })}\n\n`,
	];
}

function sse(exitCode: number): Response {
	return new Response(sseFrames(exitCode).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

/**
 * An SSE body that sends one frame at a time and waits for `gate()` before
 * each frame after the first, so a test can look at the output mid-stream.
 */
function gatedSse(exitCode: number, gate: (index: number) => Promise<void>) {
	const encoder = new TextEncoder();
	const frames = sseFrames(exitCode);
	let closed = false;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const [index, frame] of frames.entries()) {
				await gate(index);
				controller.enqueue(encoder.encode(frame));
			}
			closed = true;
			controller.close();
		},
	});
	return {
		isClosed: () => closed,
		response: new Response(body, {
			headers: { "content-type": "text/event-stream" },
		}),
	};
}

/** A tiny Box server. */
function boxServer(exitCode = 0) {
	return (request: Recorded): Response => {
		const path = new URL(request.url).pathname;
		const route = `${request.method} ${path}`;
		switch (route) {
			case "GET /v1/boxes":
				return Response.json({ boxes: [box()], ok: true, type: "box.list" });
			case "POST /v1/boxes":
				return Response.json(
					{ box: box(), ok: true, type: "box.created" },
					{ status: 201 }
				);
			case `GET /v1/boxes/${BOX_ID}`:
				return Response.json({ box: box(), ok: true, type: "box.get" });
			case `POST /v1/boxes/${BOX_ID}/commands`: {
				const body = JSON.parse(request.body ?? "{}") as { stream?: boolean };
				return body.stream
					? sse(exitCode)
					: Response.json({
							ok: true,
							result: {
								durationMs: 9,
								exitCode,
								stderr: "",
								stdout: "total 0\n",
							},
							type: "command.completed",
						});
			}
			case `POST /v1/boxes/${BOX_ID}/stop`:
				return Response.json({ ok: true, type: "box.stopped" });
			case `POST /v1/boxes/${BOX_ID}/resume`:
				return Response.json({ box: box(), ok: true, type: "box.resumed" });
			case `DELETE /v1/boxes/${BOX_ID}`:
				return Response.json({ ok: true, type: "box.deleted" });
			case `GET /v1/boxes/${BOX_ID}/files/content`:
				return new Response("hello from the box\n", {
					headers: { "content-type": "application/octet-stream" },
				});
			case `PUT /v1/boxes/${BOX_ID}/files/content`:
				return Response.json({ bytes: 5, ok: true, type: "file.written" });
			default:
				return Response.json(
					{
						code: "not_found",
						error: {
							code: "not_found",
							message: "Box not found.",
							requestId: "req_404",
							status: 404,
						},
						message: "Box not found.",
						ok: false,
						requestId: "req_404",
						status: 404,
						type: "box.error",
					},
					{ status: 404, headers: { "x-request-id": "req_404" } }
				);
		}
	};
}

function capture(fetch: RyuFetch, env: Record<string, string> = ENV) {
	let out = "";
	let err = "";
	const io: CliIo = {
		env,
		stdin: "",
		stdout: { write: (chunk: string) => (out += chunk) },
		stderr: { write: (chunk: string) => (err += chunk) },
		fetch,
	};
	return { io, stdout: () => out, stderr: () => err };
}

describe("ryu-services box", () => {
	test("registers the design's commands", () => {
		expect(boxCommands.map((command) => commandLine("box", command))).toEqual([
			"ryu-services box list",
			"ryu-services box create",
			"ryu-services box get",
			"ryu-services box exec",
			"ryu-services box stop",
			"ryu-services box resume",
			"ryu-services box delete",
		]);
	});

	test("list prints one JSON line per Box in human mode", async () => {
		const { fetch } = stubFetch(boxServer());
		const run = capture(fetch);
		expect(await runCli(["box", "list"], run.io)).toBe(0);
		const lines = run.stdout().trim().split("\n");
		expect(
			lines.map((line) => (JSON.parse(line) as { id: string }).id)
		).toEqual([BOX_ID]);
		expect(run.stderr()).toBe("");
	});

	test("list --json prints { data, meta } and sends the Bearer key", async () => {
		const { calls, fetch } = stubFetch(boxServer());
		const run = capture(fetch);
		expect(await runCli(["box", "list", "--json"], run.io)).toBe(0);
		const printed = JSON.parse(run.stdout()) as {
			data: { id: string }[];
			meta: { status: number };
		};
		expect(printed.data[0]?.id).toBe(BOX_ID);
		expect(printed.meta.status).toBe(200);
		expect(calls[0]?.url).toBe(`${BASE}/v1/boxes`);
		expect(calls[0]?.headers.get("authorization")).toBe(
			"Bearer box-cli-secret"
		);
	});

	test("create sends the flags and the caller's idempotency key", async () => {
		const { calls, fetch } = stubFetch(boxServer());
		const run = capture(fetch);
		const code = await runCli(
			[
				"box",
				"create",
				"--name",
				"build",
				"--size",
				"small",
				"--image",
				"node:22",
				"--setup",
				"npm i -g pnpm",
				"--setup",
				"pnpm -v",
				"--idempotency-key",
				"cli-box-create-1",
			],
			run.io
		);
		expect(code).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("idempotency-key")).toBe("cli-box-create-1");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			image: "node:22",
			name: "build",
			setup: ["npm i -g pnpm", "pnpm -v"],
			size: "small",
		});
		expect(run.stdout()).toContain(BOX_ID);
	});

	test("create --wait --json keeps the create call's meta", async () => {
		const { calls, fetch } = stubFetch((request) => {
			if (request.method === "POST") {
				return Response.json(
					{ box: box("provisioning"), ok: true, type: "box.created" },
					{ status: 201, headers: { "x-request-id": "req_create" } }
				);
			}
			return Response.json(
				{ box: box(), ok: true, type: "box.get" },
				{ headers: { "x-request-id": "req_poll" } }
			);
		});
		const run = capture(fetch);
		const code = await runCli(
			[
				"box",
				"create",
				"--wait",
				"--name",
				"w",
				"--idempotency-key",
				"cli-box-wait-0001",
				"--json",
			],
			run.io
		);
		expect(code).toBe(0);
		expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
		const printed = JSON.parse(run.stdout()) as {
			data: { status: string };
			meta: {
				attempts: number;
				idempotencyKey: string | null;
				requestId: string | null;
				status: number;
			};
		};
		expect(printed.data.status).toBe("ready");
		expect(printed.meta).toMatchObject({
			attempts: 1,
			idempotencyKey: "cli-box-wait-0001",
			requestId: "req_create",
			status: 201,
		});
	});

	test("create --idempotency-key without --name sends the same body on a rerun", async () => {
		const { calls, fetch } = stubFetch(boxServer());
		for (const _attempt of [1, 2]) {
			const run = capture(fetch);
			expect(
				await runCli(
					["box", "create", "--size", "small", "--idempotency-key", "ci-run-7"],
					run.io
				)
			).toBe(0);
		}
		expect(calls).toHaveLength(2);
		expect(calls[1]?.body).toBe(calls[0]?.body ?? "");
		expect(calls[1]?.headers.get("idempotency-key")).toBe("ci-run-7");
		expect(
			(JSON.parse(calls[0]?.body ?? "{}") as { name: string }).name
		).toMatch(/^cli-[0-9a-f]{12}$/);
		const other = capture(fetch);
		await runCli(["box", "create", "--idempotency-key", "ci-run-8"], other.io);
		expect(
			(JSON.parse(calls[2]?.body ?? "{}") as { name: string }).name
		).not.toBe((JSON.parse(calls[0]?.body ?? "{}") as { name: string }).name);
	});

	test("create without --name generates one and rejects a bad --size", async () => {
		const { calls, fetch } = stubFetch(boxServer());
		const ok = capture(fetch);
		expect(await runCli(["box", "create"], ok.io)).toBe(0);
		expect(
			(JSON.parse(calls[0]?.body ?? "{}") as { name: string }).name
		).toMatch(/^cli-[0-9a-f-]{8}$/);
		const bad = capture(fetch);
		expect(await runCli(["box", "create", "--size", "huge"], bad.io)).toBe(2);
		expect(bad.stderr()).toContain("--size must be one of");
		expect(calls).toHaveLength(1);
	});

	test("exec streams stdout and stderr raw as they arrive", async () => {
		let release: () => void = () => undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let firstChunkSeen: () => void = () => undefined;
		const firstChunk = new Promise<void>((resolve) => {
			firstChunkSeen = resolve;
		});
		// Every frame after the first stdout chunk waits until the test has
		// seen that chunk on stdout, so buffered output would deadlock-free
		// fail the mid-stream assertion below.
		const stream = gatedSse(0, (index) =>
			index < 2 ? Promise.resolve() : released
		);
		const server = boxServer();
		const { calls, fetch } = stubFetch((request) =>
			request.url.endsWith("/commands") ? stream.response : server(request)
		);
		let out = "";
		let err = "";
		const io: CliIo = {
			env: ENV,
			stdin: "",
			stdout: {
				write: (chunk: string) => {
					out += chunk;
					firstChunkSeen();
				},
			},
			stderr: { write: (chunk: string) => (err += chunk) },
			fetch,
		};
		const running = runCli(
			["box", "exec", BOX_ID, "--cwd", "app", "--", "ls", "-la"],
			io
		);
		await Promise.race([
			firstChunk,
			new Promise((_, reject) =>
				setTimeout(
					() => reject(new Error("no output before the stream ended")),
					2000
				)
			),
		]);
		expect(out).toBe("total 0\n");
		expect(stream.isClosed()).toBe(false);
		release();
		const code = await running;
		expect(code).toBe(0);
		expect(out).toBe("total 0\npackage.json\n");
		expect(err).toBe("warning: slow disk\n");
		expect(stream.isClosed()).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("accept")).toBe("text/event-stream");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			args: ["-la"],
			command: "ls",
			cwd: "app",
			stream: true,
		});
		expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
	});

	test("exec exits 1 with command_failed when the command exits non-zero, after its output", async () => {
		const { fetch } = stubFetch(boxServer(3));
		const run = capture(fetch);
		expect(await runCli(["box", "exec", BOX_ID, "--", "false"], run.io)).toBe(
			1
		);
		expect(run.stdout()).toBe("total 0\npackage.json\n");
		expect(run.stderr()).toContain("warning: slow disk\n");
		expect(run.stderr()).toContain(
			"error command_failed: box exec: the command exited with exit code 3."
		);
	});

	test("exec exits 1 when the command stream ends without an exit event", async () => {
		const respond = boxServer(0);
		const { fetch } = stubFetch((request) =>
			request.url.endsWith("/commands") && request.body?.includes('"stream"')
				? new Response(sseFrames(0).slice(0, 4).join(""), {
						headers: { "content-type": "text/event-stream" },
					})
				: respond(request)
		);
		const human = capture(fetch);
		expect(await runCli(["box", "exec", BOX_ID, "--", "make"], human.io)).toBe(
			1
		);
		expect(human.stdout()).toBe("total 0\npackage.json\n");
		expect(human.stderr()).toContain(
			"the command stream ended before the command finished"
		);
		const json = capture(fetch);
		expect(
			await runCli(["box", "exec", BOX_ID, "--json", "--", "make"], json.io)
		).toBe(1);
		expect(json.stderr() + json.stdout()).toContain("connection_error");
	});

	test("exec --json with a non-zero exit prints every event, then { error }, and exits 1", async () => {
		const { fetch } = stubFetch(boxServer(3));
		const run = capture(fetch);
		expect(
			await runCli(["box", "exec", BOX_ID, "--json", "--", "false"], run.io)
		).toBe(1);
		const lines = run
			.stdout()
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(lines.slice(0, 5).map((line) => line.type)).toEqual([
			"process",
			"stdout",
			"stderr",
			"stdout",
			"exit",
		]);
		expect(lines[5]).toMatchObject({
			error: { code: "command_failed", details: { exitCode: 3 } },
		});
	});

	test("exec --buffered with a non-zero exit prints the result and exits 1", async () => {
		const { fetch } = stubFetch(boxServer(2));
		const human = capture(fetch);
		expect(
			await runCli(
				["box", "exec", BOX_ID, "--buffered", "--", "false"],
				human.io
			)
		).toBe(1);
		expect(JSON.parse(human.stdout())).toMatchObject({ exitCode: 2 });
		expect(human.stderr()).toContain("error command_failed");
		const json = capture(fetch);
		expect(
			await runCli(
				["box", "exec", BOX_ID, "--buffered", "--json", "--", "false"],
				json.io
			)
		).toBe(1);
		expect(JSON.parse(json.stdout())).toMatchObject({
			error: {
				code: "command_failed",
				details: { exitCode: 2, stdout: "total 0\n" },
			},
		});
	});

	test("exec --json prints one JSON line per event", async () => {
		const { fetch } = stubFetch(boxServer());
		const run = capture(fetch);
		const code = await runCli(
			["box", "exec", BOX_ID, "--json", "--", "ls", "-la"],
			run.io
		);
		expect(code).toBe(0);
		const events = run
			.stdout()
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; data?: string });
		expect(events.map((event) => event.type)).toEqual([
			"process",
			"stdout",
			"stderr",
			"stdout",
			"exit",
		]);
		expect(events[1]?.data).toBe("total 0\n");
	});

	test("exec --buffered waits and prints the result", async () => {
		const { calls, fetch } = stubFetch(boxServer());
		const run = capture(fetch);
		const code = await runCli(
			[
				"box",
				"exec",
				BOX_ID,
				"--buffered",
				"--user",
				"root",
				"--command-timeout",
				"30",
				"--",
				"ls",
			],
			run.io
		);
		expect(code).toBe(0);
		expect(JSON.parse(run.stdout())).toMatchObject({ exitCode: 0 });
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			args: [],
			command: "ls",
			timeoutSecs: 30,
			user: "root",
		});
	});

	test("exec sends the executable as one word even with spaces or quotes", async () => {
		const { calls, fetch } = stubFetch(boxServer());
		const run = capture(fetch);
		await runCli(
			["box", "exec", BOX_ID, "--buffered", "--", "/opt/my app/it's", "a b"],
			run.io
		);
		expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
			command: "'/opt/my app/it'\\''s'",
			args: ["a b"],
		});
	});

	test("exec without a command after -- is a usage error", async () => {
		const { calls, fetch } = stubFetch(boxServer());
		const run = capture(fetch);
		expect(await runCli(["box", "exec", BOX_ID], run.io)).toBe(2);
		expect(run.stderr()).toContain("after --");
		expect(calls).toHaveLength(0);
	});

	test("exec --dry-run prints curl with the key placeholder and sends nothing", async () => {
		let sent = 0;
		const run = capture(() => {
			sent += 1;
			return Promise.reject(new Error("a dry run must not send requests"));
		});
		const code = await runCli(
			["box", "exec", BOX_ID, "--dry-run", "--", "ls"],
			run.io
		);
		expect(code).toBe(0);
		expect(sent).toBe(0);
		expect(run.stdout()).toContain(`${BASE}/v1/boxes/${BOX_ID}/commands`);
		expect(run.stdout()).toContain("$RYU_BOX_API_KEY");
		expect(run.stdout()).not.toContain("box-cli-secret");
	});

	test("get, stop, resume and delete", async () => {
		const { calls, fetch } = stubFetch(boxServer());
		for (const command of ["get", "stop", "resume", "delete"]) {
			const run = capture(fetch);
			expect(await runCli(["box", command, BOX_ID], run.io)).toBe(0);
		}
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`GET ${BASE}/v1/boxes/${BOX_ID}`,
			`POST ${BASE}/v1/boxes/${BOX_ID}/stop`,
			`GET ${BASE}/v1/boxes/${BOX_ID}`,
			`POST ${BASE}/v1/boxes/${BOX_ID}/resume`,
			`DELETE ${BASE}/v1/boxes/${BOX_ID}`,
		]);
	});

	test("stop prints the Box as re-read after the stop, with the stop's meta; delete prints OK", async () => {
		const base = boxServer();
		let stopped = false;
		const { calls, fetch } = stubFetch((request) => {
			const route = `${request.method} ${new URL(request.url).pathname}`;
			if (route === `POST /v1/boxes/${BOX_ID}/stop`) {
				stopped = true;
				return Response.json(
					{ ok: true, type: "box.stopped" },
					{ headers: { "x-request-id": "req_stop" } }
				);
			}
			if (route === `GET /v1/boxes/${BOX_ID}` && stopped) {
				return Response.json(
					{ box: box("stopped"), ok: true, type: "box.get" },
					{ headers: { "x-request-id": "req_get" } }
				);
			}
			return base(request);
		});
		const stop = capture(fetch);
		expect(await runCli(["box", "stop", BOX_ID, "--json"], stop.io)).toBe(0);
		const printed = JSON.parse(stop.stdout()) as {
			data: { id: string; status: string };
			meta: {
				attempts: number;
				idempotencyKey: string | null;
				requestId: string | null;
				status: number;
			};
		};
		expect(printed.data).toMatchObject({ id: BOX_ID, status: "stopped" });
		expect(printed.meta.requestId).toBe("req_stop");
		expect(printed.meta.attempts).toBe(1);
		expect(printed.meta.status).toBe(200);
		// The stop route is not idempotent, so it sends no key and its meta reports none.
		expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
		expect(printed.meta.idempotencyKey).toBeNull();
		const remove = capture(fetch);
		expect(await runCli(["box", "delete", BOX_ID], remove.io)).toBe(0);
		expect(remove.stdout().trim()).toBe("OK");
	});

	test("stop still succeeds when the re-read fails: OK, or data null with the stop's meta", async () => {
		const base = boxServer();
		const { fetch } = stubFetch((request) => {
			if (request.method === "GET") {
				return Response.json(
					{
						ok: false,
						type: "box.error",
						code: "internal_error",
						message: "boom",
					},
					{ status: 400 }
				);
			}
			return request.url.endsWith("/stop")
				? Response.json(
						{ ok: true, type: "box.stopped" },
						{ headers: { "x-request-id": "req_stop" } }
					)
				: base(request);
		});
		const run = capture(fetch);
		expect(await runCli(["box", "stop", BOX_ID], run.io)).toBe(0);
		expect(run.stdout().trim()).toBe("OK");
		const json = capture(fetch);
		expect(await runCli(["box", "stop", BOX_ID, "--json"], json.io)).toBe(0);
		const printed = JSON.parse(json.stdout()) as {
			data: unknown;
			meta: { requestId: string | null };
		};
		expect(printed.data).toBeNull();
		expect(printed.meta.requestId).toBe("req_stop");
	});

	test("a failed stop still fails the command and is not re-read", async () => {
		const { calls, fetch } = stubFetch((request) =>
			request.url.endsWith("/stop")
				? Response.json(
						{
							ok: false,
							type: "box.error",
							code: "not_found",
							message: "Box not found.",
						},
						{ status: 404, headers: { "x-request-id": "req_404" } }
					)
				: boxServer()(request)
		);
		const run = capture(fetch);
		expect(await runCli(["box", "stop", BOX_ID], run.io)).toBe(1);
		expect(run.stderr()).toContain("not_found");
		expect(calls.map((call) => call.method)).toEqual(["POST"]);
	});

	test("the stop re-read is bounded by a deadline, retries included", async () => {
		let aborted = false;
		const fake = {
			stop: () => Promise.resolve(undefined),
			with: ({ signal }: { signal?: AbortSignal }) => ({
				get: () =>
					new Promise<never>((_resolve, reject) => {
						signal?.addEventListener("abort", () => {
							aborted = true;
							reject(signal.reason);
						});
					}),
			}),
		};
		const started = Date.now();
		const result = await stopAndReread(
			fake as unknown as Parameters<typeof stopAndReread>[0],
			BOX_ID,
			20
		);
		expect(aborted).toBe(true);
		expect(Date.now() - started).toBeLessThan(2000);
		const placeholder = await toResult(Promise.resolve(null));
		if (placeholder.error !== null) {
			throw placeholder.error;
		}
		expect(
			unwrapSettled({ ...placeholder, data: result }).data
		).toBeUndefined();
	});

	test("a Box error exits 1 with its code and request id", async () => {
		const { fetch } = stubFetch(boxServer());
		const run = capture(fetch);
		expect(await runCli(["box", "get", "bx_missing"], run.io)).toBe(1);
		expect(run.stderr()).toContain("error not_found: Box not found.");
		expect(run.stderr()).toContain("requestId: req_404");
	});

	test("a missing RYU_BOX_API_KEY exits 2 and names the variable", async () => {
		// RYU_BOX_URL defaults to hosted Box; the key has no default.
		const { calls, fetch } = stubFetch(boxServer());
		const run = capture(fetch, {});
		expect(await runCli(["box", "list"], run.io)).toBe(2);
		expect(run.stderr()).toContain("RYU_BOX_API_KEY");
		expect(calls).toHaveLength(0);
	});
});

async function connect(fetch: RyuFetch, readOnly = false, timeoutMs?: number) {
	const { server, registration } = createServicesMcpServer({
		config: {
			env: ENV,
			fetch,
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		},
		log: () => undefined,
		services: ["box"],
		readOnly,
	});
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "ryu-services-test", version: "1.0.0" });
	await client.connect(clientTransport);
	return { client, registration, close: () => client.close() };
}

describe("ryu-services mcp: box tools", () => {
	test("registers the design's tools, and only the read tools in read-only mode", async () => {
		const { fetch } = stubFetch(boxServer());
		const all = await connect(fetch);
		const { tools } = await all.client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"box_create",
			"box_delete",
			"box_exec",
			"box_get",
			"box_list",
			"box_read_file",
			"box_resume",
			"box_stop",
			"box_write_file",
		]);
		const remove = tools.find((tool) => tool.name === "box_delete");
		expect(remove?.annotations?.destructiveHint).toBe(true);
		const exec = tools.find((tool) => tool.name === "box_exec");
		expect(exec?.annotations?.idempotentHint).toBe(false);
		const stop = tools.find((tool) => tool.name === "box_stop");
		expect(stop?.annotations?.destructiveHint).toBe(true);
		// Resuming restarts a stopped Box without destroying anything.
		const resume = tools.find((tool) => tool.name === "box_resume");
		expect(resume?.annotations?.readOnlyHint).toBe(false);
		expect(resume?.annotations?.destructiveHint).toBe(false);
		expect(resume?.annotations?.idempotentHint).toBe(true);
		// Setup commands run as root and may reach the network.
		const create = tools.find((tool) => tool.name === "box_create");
		expect(create?.annotations?.openWorldHint).toBe(true);
		await all.close();
		const readOnly = await connect(fetch, true);
		const listed = await readOnly.client.listTools();
		expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
			"box_get",
			"box_list",
			"box_read_file",
		]);
		await readOnly.close();
	});

	test("tools call the Box API and return { data, meta }", async () => {
		const { calls, fetch } = stubFetch(boxServer());
		const { client, close } = await connect(fetch);
		const listed = await client.callTool({ name: "box_list", arguments: {} });
		expect(
			(listed.structuredContent as { data: { id: string }[] }).data[0]?.id
		).toBe(BOX_ID);

		const created = await client.callTool({
			name: "box_create",
			arguments: { size: "small" },
		});
		expect(created.isError).toBeFalsy();
		const createCall = calls.find(
			(call) => call.method === "POST" && call.url === `${BASE}/v1/boxes`
		);
		expect(createCall?.headers.get("idempotency-key")).toBeTruthy();
		expect(
			(JSON.parse(createCall?.body ?? "{}") as { name: string }).name
		).toMatch(/^mcp-/);

		const executed = await client.callTool({
			name: "box_exec",
			arguments: { boxId: BOX_ID, command: "ls" },
		});
		expect(
			(executed.structuredContent as { data: { stdout: string } }).data.stdout
		).toBe("total 0\n");

		const read = await client.callTool({
			name: "box_read_file",
			arguments: { boxId: BOX_ID, path: "notes.txt" },
		});
		// Cut to maxChars (default 20 000), like passport_fetch.
		expect(read.structuredContent).toMatchObject({
			data: {
				path: "notes.txt",
				content: "hello from the box\n",
				truncated: false,
				totalChars: 19,
			},
		});

		const written = await client.callTool({
			name: "box_write_file",
			arguments: { boxId: BOX_ID, path: "notes.txt", content: "hello" },
		});
		expect(written.isError).toBeFalsy();
		const writeCall = calls.find((call) => call.method === "PUT");
		expect(writeCall?.body).toBe("hello");
		expect(new URL(writeCall?.url ?? BASE).searchParams.get("path")).toBe(
			"notes.txt"
		);

		const got = await client.callTool({
			name: "box_get",
			arguments: { boxId: BOX_ID },
		});
		expect((got.structuredContent as { data: { id: string } }).data.id).toBe(
			BOX_ID
		);

		for (const name of ["box_stop", "box_resume", "box_delete"]) {
			const result = await client.callTool({
				name,
				arguments: { boxId: BOX_ID },
			});
			expect(result.isError).toBeFalsy();
		}
		const resumed = calls.filter(
			(call) =>
				call.method === "POST" &&
				call.url === `${BASE}/v1/boxes/${BOX_ID}/resume`
		);
		expect(resumed).toHaveLength(1);
		await close();
	});

	test("box_exec waits past the instance timeout for a command that runs longer", async () => {
		const server = boxServer();
		const { calls, fetch: record } = stubFetch(server);
		// Like a real fetch, the delay ends early (rejects) when the request is aborted.
		const fetch: RyuFetch = (input, init) =>
			new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, 150);
				init?.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(new DOMException("aborted", "AbortError"));
				});
			}).then(() => record(input, init));
		const { client, close } = await connect(fetch, false, 50);
		const executed = await client.callTool({
			name: "box_exec",
			arguments: { boxId: BOX_ID, command: "sleep 1", timeoutSecs: 5 },
		});
		expect(executed.isError).toBeFalsy();
		expect(
			(executed.structuredContent as { data: { exitCode: number } }).data
				.exitCode
		).toBe(0);
		expect(calls).toHaveLength(1);
		await close();
	});

	test("a Box error is a tool error with the RyuError fields and no key", async () => {
		const { fetch } = stubFetch(boxServer());
		const { client, close } = await connect(fetch);
		const result = await client.callTool({
			name: "box_exec",
			arguments: { boxId: "bx_missing", command: "ls" },
		});
		expect(result.isError).toBe(true);
		const structured = result.structuredContent as {
			error: { code: string; requestId: string };
		};
		expect(structured.error.code).toBe("not_found");
		expect(structured.error.requestId).toBe("req_404");
		expect(JSON.stringify(result)).not.toContain("box-cli-secret");
		await close();
	});
});
