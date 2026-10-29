import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	type Box,
	type BoxProcess,
	type BoxStreamEvent,
	createBoxClient,
} from "./box.ts";

interface Seen {
	body: string | null;
	headers: Headers;
	method: string;
	url: string;
}

function recordingClient(respond: (seen: Seen) => Response) {
	const calls: Seen[] = [];
	const client = createBoxClient({
		apiKey: "box-key",
		baseUrl: "https://box.example/",
		fetch: async (input, init) => {
			const body = init?.body;
			const seen: Seen = {
				body: z.string().safeParse(body).success
					? z.string().parse(body)
					: body instanceof Uint8Array
						? new TextDecoder().decode(body)
						: null,
				headers: new Headers(init?.headers),
				method: init?.method ?? "GET",
				url: String(input),
			};
			calls.push(seen);
			return respond(seen);
		},
	});
	return { calls, client };
}

function sse(frames: string[]): Response {
	return new Response(frames.join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function boxFixture(id: string): Box {
	return {
		allowedHosts: [],
		createdAt: "2026-01-01T00:00:00Z",
		driver: "docker",
		envNames: [],
		id,
		image: "ubuntu",
		lastError: null,
		name: "dev",
		network: "allowlist",
		repo: null,
		secrets: [],
		size: "default",
		snapshotId: null,
		status: "provisioning",
		stoppedAt: null,
		ttlSeconds: null,
		updatedAt: "2026-01-01T00:00:00Z",
	};
}
function processFixture(id: string): BoxProcess {
	return {
		args: [],
		background: true,
		boxId: "box_1",
		command: "echo",
		cwd: "/workspace",
		durationMs: null,
		endedAt: null,
		exitCode: null,
		id,
		kind: "command",
		outputTruncated: false,
		startedAt: "2026-01-01T00:00:00Z",
		status: "running",
	};
}
describe("BoxAPI", () => {
	test("creates a Box with the bearer key and an idempotency key", async () => {
		const { calls, client } = recordingClient(() =>
			Response.json({ box: boxFixture("box_1") }, { status: 202 })
		);
		const box = await client.create(
			{
				name: "dev",
				network: "allowlist",
				allowedHosts: ["registry.npmjs.org"],
			},
			"create-1"
		);
		expect(box.id).toBe("box_1");
		const [call] = calls;
		expect(call?.url).toBe("https://box.example/v1/boxes");
		expect(call?.method).toBe("POST");
		expect(call?.headers.get("authorization")).toBe("Bearer box-key");
		expect(call?.headers.get("idempotency-key")).toBe("create-1");
		expect(JSON.parse(call?.body ?? "{}")).toEqual({
			allowedHosts: ["registry.npmjs.org"],
			name: "dev",
			network: "allowlist",
		});
	});

	test("streams command output as typed events", async () => {
		const { calls, client } = recordingClient(() =>
			sse([
				`event: process\ndata: ${JSON.stringify(processFixture("proc_1"))}\n\n`,
				": keep-alive\n\n",
				'id: 1\nevent: stdout\ndata: {"data":"hello\\n"}\n\n',
				'id: 2\nevent: stderr\ndata: {"data":"warn"}\n\n',
				'event: exit\ndata: {"durationMs":5,"exitCode":0,"status":"exited"}\n\n',
			])
		);
		const events: BoxStreamEvent[] = [];
		for await (const item of client.execStream("box_1", { command: "echo" })) {
			events.push(item);
		}
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			command: "echo",
			stream: true,
		});
		expect(calls[0]?.headers.get("accept")).toBe("text/event-stream");
		expect(events.map((item) => item.type)).toEqual([
			"process",
			"stdout",
			"stderr",
			"exit",
		]);
		expect(events[1]).toEqual({ data: "hello\n", seq: 1, type: "stdout" });
		expect(events[3]).toEqual({
			durationMs: 5,
			exitCode: 0,
			status: "exited",
			type: "exit",
		});
	});

	test("starts background processes and follows their logs", async () => {
		const { calls, client } = recordingClient((seen) =>
			seen.url.includes("/logs")
				? sse(['id: 3\nevent: stdout\ndata: {"data":"tick"}\n\n'])
				: Response.json({ process: processFixture("proc_9") }, { status: 202 })
		);
		const started = await client.spawn("box_1", {
			command: "sleep",
			args: ["60"],
		});
		expect(started.id).toBe("proc_9");
		expect(JSON.parse(calls[0]?.body ?? "{}").background).toBe(true);
		const logs: BoxStreamEvent[] = [];
		for await (const item of client.followLogs("box_1", "proc_9", {
			after: 2,
		})) {
			logs.push(item);
		}
		expect(calls[1]?.url).toBe(
			"https://box.example/v1/boxes/box_1/processes/proc_9/logs?after=2&follow=true"
		);
		expect(logs).toEqual([{ data: "tick", seq: 3, type: "stdout" }]);
	});

	test("reads and writes files as bytes", async () => {
		const { calls, client } = recordingClient((seen) =>
			seen.method === "GET"
				? new Response(new TextEncoder().encode("content"))
				: Response.json({ ok: true })
		);
		await client.writeFile("box_1", "src/a b.txt", "content");
		expect(calls[0]?.method).toBe("PUT");
		expect(calls[0]?.url).toBe(
			"https://box.example/v1/boxes/box_1/files/content?path=src%2Fa+b.txt"
		);
		expect(calls[0]?.headers.get("content-type")).toBe(
			"application/octet-stream"
		);
		expect(calls[0]?.body).toBe("content");
		expect(await client.readTextFile("box_1", "src/a b.txt")).toBe("content");
	});

	test("opens a terminal with a minted access token", async () => {
		const opened: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) {
					return;
				}
				return new Response("not found", { status: 404 });
			},
			websocket: { message() {} },
		});
		class RecordingSocket extends WebSocket {
			constructor(url: string | URL, protocols?: string | string[]) {
				opened.push(String(url));
				super(`ws://127.0.0.1:${server.port}`, protocols);
			}
		}
		const client = createBoxClient({
			apiKey: "box-key",
			baseUrl: "https://box.example",
			fetch: async (_input, init) => {
				expect(JSON.parse(String(init?.body))).toEqual({ scope: "terminal" });
				return Response.json(
					{
						expiresAt: "2026-01-01T00:00:00.000Z",
						token: "tok",
						url: "wss://box.example/v1/boxes/box_1/terminal?access_token=tok",
					},
					{ status: 201 }
				);
			},
			webSocket: RecordingSocket,
		});
		const socket = await client.openTerminal("box_1", { cols: 120, rows: 40 });
		expect(opened).toEqual([
			"wss://box.example/v1/boxes/box_1/terminal?access_token=tok&cols=120&rows=40",
		]);
		expect(socket.binaryType).toBe("arraybuffer");
		socket.close();
		server.stop(true);
	});

	test("reads usage with or without the storage fields", async () => {
		const legacyLine = {
			boxId: "bx_old",
			resourceUnitSeconds: 20,
			seconds: 10,
		};
		const storageLine = {
			boxId: "bx_new",
			resourceUnitSeconds: 0,
			seconds: 0,
			size: "small",
			storageAllowanceGib: 40,
			storageSeconds: 3600,
		};
		const snapshotLine = {
			sizeBytes: 2_000_000,
			snapshotId: "snap_1",
			storageSeconds: 3600,
		};
		const billedLine = {
			billableSeconds: 300,
			boxId: "bx_billed",
			resourceUnitSeconds: 40,
			seconds: 40,
			size: "small",
			stateByteSeconds: 3_600_000_000,
			stateBytes: 1_000_000,
			storageSeconds: 3600,
		};
		const { calls, client } = recordingClient(() =>
			Response.json({
				boxes: [legacyLine, storageLine, billedLine],
				from: "2026-08-01T00:00:00.000Z",
				ok: true,
				snapshots: [snapshotLine],
				to: "2026-08-01T01:00:00.000Z",
				totals: { billableSeconds: 300, resourceUnitSeconds: 60, seconds: 50 },
				type: "usage.summary",
			})
		);
		const usage = await client.usage({
			from: "2026-08-01T00:00:00.000Z",
			to: "2026-08-01T01:00:00.000Z",
		});
		expect(usage.boxes).toEqual([legacyLine, storageLine, billedLine]);
		expect(usage.totals.billableSeconds).toBe(300);
		expect(usage.snapshots).toEqual([snapshotLine]);
		expect(calls[0]?.url).toBe(
			"https://box.example/v1/usage?from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-01T01%3A00%3A00.000Z"
		);
	});

	test("queues a managed prompt with cwd, env, and timeout and reads its result", async () => {
		const run = {
			completedAt: null,
			createdAt: "2026-01-01T00:00:00Z",
			execution: "managed",
			exitCode: null,
			id: "run_1",
			processId: null,
			provider: "claude-code",
			reason: null,
			status: "running",
			summary: null,
		};
		const finished = {
			...run,
			completedAt: "2026-01-01T00:05:00Z",
			exitCode: 0,
			processId: "proc_1",
			status: "completed",
			summary: "Fixed it.",
		};
		const canceled = {
			...run,
			completedAt: "2026-01-01T00:01:00Z",
			reason: "canceled",
			status: "failed",
		};
		const { calls, client } = recordingClient((seen) => {
			if (seen.url.endsWith("/cancel")) {
				return Response.json({
					ok: true,
					run: canceled,
					type: "prompt.canceled",
				});
			}
			if (seen.method === "GET") {
				return Response.json({ ok: true, run: finished, type: "prompt" });
			}
			return Response.json(
				{ ok: true, run, type: "prompt.queued" },
				{ status: 202 }
			);
		});
		const queued = await client.prompt("box_1", {
			cwd: "app",
			env: { ANTHROPIC_API_KEY: "test-key" },
			execution: "managed",
			provider: "claude-code",
			text: "fix the test",
			timeoutSeconds: 900,
		});
		expect(queued).toEqual({
			...run,
			execution: "managed",
			provider: "claude-code",
		});
		expect(calls[0]?.url).toBe("https://box.example/v1/boxes/box_1/prompt");
		expect(calls[0]?.method).toBe("POST");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			cwd: "app",
			env: { ANTHROPIC_API_KEY: "test-key" },
			execution: "managed",
			provider: "claude-code",
			text: "fix the test",
			timeoutSeconds: 900,
		});
		const result = await client.promptRun("box_1", "run_1");
		expect(calls[1]?.url).toBe(
			"https://box.example/v1/boxes/box_1/prompts/run_1"
		);
		expect(calls[1]?.method).toBe("GET");
		expect(result).toMatchObject({
			completedAt: "2026-01-01T00:05:00Z",
			exitCode: 0,
			reason: null,
			status: "completed",
			summary: "Fixed it.",
		});
		const stopped = await client.cancelPrompt("box_1", "run_1");
		expect(calls[2]?.url).toBe(
			"https://box.example/v1/boxes/box_1/prompts/run_1/cancel"
		);
		expect(calls[2]?.method).toBe("POST");
		expect(stopped).toMatchObject({ reason: "canceled", status: "failed" });
	});

	test("defaults prompt result fields from an older Box service to null", async () => {
		const { client } = recordingClient(() =>
			Response.json({
				ok: true,
				prompts: [
					{
						createdAt: "2026-01-01T00:00:00Z",
						execution: "worker",
						id: "run_old",
						processId: null,
						provider: "codex",
						status: "queued",
					},
				],
				type: "prompt.list",
			})
		);
		const [legacy] = await client.prompts("box_1");
		expect(legacy).toMatchObject({
			completedAt: null,
			exitCode: null,
			reason: null,
			summary: null,
		});
	});

	test("surfaces the service error with status", async () => {
		const { client } = recordingClient(() =>
			Response.json({ error: { code: "box_not_ready" } }, { status: 409 })
		);
		await expect(client.stop("box_1")).rejects.toThrow(
			"Ryu Box: POST /v1/boxes/box_1/stop failed (409)"
		);
	});
});
