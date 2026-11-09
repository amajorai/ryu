import { describe, expect, test } from "bun:test";
import type { HostServices } from "./rpc.ts";
import {
	gateWorkflowAuthoring,
	isReviewedWorkflowAuthor,
	WORKFLOW_AUTHORING_VERBS,
} from "./workflow-authoring-guard.ts";

// Every authoring verb backed by a recorder, so a refusal is observable as
// "Core was never called" rather than as a mock assertion.
function recordingServices(calls: string[]): Partial<HostServices> {
	const services: Record<string, unknown> = {};
	for (const verb of WORKFLOW_AUTHORING_VERBS) {
		services[verb] = () => {
			calls.push(verb);
			return Promise.resolve(undefined);
		};
	}
	services.workflowsList = () => Promise.resolve([]);
	return services as Partial<HostServices>;
}

describe("shared workflow authoring guard", () => {
	test("covers versioning and Connect trigger binding, not only save and run", () => {
		expect(WORKFLOW_AUTHORING_VERBS).toEqual(
			expect.arrayContaining([
				"workflowsVersionCreate",
				"workflowsBindConnectTrigger",
				"workflowsRemoveConnectBinding",
				"workflowsSave",
				"workflowsRun",
				"workflowsResume",
			])
		);
	});

	test("a third-party app with stale workflow grants reaches no authoring verb", async () => {
		const calls: string[] = [];
		const gated = gateWorkflowAuthoring("@evil/x", recordingServices(calls));
		for (const verb of WORKFLOW_AUTHORING_VERBS) {
			const call = gated[verb] as unknown as () => Promise<unknown>;
			await expect(call()).rejects.toThrow("reviewed Workflows apps");
		}
		expect(calls).toEqual([]);
		expect(await gated.workflowsList?.()).toEqual([]);
	});

	test("reviewed authors keep every verb, matched exactly after trim and case", async () => {
		const calls: string[] = [];
		const services = recordingServices(calls);
		expect(gateWorkflowAuthoring(" @RYU/Workflows ", services)).toBe(services);
		await services.workflowsBindConnectTrigger?.({
			id: "wf-1",
			connectTriggerId: "trigger-1",
		});
		expect(calls).toEqual(["workflowsBindConnectTrigger"]);
		expect(isReviewedWorkflowAuthor("@ryu/workflows-evil")).toBe(false);
	});
});
