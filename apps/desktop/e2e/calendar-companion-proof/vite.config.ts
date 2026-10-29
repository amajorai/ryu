import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
	isNativeBoolean,
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { z } from "zod";
import { type ProofJsonRecord, parseProofJson } from "../fixture-json.ts";

interface CoreJob {
	created_at: string;
	enabled: boolean;
	history: unknown[];
	id: string;
	last_outcome: string | null;
	last_run_at: string | null;
	name: string;
	require_approval: boolean;
	schedule: ProofJsonRecord;
	target: ProofJsonRecord;
	updated_at: string;
}

interface CoreWorkflow {
	edges: unknown[];
	id: string;
	name: string;
	nodes: ProofJsonRecord[];
	triggers: ProofJsonRecord[];
}

interface CapturedRequest {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
	userJwt: string | null;
}

interface FixtureState {
	createError: string;
	createFailuresRemaining: number;
	jobReadFailuresRemaining: number;
	jobs: CoreJob[];
	nextId: number;
	requests: CapturedRequest[];
	updateError: string;
	updateFailuresRemaining: number;
	workflows: CoreWorkflow[];
}

let state = emptyState();

function emptyState(): FixtureState {
	return {
		createError: "The schedule was rejected by Core.",
		createFailuresRemaining: 0,
		jobs: [],
		jobReadFailuresRemaining: 0,
		nextId: 1,
		requests: [],
		updateError: "The schedule update was rejected by Core.",
		updateFailuresRemaining: 0,
		workflows: [],
	};
}

async function readJson(request: IncomingMessage) {
	const chunks: Uint8Array[] = [];
	for await (const chunk of request) {
		chunks.push(isNativeText(chunk) ? Buffer.from(chunk) : chunk);
	}
	if (chunks.length === 0) {
		return {};
	}
	return parseProofJson(Buffer.concat(chunks).toString("utf8"));
}

function sendJson<FixturePayload>(
	response: ServerResponse,
	status: number,
	value: FixturePayload
): void {
	response.statusCode = status;
	response.setHeader("Content-Type", "application/json");
	response.end(JSON.stringify(value));
}

function recordRequest<Body>(
	request: IncomingMessage,
	path: string,
	body: Body | null = null
): void {
	state.requests.push({
		authorization: isNativeText(request.headers.authorization)
			? request.headers.authorization
			: null,
		body,
		method: request.method ?? "GET",
		path,
		userJwt: isNativeText(request.headers["x-ryu-user-jwt"])
			? request.headers["x-ryu-user-jwt"]
			: null,
	});
}

const coreJobSchema = z.object({
	created_at: z.string(),
	enabled: z.boolean(),
	history: z.array(z.json()),
	id: z.string(),
	last_outcome: z.string().nullable(),
	last_run_at: z.string().nullable(),
	name: z.string(),
	require_approval: z.boolean(),
	schedule: z.record(z.string(), z.json()),
	target: z.record(z.string(), z.json()),
	updated_at: z.string(),
});
const coreWorkflowSchema = z.object({
	edges: z.array(z.json()),
	id: z.string(),
	name: z.string(),
	nodes: z.array(z.record(z.string(), z.json())),
	triggers: z.array(z.record(z.string(), z.json())),
});
function jsonBody<RawInput>(value: RawInput): ProofJsonRecord {
	const parsed = z.record(z.string(), z.json()).safeParse(value);
	return parsed.success ? parsed.data : {};
}

