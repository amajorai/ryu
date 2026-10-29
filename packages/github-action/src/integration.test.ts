import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { FetchLike } from "./client.ts";
import type { JsonValue } from "./json.ts";
import type { ActionRuntime } from "./runtime.ts";

interface FixtureRequest {
	body: unknown;
	headers: Record<string, string>;
	method: string;
	path: string;
}

interface BundleRun {
	env: Record<string, string>;
	outputs: Record<string, string>;
	status: number;
	stderr: string;
	stdout: string;
	tempDir: string;
}

interface Fixture {
	baseUrl: string;
	fetchImpl: FetchLike;
	requests: FixtureRequest[];
	stop: () => void;
}

const bundlePath = resolve(
	fileURLToPath(new URL("../dist/index.cjs", import.meta.url))
);

interface BundledRunner {
	executeAction: typeof import("./runner.ts").executeAction;
}

// SAFETY: This imports the fresh tsup bundle of runner.ts, whose exported executeAction signature is referenced above.
const { executeAction: executeBundledAction } = (await import(
	bundlePath
)) as BundledRunner;

function jsonResponse(value: JsonValue, status = 200): Response {
	return new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function chatResponse(): Response {
	const encoder = new TextEncoder();
	const text = [
		'data: {"type":"start","run_id":"run-fixture"}\r\n',
		'data: {"type":"text-delta","delta":"Hello "}\r\n',
		'data: {"type":"tool-input-available","toolCallId":"call-fixture","toolName":"fixture.check","input":{"strict":true}}\r\n',
		'data: {"type":"data-ryu-workflow","data":{"step":"verify"}}\r\n',
		'data: {"type":"text-delta","delta":"from fixture Ryu."}\r\n',
		'data: {"type":"finish"}\r\n',
		"data: [DONE]\r\n",
	].join("");
	const bytes = encoder.encode(text);
	let offset = 0;
	let chunk = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			const size = Math.min(
				[7, 1, 19, 3, 31][chunk % 5] ?? 7,
				bytes.length - offset
			);
			controller.enqueue(bytes.slice(offset, offset + size));
			offset += size;
			chunk += 1;
		},
	});
	return new Response(stream, {
		headers: { "content-type": "text/event-stream" },
	});
}

function startFixture(managed: boolean): Fixture {
	const requests: FixtureRequest[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			const bodyText = await request.text();
			const headers: Record<string, string> = {};
			request.headers.forEach((value, key) => {
				headers[key] = value;
			});
			requests.push({
				body: bodyText.length > 0 ? JSON.parse(bodyText) : null,
				headers,
				method: request.method,
				path: url.pathname,
			});

			if (url.pathname === "/api/health") {
				return jsonResponse({
					capabilities: ["chat", "tools"],
					channel: "stable",
					status: "ok",
					version: "fixture-1.0.0",
				});
			}
			if (url.pathname === "/api/system/info") {
				return jsonResponse({
					hostname: "fixture-node",
					managed,
					org_id: managed ? "org-fixture" : null,
				});
			}
			if (url.pathname === "/api/chat/stream") {
				return chatResponse();
			}
			if (url.pathname === "/api/mcp/tools/call") {
				return jsonResponse({
					ok: true,
					output: { checked: true, source: "fixture-tool" },
				});
			}
			return jsonResponse({ error: "not found" }, 404);
		},
	});

	return {
		baseUrl: server.url.origin,
		fetchImpl: fetch,
		requests,
		stop: () => {
			server.stop(true);
		},
	};
}

async function runBundle(
	inputs: Record<string, string>,
	fixture: Fixture
): Promise<BundleRun> {
	const tempDir = await mkdtemp(join(tmpdir(), "ryu-github-action-"));
	const summaryPath = join(tempDir, "summary.md");
	await writeFile(summaryPath, "", "utf8");
	const outputs: Record<string, string> = {};
	const exportedEnvironment: Record<string, string> = {};
	const stdout: string[] = [];
	const stderr: string[] = [];
	const environment = {
		...process.env,
		GITHUB_ACTIONS: "true",
		GITHUB_STEP_SUMMARY: summaryPath,
		RYU_CORE_TOKEN: "fixture-token",
		RYU_CORE_URL: fixture.baseUrl,
	};
	const runtime: ActionRuntime = {
		exportVariable: (name, value) => {
			exportedEnvironment[name] = value;
		},
		getInput: (name) => inputs[name] ?? "",
		info: (message) => stdout.push(message),
		setOutput: (name, value) => {
			const text = z.string().safeParse(value);
			outputs[name] = text.success ? text.data : (JSON.stringify(value) ?? "");
		},
		setSecret: () => undefined,
		warning: (message) => stderr.push(message),
	};

	let status = 0;
	try {
		await executeBundledAction({
			environment,
			fetchImpl: fixture.fetchImpl,
			runtime,
			workingDirectory: tempDir,
		});
	} catch (error) {
		status = 1;
		stderr.push(error instanceof Error ? error.message : String(error));
	}

	return {
		env: exportedEnvironment,
		outputs,
		status,
		stderr: stderr.join("\n"),
		stdout: stdout.join("\n"),
		tempDir,
	};
}

