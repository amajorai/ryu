import { readFile } from "node:fs/promises";
import type { ProofJsonRecord } from "./fixture-json.ts";
import {
	parseWorkflowFixtureArgs,
	parseWorkflowFixtureReset,
	parseWorkflowFixtureSave,
	type WorkflowCatalogFixtureState,
} from "./workflow-fixture-contract.ts";

type FixtureState = WorkflowCatalogFixtureState;

const appHtml = await readFile(
	"/tmp/ryu-workflows-agent-coverage-build/index.html",
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
  catalog: { snapshot: () => callFixture("catalog.snapshot") },
  ghost: { recipes: async () => [] },
  workflows: {
    list: () => callFixture("workflows.list"),
    save: (definition) => callFixture("workflows.save", definition),
    apps: () => callFixture("workflows.apps"),
    mcp: () => callFixture("workflows.mcp"),
    skills: () => callFixture("workflows.skills"),
    schedules: async () => [],
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
		agents: [],
		apps: [],
		calls: [],
		failures: {},
		mcp: { servers: [], tools: [] },
		nextId: 1,
		skills: [],
		workflows: [],
	};
}

let state = emptyState();

function json<FixturePayload>(value: FixturePayload, status = 200): Response {
	return Response.json(value, { status });
}

async function readArgs(request: Request): Promise<ProofJsonRecord> {
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
	port: 5279,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return new Response("ok");
		}
		if (url.pathname === "/__fixture/reset" && request.method === "POST") {
			const input = parseWorkflowFixtureReset(await readArgs(request));
			state = emptyState();
			state.failures = input.failures ?? {};
			state.agents = structuredClone(input.agents ?? []);
			state.apps = structuredClone(input.apps ?? []);
			state.mcp = structuredClone(
				input.mcp ?? {
					servers: [],
					tools: [],
				}
			);
			state.skills = structuredClone(input.skills ?? []);
			state.workflows = structuredClone(input.workflows ?? []);
			return json({ ok: true });
		}
		if (url.pathname === "/__fixture/state") {
			return json({ calls: state.calls, workflows: state.workflows });
		}
		if (request.method === "POST" && url.pathname.startsWith("/__fixture/")) {
			const method = url.pathname.slice("/__fixture/".length);
			const args = await readArgs(request);
			state.calls.push({ args: structuredClone(args), method });
			switch (method) {
				case "catalog.snapshot":
					return json({
						agents: state.agents,
						apiTypes: [],
						current: {
							provider: "gateway",
							providerRouting: {},
							routing: "gateway",
						},
						hookEvents: [],
						hooks: [],
						plugins: [],
						providers: [],
						thinkingLevels: [],
						version: 1,
					});
				case "workflows.list":
					return json(structuredClone(state.workflows));
				case "workflows.apps":
					return json(structuredClone(state.apps));
				case "workflows.mcp":
					return json(structuredClone(state.mcp));
				case "workflows.skills":
					return json(structuredClone(state.skills));
				case "workflows.save": {
					const failure = failIfConfigured(method);
					if (failure) {
						return failure;
					}
					const definition = structuredClone(parseWorkflowFixtureSave(args));
					const id = definition.id || `agent-workflow-${state.nextId++}`;
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
