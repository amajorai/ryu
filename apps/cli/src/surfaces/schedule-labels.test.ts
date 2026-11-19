// Calendar and Tasks labels are whole phrases with the id in place.
import { describe, expect, mock, test } from "bun:test";
import type { ScheduledJob } from "@ryuhq/core-client/schedules";
import { createCliTranslator } from "../i18n/translate.ts";

const german = createCliTranslator("de", {
	"agent {id}": "Agent {id}",
	"app {id}": "App {id}",
	"every {interval}": "alle {interval}",
	"system {kind}": "System {kind}",
	"workflow {id}": "Workflow {id}",
});
mock.module("../i18n/translate.ts", () => ({
	CLI_FORMAT_LOCALE: "de",
	CLI_LOCALE: "de",
	CLI_TRANSLATOR: german,
	createCliTranslator,
	tf: german.tf,
	tr: german.tr,
	trMessage: german.trMessage,
	translateProps: german.translateProps,
}));
const { everyIntervalLabel, scheduleTargetLabel } = await import(
	"./schedule-labels.ts"
);

const job = (target: ScheduledJob["target"]) => ({ target }) as ScheduledJob;

describe("schedule labels under German", () => {
	test("an interval cadence", () => {
		expect(everyIntervalLabel("5m")).toBe("alle 5m");
	});

	test("each run target", () => {
		expect(
			scheduleTargetLabel(job({ type: "workflow", workflowId: "wf_1" }))
		).toBe("Workflow wf_1");
		expect(
			scheduleTargetLabel(
				job({ kind: "sweep", pluginId: "@ryu/x", type: "system" })
			)
		).toBe("App @ryu/x");
		expect(scheduleTargetLabel(job({ kind: "sweep", type: "system" }))).toBe(
			"System sweep"
		);
	});
});
