import { formatList } from "@ryu/i18n";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { CloudTaskBackendFeatures } from "@/src/lib/api/cloud-task-backends.ts";

/**
 * A subscription cloud run's "Status: …" line. Each status Core reports is
 * one whole translated sentence rather than the raw status word (`running`)
 * inserted into a template; an unknown status falls back to that template.
 */
export function subscriptionRunStatusSentence(
	status: string,
	tl: LiteralMessage
): string {
	switch (status) {
		case "submitted":
			return tl("Status: Submitted");
		case "starting":
			return tl("Status: Starting");
		case "running":
			return tl("Status: Running");
		case "completed":
		case "done":
			return tl("Status: Completed");
		case "stopped":
			return tl("Status: Stopped");
		case "failed":
		case "error":
			return tl("Status: Failed");
		default:
			return tl("Status: {status}", { status });
	}
}

/**
 * The session features this backend does not have in Ryu, each label
 * translated and joined as a list in the reader's language, or null when
 * nothing is missing.
 */
export function missingFeaturesList(
	features: CloudTaskBackendFeatures,
	tl: LiteralMessage
): string | null {
	const labels: string[] = [];
	if (!features.liveScreen) {
		labels.push(tl("live screen"));
	}
	if (!features.runLog) {
		labels.push(tl("run log"));
	}
	if (!features.diffInRyu) {
		labels.push(tl("diff review in Ryu"));
	}
	if (!features.pullRequestInRyu) {
		labels.push(tl("pull requests from Ryu"));
	}
	if (!features.stopFromRyu) {
		labels.push(tl("stop from Ryu"));
	}
	if (!features.followUp) {
		labels.push(tl("follow-up messages"));
	}
	return labels.length > 0 ? formatList(labels) : null;
}
