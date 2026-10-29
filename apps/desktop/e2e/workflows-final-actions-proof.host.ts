import { readFile } from "node:fs/promises";

import { z } from "zod";
import type { ProofJsonRecord } from "./fixture-json.ts";
import {
	parseWorkflowFixtureArgs,
	parseWorkflowFixtureReset,
	parseWorkflowFixtureSave,
	type TriggerFixtureState,
} from "./workflow-fixture-contract.ts";

interface FixtureState
	extends Pick<
		TriggerFixtureState,
		"calls" | "failures" | "nextId" | "workflows"
	> {
	recording: ProofJsonRecord | null;
	recordStopResult: ProofJsonRecord;
}
const runInputSchema = z.record(z.string(), z.string());

const appHtml = await readFile(
	"/tmp/ryu-workflows-final-actions-build/index.html",
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
  catalog: { snapshot: async () => ({ agents: [], models: [], providers: [] }) },
  ghost: {
    recipes: () => callFixture("ghost.recipes"),
    recordStart: (args) => callFixture("ghost.recordStart", args),
    recordStatus: () => callFixture("ghost.recordStatus"),
    recordStop: () => callFixture("ghost.recordStop"),
  },
  workflows: {
    list: () => callFixture("workflows.list"),
    save: (definition) => callFixture("workflows.save", definition),
    run: (args) => callFixture("workflows.run", args),
    runGet: (args) => callFixture("workflows.runGet", args),
    resume: (args) => callFixture("workflows.resume", args),
    versionsList: async () => [],
    versionGet: async () => null,
    versionCreate: async () => null,
    versionRestore: async () => null,
    connectBindings: async () => [],
    bindConnectTrigger: async () => null,
    removeConnectBinding: async () => null,
    composio: async () => ({}),
    schedules: async () => [],
    apps: async () => [],
    mcp: async () => ({ servers: [], tools: [] }),
    skills: async () => [],
    notifyTargets: async () => [],
    hookEvents: async () => [],
  },
};
</script>`;
const html = appHtml.replace("<head>", `<head>${bridgeScript}`);
if (html === appHtml) {
	throw new Error("The production Workflows bundle has no document head.");
}

function emptyState(): FixtureState {
	return {
		calls: [],
		failures: {},
		nextId: 1,
		recording: null,
		recordStopResult: {
			draft: {
				description: "A label is applied to the launch request.",
				name: "Apply launch label",
				schema_version: 1,
				steps: [
					{
						action: "click",
						id: 1,
						params: { label: "launch" },
						target: {
							query: "button#assign-label",
							role: "button",
						},
					},
				],
			},
			event_count: 1,
			events: [
				{
					event_type: "click",
					element_name: "Assign launch label",
					element_role: "button",
					ts_ms: 250,
				},
			],
			recording: false,
			started_at: new Date(0).toISOString(),
			task: "Apply launch label",
		},
		workflows: [],
	};
}

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

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 5291,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return new Response("ok");
		}
		if (url.pathname === "/__fixture/reset" && request.method === "POST") {
			const input = parseWorkflowFixtureReset(await readArgs(request));
			state = emptyState();
			state.failures = input.failures ?? {};
			state.workflows = structuredClone(input.workflows ?? []);
			state.recordStopResult = structuredClone(
				input.recordStopResult ?? state.recordStopResult
			);
			return json({ ok: true });
		}
		if (url.pathname === "/__fixture/state") {
			return json(structuredClone(state));
		}
		if (request.method === "POST" && url.pathname.startsWith("/__fixture/")) {
			const method = url.pathname.slice("/__fixture/".length);
			const args = await readArgs(request);
			state.calls.push({ args: structuredClone(args), method });

			if (method === "ghost.recipes") {
				return json([]);
			}
			if (method === "ghost.recordStart") {
				const failure = failIfConfigured(method);
				if (failure) {
					return failure;
				}
				state.recording = {
					recording: true,
					started_at: new Date(0).toISOString(),
					status: { elapsed_secs: 3, event_count: 1 },
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
				return json(structuredClone(state.recordStopResult));
			}
			if (method === "workflows.list") {
				const failure = failIfConfigured(method);
				if (failure) {
					return failure;
				}
				return json(structuredClone(state.workflows));
			}
			if (method === "workflows.save") {
				const failure = failIfConfigured(method);
				if (failure) {
					return failure;
				}
				const definition = structuredClone(parseWorkflowFixtureSave(args));
				const id = definition.id || `final-actions-workflow-${state.nextId++}`;
				const saved = { ...definition, id };
				const index = state.workflows.findIndex(
					(workflow) => workflow.id === id
				);
				if (index === -1) {
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
				const workflow = state.workflows.find(
					(candidate) => candidate.id === id
				);
				if (!workflow) {
					return json({ error: "Fixture workflow not found" }, 404);
				}
				const input = runInputSchema.parse(args.input ?? {});
				const outputNode = workflow.nodes.find(
					(node) => node.type === "output"
				);
				const outputKey =
					z.string().safeParse(outputNode?.key).data ?? "summary";
				const customerId = input.customer_id ?? "unknown";
				return json({
					awaitingNode: null,
					createdAt: new Date(0).toISOString(),
					dryRun: args.dryRun === true,
					input: structuredClone(input),
					nodes: Object.fromEntries(
						workflow.nodes.map((node) => [
							node.id,
							{ output: customerId, status: "completed" },
						])
					),
					output: {
						[outputKey]: `Preview result for ${customerId}`,
					},
					runId: "dry-run-001",
					status: "completed",
					updatedAt: new Date(0).toISOString(),
					workflowId: id,
				});
			}
			return json({ error: `Unsupported fixture method: ${method}` }, 404);
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
