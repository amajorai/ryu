import { afterEach, expect, test } from "bun:test";
import { type PluginValue, pluginValueSchema } from "./plugin-wire-values.ts";
import {
	workflowEnvelopeSchema,
	workflowRunEnvelopeSchema,
} from "./workflow-wire-contracts.ts";
import {
	createWorkflow,
	fetchWorkflow,
	fetchWorkflowTemplate,
	fetchWorkflowTemplates,
	getWorkflowRun,
	getWorkflowVersionDefinition,
	installWorkflowTemplate,
	type NodeRunState,
	previewWorkflowTemplateInstall,
	runWorkflow,
} from "./workflows.ts";

const originalFetch = globalThis.fetch;
const target = { token: null, url: "https://workflow.test" };
afterEach(() => {
	globalThis.fetch = originalFetch;
});
function respond(body: PluginValue, status = 200) {
	globalThis.fetch = Object.assign(
		async () => Response.json(pluginValueSchema.parse(body), { status }),
		{ preconnect: originalFetch.preconnect }
	);
}

test("workflow normalization retains extensible node configuration and legacy null defaults", async () => {
	const node = {
		id: "future",
		type: "future_kind",
		config: { nested: [true, null, "kept"] },
	};
	const nodes = [node];
	const parsed = workflowEnvelopeSchema.parse({
		workflow: {
			id: "w",
			name: "Workflow",
			nodes,
			edges: null,
			triggers: null,
			chat_input: null,
		},
	}).workflow;
	expect(parsed.nodes).toBe(nodes);
	expect(parsed.nodes[0]).toBe(node);
	expect(parsed).toEqual({
		id: "w",
		name: "Workflow",
		description: null,
		nodes,
		edges: [],
		triggers: [],
		chatInput: false,
		createdAt: null,
		updatedAt: null,
	});
	respond({ workflow: { id: "w", name: "Workflow" } });
	expect((await fetchWorkflow(target, "w")).nodes).toEqual([]);
	respond({
		workflow: { id: "w", name: "Workflow", nodes: [{ id: "broken" }] },
	});
	await expect(fetchWorkflow(target, "w")).rejects.toThrow();
});

test("run records preserve maps, own prototype keys and camelCase dry-run priority", async () => {
	const input = JSON.parse('{"__proto__":"retained","message":"start"}');
	const nodeState = {
		status: "completed",
		output: "done",
		metadata: { future: true },
	} satisfies NodeRunState & { metadata: { future: boolean } };
	const nodes = { n: nodeState };
	const wire = {
		run_id: "r",
		workflow_id: "w",
		status: "completed",
		created_at: "now",
		updated_at: "then",
		dryRun: false,
		dry_run: true,
		input,
		nodes,
	};
	const parsed = workflowRunEnvelopeSchema.parse({ run: wire }).run;
	expect(parsed.input).toBe(input);
	expect(parsed.nodes).toBe(nodes);
	expect(parsed.dryRun).toBe(false);
	expect(parsed.error).toBeNull();
	respond({ run: wire });
	expect((await getWorkflowRun(target, "r")).input.__proto__).toBe("retained");
	const requests: RequestInit[] = [];
	globalThis.fetch = Object.assign(
		async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			if (init) {
				requests.push(init);
			}
			return Response.json({ run: wire });
		},
		{ preconnect: originalFetch.preconnect }
	);
	await runWorkflow(target, "w", { message: "start" }, { dryRun: false });
	await runWorkflow(target, "w", { message: "start" }, { dryRun: true });
	expect(requests.map((r) => r.body)).toEqual([
		'{"input":{"message":"start"}}',
		'{"input":{"message":"start"},"dryRun":true}',
	]);
});

test("catalog and captured definitions keep legacy defaults and raw future configurations", async () => {
	const template = {
		id: "t",
		name: "Template",
		pattern: "future",
		category: "future-category",
		tags: null,
		node_count: null,
	};
	respond({ templates: [template] });
	expect(await fetchWorkflowTemplates(target)).toEqual([
		{
			id: "t",
			name: "Template",
			description: "",
			category: "orchestration",
			pattern: "future",
			icon: null,
			nodeCount: 0,
			tags: [],
			sourceUrl: null,
		},
	]);
	respond({ template });
	expect((await fetchWorkflowTemplate(target, "t")).nodes).toEqual([]);
	respond({
		version: {
			workflow: {
				future: { config: [1, false] },
				nodes: "malformed Core-owned graph",
			},
		},
	});
	expect(await getWorkflowVersionDefinition(target, "w", "v")).toEqual({
		future: { config: [1, false] },
		nodes: "malformed Core-owned graph",
	});
	respond({});
	expect(await getWorkflowVersionDefinition(target, "w", "v")).toEqual({});
	respond({
		action: "install",
		dryRun: true,
		success: true,
		future: { plan: "kept" },
	});
	expect(await previewWorkflowTemplateInstall(target, "t")).toEqual({
		action: "install",
		dryRun: true,
		success: true,
		future: { plan: "kept" },
	});
	respond({ workflow_id: "installed" });
	expect(await installWorkflowTemplate(target, "t")).toBe("installed");
});

test("Core retains authoring graph validation and exposes exact native errors", async () => {
	let body: RequestInit["body"];
	globalThis.fetch = Object.assign(
		async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			body = init?.body;
			return Response.json({ error: "cycle / unknown node" }, { status: 400 });
		},
		{ preconnect: originalFetch.preconnect }
	);
	await expect(
		createWorkflow(target, { nodes: "malformed", future: { config: [true] } })
	).rejects.toThrow("cycle / unknown node");
	expect(body).toBe('{"nodes":"malformed","future":{"config":[true]}}');
	respond({ error: "" }, 409);
	await expect(createWorkflow(target, {})).rejects.toThrow(
		"/workflows failed: 409"
	);
});
