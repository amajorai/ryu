// Cadence and run-target labels for the Calendar and Tasks surfaces. Core's
// schedule data stays neutral (`@ryuhq/core-client/schedules`); the CLI builds
// each label as one whole `tf` phrase so the catalog extractor collects it and
// a translator sees the id in place.

import type { ScheduledJob } from "@ryuhq/core-client/schedules";
import { tf } from "../i18n/translate.ts";

/** "every 5m" for an interval schedule, in the reader's language. */
export function everyIntervalLabel(interval: string): string {
	return tf("every {interval}", { interval });
}

/** What a job runs: "workflow <id>", "agent <id>", "app <id>" or "system <kind>". */
export function scheduleTargetLabel(job: ScheduledJob): string {
	const { target } = job;
	if (target.type === "workflow") {
		return tf("workflow {id}", { id: target.workflowId });
	}
	if (target.type === "system") {
		return target.pluginId
			? tf("app {id}", { id: target.pluginId })
			: tf("system {kind}", { kind: target.kind });
	}
	return tf("agent {id}", { id: target.agentId });
}
