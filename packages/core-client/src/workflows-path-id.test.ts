// packages/core-client/src/workflows-path-id.test.ts
//
// Workflows are Core's own routes, not a mount: the id is encoded with
// encodePathId and stays inside one path segment, and "." and ".." are
// refused. Before, the id went into the path as it came, so the id "W/run?"
// of createWorkflowVersion was POST /workflows/W/run and ran the workflow.
// Every builder that puts a workflow, run, version or template id into a path
// is in the table, by name and by id position.

import { describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	createWorkflowVersion,
	deleteWorkflow,
	fetchWorkflow,
	fetchWorkflowTemplate,
	forkRun,
	getWorkflowRun,
	getWorkflowVersionDefinition,
	listRunHistory,
	listWorkflowVersions,
	restoreWorkflowVersion,
	resumeWorkflow,
	runWorkflow,
} from "./workflows.ts";

const BASE = "http://core.test";
const HOSTILE_ID = "W/run?x#y";
const ENCODED_ID = "W%2Frun%3Fx%23y";
const PLAIN_ID = "wf_0123456789abcdef";
const DOT_IDS = [".", ".."];

/** A target whose stub fetch records every request and answers with an empty object. */
function recordingTarget(): { requests: string[]; target: ApiTarget } {
	const requests: string[] = [];
	const target: ApiTarget = {
		url: BASE,
		token: "node-token",
		fetch: (input, init) => {
			requests.push(`${init?.method ?? "GET"} ${String(input)}`);
			return Promise.resolve(Response.json({}));
		},
	};
	return { requests, target };
}

/** Run a builder and keep only what it asked the node for; the reply shape is not under test. */
async function requestsOf(
	call: (target: ApiTarget) => Promise<unknown>
): Promise<string[]> {
	const { requests, target } = recordingTarget();
	await Promise.resolve()
		.then(() => call(target))
		.catch(() => undefined);
	return requests;
}

interface PathBuilder {
	call: (target: ApiTarget, id: string) => Promise<unknown>;
	name: string;
	/** The one request the builder makes, with the id position as given. */
	request: (segment: string) => string;
}

const BUILDERS: PathBuilder[] = [
	{
		name: "fetchWorkflow",
		request: (s) => `GET ${BASE}/workflows/${s}`,
		call: (target, id) => fetchWorkflow(target, id),
	},
	{
		name: "deleteWorkflow",
		request: (s) => `DELETE ${BASE}/workflows/${s}`,
		call: (target, id) => deleteWorkflow(target, id),
	},
	{
		name: "runWorkflow",
		request: (s) => `POST ${BASE}/workflows/${s}/run`,
		call: (target, id) => runWorkflow(target, id, {}),
	},
	{
		name: "getWorkflowRun",
		request: (s) => `GET ${BASE}/workflows/runs/${s}`,
		call: (target, id) => getWorkflowRun(target, id),
	},
	{
		name: "resumeWorkflow",
		request: (s) => `POST ${BASE}/workflows/runs/${s}/resume`,
		call: (target, id) => resumeWorkflow(target, id, "ok"),
	},
	{
		name: "fetchWorkflowTemplate",
		request: (s) => `GET ${BASE}/api/workflows/catalog/${s}`,
		call: (target, id) => fetchWorkflowTemplate(target, id),
	},
	{
		name: "listWorkflowVersions",
		request: (s) => `GET ${BASE}/workflows/${s}/versions`,
		call: (target, id) => listWorkflowVersions(target, id),
	},
	{
		name: "getWorkflowVersionDefinition (workflow id)",
		request: (s) => `GET ${BASE}/workflows/${s}/versions/${PLAIN_ID}`,
		call: (target, id) => getWorkflowVersionDefinition(target, id, PLAIN_ID),
	},
	{
		name: "getWorkflowVersionDefinition (version id)",
		request: (s) => `GET ${BASE}/workflows/${PLAIN_ID}/versions/${s}`,
		call: (target, id) => getWorkflowVersionDefinition(target, PLAIN_ID, id),
	},
	{
		name: "createWorkflowVersion",
		request: (s) => `POST ${BASE}/workflows/${s}/versions`,
		call: (target, id) => createWorkflowVersion(target, id, "label"),
	},
	{
		name: "restoreWorkflowVersion (workflow id)",
		request: (s) => `POST ${BASE}/workflows/${s}/versions/${PLAIN_ID}/restore`,
		call: (target, id) => restoreWorkflowVersion(target, id, PLAIN_ID),
	},
	{
		name: "restoreWorkflowVersion (version id)",
		request: (s) => `POST ${BASE}/workflows/${PLAIN_ID}/versions/${s}/restore`,
		call: (target, id) => restoreWorkflowVersion(target, PLAIN_ID, id),
	},
	{
		name: "listRunHistory",
		request: (s) => `GET ${BASE}/workflows/runs/${s}/history`,
		call: (target, id) => listRunHistory(target, id),
	},
	{
		name: "forkRun",
		request: (s) => `POST ${BASE}/workflows/runs/${s}/fork`,
		call: (target, id) => forkRun(target, id, "cp_1"),
	},
];

describe("the workflows client keeps every id inside one path segment", () => {
	for (const builder of BUILDERS) {
		test(`${builder.name} encodes the id ${HOSTILE_ID}`, async () => {
			expect(
				await requestsOf((target) => builder.call(target, HOSTILE_ID))
			).toEqual([builder.request(ENCODED_ID)]);
		});

		for (const id of DOT_IDS) {
			test(`${builder.name} builds no request for the id ${id}`, async () => {
				expect(await requestsOf((target) => builder.call(target, id))).toEqual(
					[]
				);
			});
		}

		test(`${builder.name} builds its request unchanged for a plain id`, async () => {
			expect(
				await requestsOf((target) => builder.call(target, PLAIN_ID))
			).toEqual([builder.request(PLAIN_ID)]);
		});
	}
});

describe("the split of workflows.ts", () => {
	test("workflows.ts re-exports the requests and helpers of its four parts", async () => {
		const entry = await import("./workflows.ts");
		const types = await import("./workflows-types.ts");
		const templates = await import("./workflows-templates.ts");
		const versions = await import("./workflows-versions.ts");
		const history = await import("./workflows-history.ts");
		const pairs: [unknown, unknown][] = [
			[entry.projectWorkflowWire, types.toWorkflow],
			[entry.projectWorkflowRunWire, types.toRun],
			[entry.readWorkflowErrorFromResponse, types.errorFromResponse],
			[entry.workflowResponseSchema, types.workflowEnvelope],
			[entry.workflowRunResponseSchema, types.runEnvelope],
			[entry.workflowsResponseSchema, types.workflowsEnvelope],
			[entry.fetchWorkflowTemplate, templates.fetchWorkflowTemplate],
			[entry.fetchWorkflowTemplates, templates.fetchWorkflowTemplates],
			[entry.installWorkflowTemplate, templates.installWorkflowTemplate],
			[entry.createWorkflowVersion, versions.createWorkflowVersion],
			[
				entry.getWorkflowVersionDefinition,
				versions.getWorkflowVersionDefinition,
			],
			[entry.listWorkflowVersions, versions.listWorkflowVersions],
			[entry.restoreWorkflowVersion, versions.restoreWorkflowVersion],
			[entry.forkRun, history.forkRun],
			[entry.listRunHistory, history.listRunHistory],
		];
		for (const [exported, moved] of pairs) {
			expect(exported).toBe(moved);
		}
	});
});
