import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import { type RunStreamFrame, streamRuns } from "@/src/lib/api/runStream.ts";
import { useActiveNode } from "./useActiveNode.ts";

/// Shape of a run summary returned by `GET /api/runs`.
export interface RunSummary {
	agent_id: string | null;
	branch: string | null;
	created_at: number;
	folder_path: string | null;
	id: string;
	message_count: number;
	run_status: string | null;
	title: string | null;
	updated_at: number;
	worktree_path: string | null;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
/** Split a run's folder path on either separator to show its basename. */
const PATH_SEPARATOR_RE = /[\\/]/;

/** Reset the status map to a snapshot's current truth (no notifications). */
function seedStatuses(prev: Map<string, string>, runs: RunSummary[]) {
	prev.clear();
	for (const run of runs) {
		if (run.run_status) {
			prev.set(run.id, run.run_status);
		}
	}
}

/** Merge one run into the current list by id (append if new). */
function mergeRun(current: RunSummary[], run: RunSummary): RunSummary[] {
	const idx = current.findIndex((r) => r.id === run.id);
	if (idx === -1) {
		return [...current, run];
	}
	const next = current.slice();
	next[idx] = run;
	return next;
}

/**
 * Apply a pushed run delta: merge it into state, then fire the same running →
 * completed/failed notification the old poll did before recording the status.
 */
function applyRunDelta(
	prev: Map<string, string>,
	run: RunSummary,
	setRuns: Dispatch<SetStateAction<RunSummary[]>>
) {
	setRuns((current) => mergeRun(current, run));
	const prevStatus = prev.get(run.id);
	const nextStatus = run.run_status ?? "";
	if (
		prevStatus === "running" &&
		(nextStatus === "completed" || nextStatus === "failed")
	) {
		fireRunNotification(run, nextStatus);
	}
	if (nextStatus) {
		prev.set(run.id, nextStatus);
	}
}

/** Pause that resolves early when the stream is torn down. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true }
		);
	});
}

/// Subscribe to Core's `GET /api/runs/stream` SSE feed and fire browser
/// notifications when a run transitions from `running` to `completed` or
/// `failed`. The endpoint is snapshot-first (one `snapshot` frame, then a `run`
/// frame per status change), replacing the old 3s poll of `/api/runs`. The hook
/// is intended to be mounted once at app level (e.g. AppSidebar) so it stays
/// alive across page navigation and captures completions for background runs.
export function useRuns() {
	const activeNode = useActiveNode();
	const [runs, setRuns] = useState<RunSummary[]>([]);
	const prevStatusRef = useRef<Map<string, string>>(new Map());

	useEffect(() => {
		const controller = new AbortController();
		const { signal } = controller;
		const prev = prevStatusRef.current;

		const onFrame = (frame: RunStreamFrame) => {
			if (frame.type === "snapshot") {
				setRuns(frame.runs);
				// Seed statuses silently on (re)connect: the snapshot is the current
				// truth, so no completion notification fires for it.
				seedStatuses(prev, frame.runs);
				return;
			}
			// A pushed delta: merge the run and detect running → completed/failed.
			applyRunDelta(prev, frame.run, setRuns);
		};

		const connect = async () => {
			let backoff = INITIAL_BACKOFF_MS;
			while (!signal.aborted) {
				try {
					await streamRuns(toTarget(activeNode), onFrame, signal);
					backoff = INITIAL_BACKOFF_MS; // a clean end resets the backoff
				} catch {
					// Connect/read failed (Core offline, transient drop) — reconnect.
				}
				if (signal.aborted) {
					break;
				}
				await delay(backoff, signal);
				backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
			}
		};

		connect().catch(() => {
			// connect swallows its own errors and never rejects.
		});
		return () => controller.abort();
	}, [activeNode]);

	return { runs };
}

function fireRunNotification(run: RunSummary, status: string) {
	if (!("Notification" in window)) {
		return;
	}

	const title = status === "completed" ? "Run completed" : "Run failed";
	const folder = run.folder_path?.split(PATH_SEPARATOR_RE).pop() ?? "";
	const branch = run.branch ?? "";
	const body = [
		run.title,
		folder && `folder: ${folder}`,
		branch && `branch: ${branch}`,
	]
		.filter(Boolean)
		.join(" · ");

	const fire = () => {
		const n = new Notification(title, { body, tag: run.id });
		n.onclick = () => {
			window.focus();
			window.dispatchEvent(
				new CustomEvent("ryu:run-notification-click", {
					detail: { runId: run.id },
				})
			);
		};
	};

	if (Notification.permission === "granted") {
		fire();
	} else if (Notification.permission === "default") {
		Notification.requestPermission().then((perm) => {
			if (perm === "granted") {
				fire();
			}
		});
	}
}
