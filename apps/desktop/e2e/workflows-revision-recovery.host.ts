import { readFile } from "node:fs/promises";

import { z } from "zod";
import {
	parseWorkflowFixtureArgs,
	parseWorkflowFixtureDefinition,
	parseWorkflowFixtureReset,
	parseWorkflowFixtureSave,
	type TriggerFixtureState,
	type WorkflowDefinition,
} from "./workflow-fixture-contract.ts";

type FixtureState = TriggerFixtureState;
interface FixtureVersion {
	id: string;
	workflow: WorkflowDefinition | undefined;
}

const appHtml = await readFile(
	"/tmp/ryu-workflows-revision-recovery-build/index.html",
	"utf8"
);
const bridgeScript = `<script>
const callFixture = async (method, args = {}) => {
  const response = await fetch("/__fixture/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Fixture request failed");
  return result;
};
const workflowId = new URLSearchParams(location.search).get("workflowId");
window.ryu = {
  context: workflowId ? { workflowId } : null,
  catalog: { snapshot: async () => ({ agents: [], apiTypes: [], current: { provider: "gateway", providerRouting: {}, routing: "gateway" }, hookEvents: [], hooks: [], plugins: [], providers: [], thinkingLevels: [], version: 1 }) },
  ghost: { recipes: async () => [] },
  workflows: {
    list: () => callFixture("workflows.list"),
    get: (args) => callFixture("workflows.get", args),
    versionsList: (args) => callFixture("workflows.versionsList", args),
    versionCreate: (args) => callFixture("workflows.versionCreate", args),
    save: (definition) => callFixture("workflows.save", definition),
    webhook: (args) => callFixture("workflows.webhook", args),
    hookEvents: () => callFixture("workflows.hookEvents"),
    composio: (args) => callFixture("workflows.composio", args),
    connectBindings: (args) => callFixture("workflows.connectBindings", args),
    bindConnectTrigger: (args) => callFixture("workflows.bindConnectTrigger", args),
    removeConnectBinding: (args) => callFixture("workflows.removeConnectBinding", args),
    schedules: async () => [],
    apps: async () => [],
    mcp: async () => ({ servers: [], tools: [] }),
    skills: async () => [],
    notifyTargets: async () => [],
  },
};
</script>`;
const html = appHtml.replace("<head>", `<head>${bridgeScript}`);
if (html === appHtml) {
	throw new Error("The production Workflows bundle has no document head.");
}

function emptyState(): FixtureState {
	return {
		appEvents: [],
		calls: [],
		composioTriggers: [],
		failures: {},
		nextId: 1,
		toolkits: [],
		workflows: [],
	};
}

let state = emptyState();
let revision = 1;
let versions: FixtureVersion[] = [];

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

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 5289,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return new Response("ok");
		}
		if (url.pathname === "/__fixture/reset" && request.method === "POST") {
			const input = parseWorkflowFixtureReset(await readArgs(request));
			state = emptyState();
			revision = 1;
			versions = [];
			state.failures = input.failures ?? {};
			state.workflows = structuredClone(input.workflows ?? []);
			state.appEvents = structuredClone(input.appEvents ?? []);
			state.toolkits = structuredClone(input.toolkits ?? []);
			state.composioTriggers = structuredClone(input.composioTriggers ?? []);
			return json({ ok: true });
		}
		if (
			url.pathname === "/__fixture/external-save" &&
			request.method === "POST"
		) {
			const replacement = await readArgs(request);
			state.workflows[0] = parseWorkflowFixtureDefinition({
				...state.workflows[0],
				...replacement,
				updatedAt: `revision-${++revision}`,
			});
			return json(state.workflows[0]);
		}
		if (url.pathname === "/__fixture/state") {
			return json({ calls: state.calls, workflows: state.workflows, versions });
		}
		if (request.method === "POST" && url.pathname.startsWith("/__fixture/")) {
			const method = url.pathname.slice("/__fixture/".length);
			const args = await readArgs(request);
			state.calls.push({ args: structuredClone(args), method });
			switch (method) {
				case "workflows.list":
					return json(structuredClone(state.workflows));
				case "workflows.get": {
					const failure = failIfConfigured(method);
					return (
						failure ??
						json(state.workflows.find((workflow) => workflow.id === args.id))
					);
				}
				case "workflows.versionsList":
					return json(versions);
				case "workflows.versionCreate": {
					const workflow = state.workflows.find(
						(workflow) => workflow.id === args.id
					);
					if (
						args.expectedRevision !== undefined &&
						args.expectedRevision !== workflow?.updatedAt
					) {
						return json(
							{
								success: false,
								code: "workflow_revision_conflict",
								error:
									"workflow revision conflict: it was changed since it was saved",
								current_updated_at: workflow?.updatedAt,
							},
							409
						);
					}
					versions.push({
						id: `version-${versions.length + 1}`,
						workflow: structuredClone(
							state.workflows.find((workflow) => workflow.id === args.id)
						),
					});
					return json({ ok: true });
				}
				case "workflows.save": {
					const failure = failIfConfigured(method);
					if (failure) {
						return failure;
					}
					const definition = structuredClone(parseWorkflowFixtureSave(args));
					const id = definition.id || `trigger-workflow-${state.nextId++}`;
					const stored = state.workflows.find((workflow) => workflow.id === id);
					if (
						stored &&
						z.string().safeParse(definition.updated_at).success &&
						definition.updated_at !== stored.updatedAt
					) {
						const { updatedAt, ...storedDefinition } = stored;
						return json(
							{
								success: false,
								code: "workflow_revision_conflict",
								error:
									"workflow revision conflict: it was changed since it was loaded",
								current_updated_at: updatedAt,
								workflow: { ...storedDefinition, updated_at: updatedAt },
							},
							409
						);
					}
					const saved = {
						...definition,
						id,
						updatedAt: `revision-${++revision}`,
					};
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
				case "workflows.hookEvents":
					return json(structuredClone(state.appEvents));
				case "workflows.webhook":
					return json({
						url: `https://node.example.test/api/workflows/${String(args.id ?? "")}/webhook`,
					});
				case "workflows.composio": {
					const failure = failIfConfigured(method);
					if (failure) {
						return failure;
					}
					if (args.kind === "status") {
						return json({ configured: true });
					}
					if (args.kind === "toolkits") {
						return json(structuredClone(state.toolkits));
					}
					if (args.kind === "triggers") {
						return json(structuredClone(state.composioTriggers));
					}
					return json([]);
				}
				default:
					return json({ error: "Unsupported fixture method" }, 404);
			}
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