async function cleanup(run: BundleRun): Promise<void> {
	await rm(run.tempDir, { force: true, recursive: true });
}

describe("bundled GitHub Action integration fixture", () => {
	it("runs a managed agent through the real action entrypoint", async () => {
		const fixture = startFixture(true);
		const run = await runBundle(
			{
				agent: "release-agent",
				"conversation-id": "conversation-42",
				cwd: "/workspace/project",
				"enable-long-term": "true",
				inference: '{"temperature":0}',
				persist: "true",
				"plugin-flags": '{"com.ryu.audit":false}',
				"worktree-isolation": "true",
				"managed-node-token": "fixture-token",
				"managed-node-url": fixture.baseUrl,
				operation: "run",
				prompt: "Verify the release candidate.",
				"response-file": "response.txt",
				target: "managed",
			},
			fixture
		);
		try {
			if (run.status !== 0) {
				throw new Error(`bundle failed: ${run.stdout}\n${run.stderr}`);
			}
			expect(run.status).toBe(0);
			expect(run.outputs.response).toBe("Hello from fixture Ryu.");
			expect(run.outputs["node-managed"]).toBe("true");
			expect(run.outputs["node-version"]).toBe("fixture-1.0.0");
			expect(run.outputs["run-id"]).toBe("run-fixture");
			expect(run.outputs["conversation-id"]).toBe("conversation-42");
			expect(run.env.RYU_CORE_URL).toBe(fixture.baseUrl);
			expect(run.env.RYU_NODE_URL).toBe(fixture.baseUrl);
			expect(run.env.RYU_CORE_TOKEN).toBe("fixture-token");
			expect(await readFile(join(run.tempDir, "response.txt"), "utf8")).toBe(
				"Hello from fixture Ryu."
			);
			const summary = await readFile(join(run.tempDir, "summary.md"), "utf8");
			expect(summary).toContain("Operation: `run`");
			expect(summary).toContain("managed=true");
			expect(summary).not.toContain("fixture-token");

			const chat = fixture.requests.find(
				(request) => request.path === "/api/chat/stream"
			);
			expect(chat?.headers.authorization).toBe("Bearer fixture-token");
			expect(chat?.headers.accept).toBe("text/event-stream");
			expect(chat?.method).toBe("POST");
			expect(chat?.body).toEqual({
				agent_id: "release-agent",
				conversation_id: "conversation-42",
				cwd: "/workspace/project",
				enable_long_term: true,
				inference: { temperature: 0 },
				persist: true,
				plugin_flags: { "com.ryu.audit": false },
				worktree_isolation: true,
				messages: [
					{
						content: [{ text: "Verify the release candidate.", type: "text" }],
						role: "user",
					},
				],
			});
		} finally {
			await cleanup(run);
			fixture.stop();
		}
	});

	it("validates a self-hosted setup and executes a direct allowlisted tool", async () => {
		const selfHosted = startFixture(false);
		const setup = await runBundle(
			{
				"node-token": "fixture-token",
				"node-url": selfHosted.baseUrl,
				operation: "setup",
				target: "self-hosted",
			},
			selfHosted
		);
		try {
			if (setup.status !== 0) {
				throw new Error(`bundle failed: ${setup.stdout}\n${setup.stderr}`);
			}
			expect(setup.status).toBe(0);
			expect(setup.outputs["node-managed"]).toBe("false");
			expect(setup.env.RYU_CORE_URL).toBe(selfHosted.baseUrl);
		} finally {
			await cleanup(setup);
			selfHosted.stop();
		}

		const managed = startFixture(true);
		const tool = await runBundle(
			{
				agent: "release-agent",
				"managed-node-token": "fixture-token",
				"managed-node-url": managed.baseUrl,
				operation: "tool",
				"tool-arguments": '{"tag":"v1"}',
				tool: "github.create_release",
				"user-id": "ci-user",
				target: "managed",
			},
			managed
		);
		try {
			expect(tool.status).toBe(0);
			expect(JSON.parse(tool.outputs["result-json"] ?? "null")).toEqual({
				error: null,
				ok: true,
				output: { checked: true, source: "fixture-tool" },
			});
			const call = managed.requests.find(
				(request) => request.path === "/api/mcp/tools/call"
			);
			expect(call?.method).toBe("POST");
			expect(call?.headers.accept).toBe("application/json");
			expect(call?.headers.authorization).toBe("Bearer fixture-token");
			expect(call?.body).toEqual({
				agent_id: "release-agent",
				arguments: { tag: "v1" },
				tool: "github.create_release",
				user_id: "ci-user",
			});
		} finally {
			await cleanup(tool);
			managed.stop();
		}
	});

	it("fails closed when managed targeting reaches a self-hosted node", async () => {
		const fixture = startFixture(false);
		const run = await runBundle(
			{
				"managed-node-token": "fixture-token",
				"managed-node-url": fixture.baseUrl,
				operation: "setup",
				target: "managed",
			},
			fixture
		);
		try {
			expect(run.status).not.toBe(0);
			expect(`${run.stdout}\n${run.stderr}`).toContain("managed=false");
			expect(
				fixture.requests.some((request) => request.path === "/api/chat/stream")
			).toBe(false);
		} finally {
			await cleanup(run);
			fixture.stop();
		}
	});
});
