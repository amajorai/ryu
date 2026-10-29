import { describe, expect, test } from "bun:test";
import type { RouteClaim } from "./rpc.ts";
import { type Capability, dispatchRpc, type HostServices } from "./rpc.ts";
import {
	type WorkflowRecord,
	type WorkflowRunRecord,
	type WorkflowTemplateDetailRecord,
	workflowDefinitionInputSchema,
	workflowRecordSchema,
	workflowRecordsSchema,
	workflowRunRecordSchema,
	workflowTemplateDetailRecordSchema,
	workflowVersionRecordsSchema,
} from "./workflow-records.ts";

const node = {
	id: "node",
	type: "future-node",
	config: { nested: [null, true, { model: "future" }] },
};
const edge = { branch: null, from: "node", to: "target" };
const workflow = {
	chatInput: false,
	createdAt: null,
	description: null,
	edges: [edge],
	id: "workflow",
	name: "Workflow",
	nodes: [node],
	triggers: [{ type: "manual" }],
	updatedAt: null,
	future: { enabled: true },
} satisfies WorkflowRecord & { future: { enabled: boolean } };
const run = {
	awaitingNode: "node",
	createdAt: "2026-01-01",
	dryRun: false,
	error: null,
	input: { prompt: "Hello" },
	nodes: { node: { error: null, output: null, status: "pending" } },
	output: {},
	runId: "run",
	status: "awaiting_input",
	updatedAt: "2026-01-01",
	workflowId: "workflow",
} satisfies WorkflowRunRecord;

describe("normalized workflow owner records", () => {
	test("keeps future node kinds, arbitrary JSON configs, and original graph identity", () => {
		expect(workflowRecordSchema.parse(workflow)).toBe(workflow);
		expect(workflowRecordSchema.parse(workflow).nodes[0]).toBe(node);
		expect(workflowRecordSchema.parse(workflow).edges[0]).toBe(edge);
		const workflows = [workflow];
		expect(workflowRecordsSchema.parse(workflows)).toBe(workflows);
		const definition = { custom: node.config };
		expect(workflowDefinitionInputSchema.parse(definition)).toBe(definition);
		expect(workflowDefinitionInputSchema.safeParse({}).success).toBe(true);
	});
	test("validates the complete graph, trigger, run, and template fields", () => {
		expect(workflowRunRecordSchema.parse(run)).toBe(run);
		expect(
			workflowRecordSchema.safeParse({
				...workflow,
				nodes: [{ ...node, config: { callback: () => null } }],
			}).success
		).toBe(false);
		expect(
			workflowRecordSchema.safeParse({
				...workflow,
				triggers: [{ type: "event" }],
			}).success
		).toBe(false);
		expect(
			workflowRunRecordSchema.safeParse({
				...run,
				nodes: { node: { status: "invalid" } },
			}).success
		).toBe(false);
		expect(
			workflowRunRecordSchema.safeParse({ ...run, input: { prompt: 1 } })
				.success
		).toBe(false);
		const template = {
			category: "research",
			description: "Research",
			icon: null,
			id: "template",
			name: "Template",
			nodeCount: 1,
			pattern: "future-pattern",
			sourceUrl: null,
			tags: ["future"],
			edges: [edge],
			nodes: [node],
		} satisfies WorkflowTemplateDetailRecord;
		expect(workflowTemplateDetailRecordSchema.parse(template)).toBe(template);
		expect(
			workflowTemplateDetailRecordSchema.safeParse({
				...template,
				nodeCount: "one",
			}).success
		).toBe(false);
	});
	test("keeps version rows and checks prototype-named map entries", () => {
		const versions = [
			{
				createdAt: 1,
				id: "version",
				label: null,
				name: "Version",
				workflowId: "workflow",
			},
		];
		expect(workflowVersionRecordsSchema.parse(versions)).toBe(versions);
		const valid = JSON.parse('{"__proto__":{"status":"pending"}}');
		expect(
			workflowRunRecordSchema.safeParse({ ...run, nodes: valid }).success
		).toBe(true);
		const invalid = JSON.parse('{"__proto__":{"status":"invalid"}}');
		expect(
			workflowRunRecordSchema.safeParse({ ...run, nodes: invalid }).success
		).toBe(false);
		const invalidInput = JSON.parse('{"__proto__":1}');
		expect(
			workflowRunRecordSchema.safeParse({ ...run, input: invalidInput }).success
		).toBe(false);
	});
	test("dispatch validates complete readbacks while Core retains DAG validation", async () => {
		const capabilities: Set<Capability> = new Set([
			"workflows.crud",
			"workflows.runstate",
			"workflows.catalogs",
		]);
		const definition = { future: node.config };
		const services: HostServices = {
			listAgents: async () => [],
			registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
			workflowsSave: async (input) => {
				expect(input).toBe(definition);
				return workflow;
			},
			workflowsGet: async () => workflow,
			workflowsRun: async () => run,
			workflowsRunGet: async () => run,
			workflowsResume: async () => run,
			workflowsVersionGet: async () => definition,
			workflowsVersionRestore: async () => workflow,
		};
		expect(
			await dispatchRpc("workflows.save", [definition], capabilities, services)
		).toBe(workflow);
		expect(
			await dispatchRpc(
				"workflows.get",
				[{ id: "workflow" }],
				capabilities,
				services
			)
		).toBe(workflow);
		expect(
			await dispatchRpc(
				"workflows.run",
				[{ id: "workflow" }],
				capabilities,
				services
			)
		).toBe(run);
		expect(
			await dispatchRpc(
				"workflows.runGet",
				[{ runId: "run" }],
				capabilities,
				services
			)
		).toBe(run);
		expect(
			await dispatchRpc(
				"workflows.resume",
				[{ runId: "run", payload: "continue" }],
				capabilities,
				services
			)
		).toBe(run);
		expect(
			await dispatchRpc(
				"workflows.versionGet",
				[{ id: "workflow", versionId: "version" }],
				capabilities,
				services
			)
		).toBe(definition);
		expect(
			await dispatchRpc(
				"workflows.versionRestore",
				[{ id: "workflow", versionId: "version" }],
				capabilities,
				services
			)
		).toBe(workflow);
		const coreFailure = new Error("Workflow has a cycle");
		await expect(
			dispatchRpc("workflows.save", [{}], capabilities, {
				...services,
				workflowsSave: async () => {
					throw coreFailure;
				},
			})
		).rejects.toBe(coreFailure);
	});
});