function apiPlugin(): Plugin {
	return {
		name: "calendar-companion-proof-api",
		configureServer(server) {
			server.middlewares.use(async (request, response, next) => {
				const url = new URL(request.url ?? "/", "http://127.0.0.1");
				const { pathname } = url;
				if (pathname === "/__proof/reset" && request.method === "POST") {
					const input = jsonBody(await readJson(request));
					const base = emptyState();
					state = {
						...base,
						createError: isNativeText(input.createError)
							? input.createError
							: base.createError,
						createFailuresRemaining: isNativeNumber(
							input.createFailuresRemaining
						)
							? input.createFailuresRemaining
							: 0,
						jobs: Array.isArray(input.jobs)
							? z.array(coreJobSchema).parse(input.jobs)
							: [],
						jobReadFailuresRemaining: isNativeNumber(
							input.jobReadFailuresRemaining
						)
							? input.jobReadFailuresRemaining
							: 0,
						updateError: isNativeText(input.updateError)
							? input.updateError
							: base.updateError,
						updateFailuresRemaining: isNativeNumber(
							input.updateFailuresRemaining
						)
							? input.updateFailuresRemaining
							: 0,
						workflows: Array.isArray(input.workflows)
							? z.array(coreWorkflowSchema).parse(input.workflows)
							: [],
					};
					sendJson(response, 200, { ok: true });
					return;
				}
				if (pathname === "/__proof/state" && request.method === "GET") {
					sendJson(response, 200, state);
					return;
				}
				if (pathname === "/__proof/replace-jobs" && request.method === "POST") {
					const input = jsonBody(await readJson(request));
					state.jobs = Array.isArray(input.jobs)
						? z.array(coreJobSchema).parse(input.jobs)
						: [];
					sendJson(response, 200, { ok: true });
					return;
				}

				if (pathname === "/heartbeat/jobs" && request.method === "GET") {
					recordRequest(request, pathname);
					if (state.jobReadFailuresRemaining > 0) {
						state.jobReadFailuresRemaining -= 1;
						sendJson(response, 503, {
							error: "Calendar node is temporarily offline.",
						});
						return;
					}
					sendJson(response, 200, { jobs: state.jobs });
					return;
				}
				if (pathname === "/heartbeat/jobs" && request.method === "POST") {
					const body = jsonBody(await readJson(request));
					recordRequest(request, pathname, body);
					if (state.createFailuresRemaining > 0) {
						state.createFailuresRemaining -= 1;
						sendJson(response, 400, { error: state.createError });
						return;
					}
					const target = { ...jsonBody(body.target) };
					if (
						body.quick_routine === true &&
						(target.type !== "agent" || typeof target.agent_id !== "string")
					) {
						sendJson(response, 400, {
							success: false,
							error: "quick routine requires an agent target",
						});
						return;
					}
					// Core's POST quick_routine slot replaces this authorized agent's
					// existing routine atomically, retaining its identity and run history.
					// This local fixture has one selected-node authority; Core's actual
					// owner/org isolation and locking are exercised by its runtime tests.
					const candidates =
						body.quick_routine === true
							? state.jobs.filter(
									(candidate) =>
										candidate.name.endsWith(" (scheduled)") &&
										candidate.target.type === "agent" &&
										candidate.target.agent_id === target.agent_id
								)
							: [];
					if (candidates.length > 1) {
						sendJson(response, 409, {
							success: false,
							error: "multiple legacy quick routines require review",
						});
						return;
					}
					const previous = candidates[0];
					if (target.conversation_id === null) {
						Reflect.deleteProperty(target, "conversation_id");
					} else if (
						!("conversation_id" in target) &&
						previous?.target.conversation_id !== undefined
					) {
						target.conversation_id = previous.target.conversation_id;
					}
					const now = new Date().toISOString();
					const job: CoreJob = {
						...previous,
						created_at: previous?.created_at ?? now,
						enabled: body.enabled !== false,
						history: previous?.history ?? [],
						id: previous?.id ?? `calendar-proof-job-${state.nextId++}`,
						last_outcome: previous?.last_outcome ?? null,
						last_run_at: previous?.last_run_at ?? null,
						name: String(body.name ?? "").trim(),
						require_approval: body.require_approval === true,
						schedule: jsonBody(body.schedule),
						target,
						updated_at: now,
					};
					if (previous) {
						state.jobs[state.jobs.indexOf(previous)] = job;
					} else {
						state.jobs.push(job);
					}
					sendJson(response, 200, { success: true, job });
					return;
				}

				const jobPath = /^\/heartbeat\/jobs\/([^/]+)$/.exec(pathname);
				if (jobPath && request.method === "PUT") {
					const body = jsonBody(await readJson(request));
					recordRequest(request, pathname, body);
					if (state.updateFailuresRemaining > 0) {
						state.updateFailuresRemaining -= 1;
						sendJson(response, 400, { error: state.updateError });
						return;
					}
					const job = state.jobs.find(
						(candidate) => candidate.id === jobPath[1]
					);
					if (!job) {
						sendJson(response, 404, { error: "Scheduled job not found." });
						return;
					}
					if (isNativeText(body.name)) {
						job.name = body.name;
					}
					if (body.schedule !== undefined) {
						job.schedule = jsonBody(body.schedule);
					}
					if (body.target !== undefined) {
						job.target = jsonBody(body.target);
					}
					if (isNativeBoolean(body.enabled)) {
						job.enabled = body.enabled;
					}
					if (isNativeBoolean(body.require_approval)) {
						job.require_approval = body.require_approval;
					}
					job.updated_at = new Date().toISOString();
					sendJson(response, 200, { job });
					return;
				}

				if (pathname === "/workflows" && request.method === "GET") {
					recordRequest(request, pathname);
					sendJson(response, 200, { workflows: state.workflows });
					return;
				}
				const workflowPath = /^\/workflows\/([^/]+)$/.exec(pathname);
				if (workflowPath && request.method === "DELETE") {
					recordRequest(request, pathname);
					state.workflows = state.workflows.filter(
						(workflow) =>
							workflow.id !== decodeURIComponent(workflowPath[1] ?? "")
					);
					response.statusCode = 204;
					response.end();
					return;
				}
				if (pathname === "/api/agents" && request.method === "GET") {
					recordRequest(request, pathname);
					sendJson(response, 200, { agents: [] });
					return;
				}
				next();
			});
		},
	};
}

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react(), apiPlugin()],
	root: harnessDir,
	base: "/",
	clearScreen: false,
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: { "process.env": {} },
	resolve: {
		alias: [
			{
				find: "@/lib/auth-client.ts",
				replacement: path.resolve(harnessDir, "auth-client.ts"),
			},
			{ find: "@", replacement: desktopRoot },
		],
	},
	optimizeDeps: {
		entries: [
			path.resolve(harnessDir, "calendar-companion-proof.html"),
			path.resolve(harnessDir, "button-layout-proof.html"),
		],
		include: ["react", "react-dom/client"],

		esbuildOptions: { target: "esnext" },
	},
	server: {
		host: "127.0.0.1",
		port: 5291,
		strictPort: true,
	},
});
