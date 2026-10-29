import { readFile } from "node:fs/promises";

import { z } from "zod";
import type { ProofJsonRecord } from "./fixture-json.ts";
import {
	type FixtureBinding,
	type FixtureRun,
	type FixtureVersion,
	parseCompanionBinding,
	parseCompanionRecipes,
	parseCompanionRunInput,
} from "./workflow-companion-fixture-contract.ts";
import {
	parseWorkflowFixtureArgs,
	parseWorkflowFixtureReset,
	parseWorkflowFixtureSave,
	type WorkflowDefinition,
} from "./workflow-fixture-contract.ts";

interface FixtureCall {
	args: ProofJsonRecord;
	method: string;
}

interface FixtureState {
	bindings: Record<string, FixtureBinding[]>;
	calls: FixtureCall[];
	failures: Record<string, number>;
	nextBindingId: number;
	nextId: number;
	nextRunId: number;
	nextVersionId: number;
	recipes: ProofJsonRecord[];
	recording: ProofJsonRecord | null;
	recordStopResult: ProofJsonRecord | null;
	runs: Record<string, FixtureRun>;
	versions: Record<string, FixtureVersion[]>;
	workflows: WorkflowDefinition[];
}

const appHtml = await readFile(
	"/tmp/ryu-workflows-coverage-build/index.html",
	"utf8"
);
const bridgeScript = `<script>
const callCoreFixture = async (method, args = {}) => {
  const response = await fetch("/__fixture/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Core request failed");
  return result;
};
const params = new URLSearchParams(location.search);
const workflowId = params.get("workflowId");
window.ryu = {
  context: workflowId ? { workflowId } : null,
  catalog: { snapshot: async () => ({ agents: [], models: [], providers: [] }) },
  ghost: {
    recipes: () => callCoreFixture("ghost.recipes"),
    recordStart: (args) => callCoreFixture("ghost.recordStart", args),
    recordStatus: () => callCoreFixture("ghost.recordStatus"),
    recordStop: () => callCoreFixture("ghost.recordStop"),
  },
  workflows: {
    list: () => callCoreFixture("workflows.list"),
    save: (definition) => callCoreFixture("workflows.save", definition),
    run: (args) => callCoreFixture("workflows.run", args),
    runGet: (args) => callCoreFixture("workflows.runGet", args),
    resume: (args) => callCoreFixture("workflows.resume", args),
    versionsList: (args) => callCoreFixture("workflows.versionsList", args),
    versionGet: (args) => callCoreFixture("workflows.versionGet", args),
    versionCreate: (args) => callCoreFixture("workflows.versionCreate", args),
    versionRestore: (args) => callCoreFixture("workflows.versionRestore", args),
    connectBindings: (args) => callCoreFixture("workflows.connectBindings", args),
    bindConnectTrigger: (args) => callCoreFixture("workflows.bindConnectTrigger", args),
    removeConnectBinding: (args) => callCoreFixture("workflows.removeConnectBinding", args),
    composio: (args) => callCoreFixture("workflows.composio", args),
    schedules: async () => [],
    apps: async () => [],
    mcp: async () => ({ servers: [], tools: [] }),
    skills: async () => [],
    notifyTargets: () => callCoreFixture("workflows.notifyTargets"),
    hookEvents: async () => [],
  },
};
</script>`;
const html = appHtml.replace("<head>", `<head>${bridgeScript}`);
if (html === appHtml) {
	throw new Error("The production Workflows bundle has no document head.");
}

const emptyState = (): FixtureState => ({
	bindings: {},
	calls: [],
	failures: {},
	nextBindingId: 1,
	nextId: 1,
	nextRunId: 1,
	nextVersionId: 1,
	recording: null,
	recordStopResult: null,
	recipes: [],
	runs: {},
	versions: {},
	workflows: [],
});

let state = emptyState();

function json<FixturePayload>(value: FixturePayload, status = 200): Response {
	return Response.json(value, { status });
}

async function readArgs(request: Request) {
	return parseWorkflowFixtureArgs(await request.text());
}

function failIfConfigured(method: string): Response | null {
	const remaining = state.failures[method] ?? 0;
	if (remaining <= 0) {
		return null;
	}
	state.failures[method] = remaining - 1;
	return json({ error: `Fixture ${method} temporarily unavailable` }, 503);
}

