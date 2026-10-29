import { readFile } from "node:fs/promises";

import {
	parseWorkflowFixtureArgs,
	parseWorkflowFixtureReset,
	parseWorkflowFixtureSave,
	type WorkflowCatalogFixtureState,
} from "./workflow-fixture-contract.ts";

type FixtureState = Pick<
	WorkflowCatalogFixtureState,
	"agents" | "calls" | "failures" | "nextId" | "workflows"
>;

const appHtml = await readFile(
	"/tmp/ryu-workflows-node-config-coverage-build/index.html",
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
	return { agents: [], calls: [], failures: {}, nextId: 1, workflows: [] };
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
	port: 5285,
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
			if (method === "catalog.snapshot") {
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
			}
			if (method === "workflows.list") {
				return json(structuredClone(state.workflows));
			}
			if (method === "workflows.save") {
				const failure = failIfConfigured(method);
				if (failure) {
					return failure;
				}
				const definition = structuredClone(parseWorkflowFixtureSave(args));
				const id = definition.id || `node-config-workflow-${state.nextId++}`;
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
