// apps/desktop/src/components/chat/CloudTaskPanel-labels.ts
//
// Status labels, limits, and message helpers shared by the cloud task panel
// and its dialogs.

import type { LiteralMessage } from "@ryu/i18n/react";
import { ApiError } from "@/src/lib/api/client.ts";
import type {
	CloudTaskFinish,
	CloudTaskPullRequestError,
	CloudTaskStatus,
} from "@/src/lib/api/cloud-tasks.ts";
import { CLOUD_EXECUTOR_LABELS } from "@/src/lib/cloud-task-selection.ts";

export const STATUS = {
	preparing: { label: "Preparing box", dotClass: "bg-warning" },
	ready: { label: "Ready", dotClass: "bg-success" },
	running: { label: "Running", dotClass: "bg-warning" },
	finishing: { label: "Finishing", dotClass: "bg-warning" },
	failed: { label: "Failed", dotClass: "bg-destructive" },
	stopped: { label: "Stopped", dotClass: "bg-muted-foreground/40" },
	expired: { label: "Expired", dotClass: "bg-muted-foreground/40" },
	interrupted: { label: "Interrupted", dotClass: "bg-destructive" },
} satisfies Record<
	CloudTaskStatus["state"],
	{ label: string; dotClass: string }
>;

export const TERMINAL_STATES = new Set<CloudTaskStatus["state"]>([
	"failed",
	"stopped",
	"expired",
	"interrupted",
]);

export const DEFAULT_COMMIT_MESSAGE = "Changes from Ryu cloud task";
export const MAX_PULL_REQUEST_TITLE_CHARS = 256;
/** Core's limit, counted in Unicode code points like Core counts it. */
export const MAX_PULL_REQUEST_BODY_CHARS = 65_536;
export const characterCount = new Intl.NumberFormat("en-US");

export function codePointLength(text: string): number {
	let count = 0;
	for (const _ of text) {
		count += 1;
	}
	return count;
}

const PULL_REQUEST_ERROR_LABELS = {
	auth: "GitHub denied access",
	already_exists: "a pull request for this branch already exists",
	validation: "GitHub rejected the request",
	network: "GitHub could not be reached",
	unknown: "unknown error",
} satisfies Record<CloudTaskPullRequestError, string>;

export function pullRequestFailure(error: CloudTaskPullRequestError): string {
	return `Pull request not opened: ${PULL_REQUEST_ERROR_LABELS[error]}.`;
}

/** A readable message for a failed mutation; 403 is called out as a permission problem. */
export function failureMessage(
	error: unknown,
	fallback: string,
	tl: LiteralMessage
): string {
	if (error instanceof ApiError) {
		const detail = error.serverMessage ?? error.message;
		return error.status === 403
			? tl("Permission denied: {detail}", { detail })
			: detail;
	}
	return error instanceof Error ? error.message : fallback;
}

/** Why a stopped task's Box stopped, as a short suffix for the status label. */
const STOP_REASON_LABELS: Record<string, string> = {
	balance: "out of credits",
	budget: "budget reached",
	accounting: "usage not recorded",
	idle: "idle",
	ttl: "time limit",
	user: "by you",
	liveness: "lost contact",
	suspended: "billing suspended",
	restart: "node restarted",
};

export function statusLabel(
	task: CloudTaskStatus,
	stopReason: string | null
): string {
	if (task.state === "running") {
		return `Running ${CLOUD_EXECUTOR_LABELS[task.executor]}`;
	}
	const reason = stopReason ? STOP_REASON_LABELS[stopReason] : undefined;
	if (task.state === "stopped" && reason) {
		return `${STATUS.stopped.label} · ${reason}`;
	}
	return STATUS[task.state].label;
}

export function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	return hours > 0 ? `${hours}:${mmss}` : mmss;
}

export function lastRunFailure(task: CloudTaskStatus): string | null {
	const run = task.lastRun;
	if (run?.status !== "failed") {
		return null;
	}
	if (run.reason) {
		return `Last run failed: ${run.reason.replaceAll("_", " ")}`;
	}
	return run.exitCode === null
		? "Last run failed"
		: `Last run failed (exit ${run.exitCode})`;
}

export function finishKey(finish: CloudTaskFinish | null): string | null {
	return finish ? JSON.stringify(finish) : null;
}