function workflowById(id: string): WorkflowDefinition | undefined {
	return state.workflows.find((workflow) => workflow.id === id);
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 5271,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return new Response("ok");
		}
		if (url.pathname === "/__fixture/reset" && request.method === "POST") {
			const input = parseWorkflowFixtureReset(await readArgs(request));
			state = emptyState();
			state.failures = input.failures ?? {
				"workflows.save": 1,
			};
			state.workflows = structuredClone(input.workflows ?? []);
			state.recordStopResult = input.recordStopResult ?? null;
			state.recipes = structuredClone(parseCompanionRecipes(input.recipes));
			return json({ ok: true });
		}
		if (url.pathname === "/__fixture/state") {
			return json({
				bindings: state.bindings,
				calls: state.calls,
				failures: state.failures,
				runs: state.runs,
				versions: state.versions,
				workflows: state.workflows,
			});
		}
		if (
			url.pathname === "/__fixture/inject-connect-binding" &&
			request.method === "POST"
		) {
			const input = await readArgs(request);
			const id = String(input.id ?? "");
			const binding = structuredClone(parseCompanionBinding(input.binding));
			state.bindings[id] = [...(state.bindings[id] ?? []), binding];
			if (input.failNextRefresh === true) {
				state.failures["workflows.connectBindings"] = 1;
			}
			return json({ ok: true });
		}
		if (request.method === "POST" && url.pathname.startsWith("/__fixture/")) {
			const method = url.pathname.slice("/__fixture/".length);
			const args = await readArgs(request);
			state.calls.push({ args: structuredClone(args), method });

			if (method === "workflows.list") {
				return json(structuredClone(state.workflows));
			}
			if (method === "workflows.notifyTargets") {
				return json([
					{
						email: "ada@example.test",
						id: "user-ada",
						image: null,
						name: "Ada Chen",
						role: "member",
					},
					{
						email: "bea@example.test",
						id: "user-bea",
						image: null,
						name: "Bea Patel",
						role: "admin",
					},
					{
						email: "avery@example.test",
						id: "user-avery",
						image: null,
						name: "Avery Kim",
						role: "member",
					},
				]);
			}
			if (method === "workflows.save") {
				const failure = failIfConfigured(method);
				if (failure) {
					return failure;
				}
				// `updated_at` is the canvas's optimistic-concurrency precondition;
				// Core checks it and never stores it as workflow content.
				const { updated_at: _expectedUpdatedAt, ...definition } =
					structuredClone(parseWorkflowFixtureSave(args));
				const id = definition.id || `workflow-created-${state.nextId++}`;
				const saved = { ...definition, id };
				const index = state.workflows.findIndex(
					(workflow) => workflow.id === id
				);
				if (index < 0) {
					state.workflows.push(saved);
				} else {
					state.workflows[index] = saved;
				}
				return json(structuredClone(saved));
			}
			if (method === "workflows.run") {
				const failure = failIfConfigured(method);
				if (failure) {
					return failure;
				}
				const id = String(args.id ?? "");
				const workflow = workflowById(id);
				if (!workflow) {
					return json({ error: "Fixture workflow not found" }, 404);
				}
				const input = parseCompanionRunInput(args.input);
				const gate = workflow.nodes.find((node) => node.type === "awakeable");
				const dryRun = args.dryRun === true;
				const runId = `workflow-run-${state.nextRunId++}`;
				const outputKey =
					workflow.nodes.find((node) => node.type === "output")?.key ??
					"result";
				const result: FixtureRun = {
					awaitingNode: gate?.id ?? null,
					createdAt: new Date(0).toISOString(),
					dryRun,
					input,
					nodes: Object.fromEntries(
						workflow.nodes.map((node) => [
							node.id,
							{
								output: input[Object.keys(input)[0] ?? ""] ?? "",
								status: gate ? "pending" : "completed",
							},
						])
					),
					output: gate
						? {}
						: { [String(outputKey)]: input[Object.keys(input)[0] ?? ""] ?? "" },
					runId,
					status: gate ? "awaiting_input" : "completed",
					updatedAt: new Date(0).toISOString(),
					workflowId: id,
				};
				state.runs[runId] = structuredClone(result);
				return json(result);
			}
			if (method === "workflows.runGet") {
				const run = state.runs[String(args.runId ?? "")];
				return run
					? json(structuredClone(run))
					: json({ error: "Fixture run not found" }, 404);
			}
			if (method === "workflows.resume") {
				const failure = failIfConfigured(method);
				if (failure) {
					return failure;
				}
				const runId = String(args.runId ?? "");
				const run = state.runs[runId];
				if (!run) {
					return json({ error: "Fixture run not found" }, 404);
				}
				const workflow = workflowById(run.workflowId);
				const payload = String(args.payload ?? "");
				const resumed: FixtureRun = {
					...run,
					awaitingNode: null,
					nodes: Object.fromEntries(
						(workflow?.nodes ?? []).map((node) => [
							node.id,
							{
								output: node.type === "awakeable" ? payload : "",
								status: "completed",
							},
						])
					),
					output: { review: payload },
					status: "completed",
				};
				state.runs[runId] = structuredClone(resumed);
				return json(resumed);
			}
			if (method === "workflows.versionsList") {
				return json(
					(state.versions[String(args.id ?? "")] ?? []).map(
						({ createdAt, id, label, name, workflowId }) => ({
							createdAt,
							id,
							label,
							name,
							workflowId,
						})
					)
				);
			}
			if (method === "workflows.versionGet") {
				const version = (state.versions[String(args.id ?? "")] ?? []).find(
					(item) => item.id === args.versionId
				);
				return version
					? json(structuredClone(version.definition))
					: json({ error: "Fixture version not found" }, 404);
			}
			if (method === "workflows.versionCreate") {
				const id = String(args.id ?? "");
				const workflow = workflowById(id);
				if (!workflow) {
					return json({ error: "Fixture workflow not found" }, 404);
				}
				const version: FixtureVersion = {
					createdAt: state.nextVersionId,
					definition: structuredClone(workflow),
					id: `workflow-version-${state.nextVersionId++}`,
					label: z.string().safeParse(args.label).data ?? null,
					name: workflow.name,
					workflowId: id,
				};
				state.versions[id] = [version, ...(state.versions[id] ?? [])];
				return json({ ok: true });
			}
			if (method === "workflows.versionRestore") {
				const failure = failIfConfigured(method);
				if (failure) {
					return failure;
				}
				const id = String(args.id ?? "");
				const version = (state.versions[id] ?? []).find(
					(item) => item.id === args.versionId
				);
				if (!version) {
					return json({ error: "Fixture version not found" }, 404);
				}
				const restored = { ...structuredClone(version.definition), id };
				const index = state.workflows.findIndex(
					(workflow) => workflow.id === id
				);
				if (index >= 0) {
					state.workflows[index] = restored;
				}
				return json(restored);
			}
			if (method === "workflows.composio") {
				return json({ configured: true, executionOwner: "connect" });
			}
			if (method === "workflows.connectBindings") {
				const failure = failIfConfigured(method);
				if (failure) {
					return failure;
				}
				return json(
					structuredClone(state.bindings[String(args.id ?? "")] ?? [])
				);
			}
			if (method === "workflows.bindConnectTrigger") {
				const failure = failIfConfigured(method);
				if (failure) {
					return failure;
				}
				const id = String(args.id ?? "");
				const connectTriggerId = String(args.connectTriggerId ?? "");
				// Core answers with its full trigger subscription record.
				const binding = {
					agentId: "",
					composioTriggerId: connectTriggerId,
					connectedAccountId: "fixture-connected-account",
					createdAt: new Date(0).toISOString(),
					id: `binding-${state.nextBindingId++}`,
					targetKind: "workflow",
					toolkit: "github",
					triggerId: connectTriggerId,
					triggerSlug: "github.issue.created",
					workflowId: id,
				};
				state.bindings[id] = [...(state.bindings[id] ?? []), binding];
				return json(binding);
			}
			if (method === "workflows.removeConnectBinding") {
				const failure = failIfConfigured(method);
				if (failure) {
					return failure;
				}
				const id = String(args.id ?? "");
				state.bindings[id] = (state.bindings[id] ?? []).filter(
					(binding) => binding.id !== args.bindingId
				);
				return json({ ok: true });
			}
			if (method === "ghost.recipes") {
				return json(structuredClone(state.recipes));
			}
			if (method === "ghost.recordStart") {
				const failure = failIfConfigured(method);
				if (failure) {
					return failure;
				}
				state.recording = {
					recording: true,
					status: { elapsed_secs: 0, event_count: 0 },
					task: String(args.task ?? ""),
				};
				return json(structuredClone(state.recording));
			}
			if (method === "ghost.recordStatus") {
				return json(
					structuredClone(state.recording ?? { recording: false, status: {} })
				);
			}
			if (method === "ghost.recordStop") {
				const failure = failIfConfigured(method);
				if (failure) {
					return failure;
				}
				state.recording = null;
				return json(
					structuredClone(
						state.recordStopResult ?? {
							event_count: 0,
							events: [],
							recording: false,
							started_at: new Date(0).toISOString(),
							task: "Fixture recording",
						}
					)
				);
			}
			return json({ error: "Unsupported fixture method" }, 404);
		}
		if (url.pathname === "/favicon.ico") {
			return new Response(null, { status: 204 });
		}
		return new Response(html, {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	},
});

const stop = () => server.stop();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
