import { expect, test } from "bun:test";
import { activityTraceImportRecordSchema } from "./activity-trace-import.ts";

test("trace import retains native wire names and Desktop normalized names", () => {
	const config = { future: ["config"], tests: [{ prompt: "Task" }] };
	const importedCase = {
		prompt: "Task",
		response: "Completed",
		metadata: { run: "run" },
	};
	const native = {
		added: true,
		case: importedCase,
		source_run_id: "run",
		suite: {
			agent_id: "agent",
			config,
			created_at: 1,
			id: "suite",
			name: "Suite",
			updated_at: 2,
		},
		version: {
			config,
			created_at: 2,
			id: "version",
			label: "Trace import",
			suite_id: "suite",
		},
	};
	const desktop = {
		added: true,
		case: importedCase,
		sourceRunId: "run",
		suite: {
			agentId: "agent",
			config,
			createdAt: 1,
			id: "suite",
			name: "Suite",
			updatedAt: 2,
		},
		version: {
			config,
			createdAt: 2,
			id: "version",
			label: "Trace import",
			suiteId: "suite",
		},
	};
	expect(activityTraceImportRecordSchema.parse(native)).toBe(native);
	expect(activityTraceImportRecordSchema.parse(desktop)).toBe(desktop);
	expect(
		activityTraceImportRecordSchema.parse({
			...native,
			added: false,
			version: null,
		}).version
	).toBeNull();
	expect(
		activityTraceImportRecordSchema.parse({
			...desktop,
			added: false,
			version: null,
		}).version
	).toBeNull();
	expect(
		activityTraceImportRecordSchema.safeParse({
			...desktop,
			suite: { id: "incomplete" },
		}).success
	).toBe(false);
	expect(
		activityTraceImportRecordSchema.safeParse({ ...native, source_run_id: 1 })
			.success
	).toBe(false);
});
