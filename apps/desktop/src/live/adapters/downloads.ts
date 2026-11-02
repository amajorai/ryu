// apps/desktop/src/live/adapters/downloads.ts
//
// Built-in live-activity adapter for DOWNLOADS. Reads the existing downloads
// store (fed by `useDownloadsStream`, mounted app-wide) and publishes one card
// per in-flight task with live progress. Terminal tasks are removed once they
// settle — the download center is the durable history, not the dock.

import type { LiveActivity } from "@ryu/app-host/live-activity";
import { formatByteSize } from "@ryu/i18n/format-intl";
import { useEffect } from "react";
import { type DownloadTask, isInFlight } from "@/src/lib/api/downloads.ts";
import { useDownloadsStore } from "@/src/store/useDownloadsStore.ts";
import { useLiveActivityStore } from "@/src/store/useLiveActivityStore.ts";

const PATH_SEPARATOR_RE = /[\\/]/;

/** Short, scannable label for a task's file. */
function taskLabel(task: DownloadTask): string {
	const base = task.label.split(PATH_SEPARATOR_RE).pop();
	return (base || task.label || task.kind).slice(0, 64);
}

function downloadToActivity(task: DownloadTask): LiveActivity {
	const progress =
		task.total_bytes && task.total_bytes > 0
			? Math.min(1, task.received_bytes / task.total_bytes)
			: undefined;
	const detail =
		progress === undefined
			? "Downloading…"
			: `${Math.round(progress * 100)}% · ${task.speed_bps ? formatSpeed(task.speed_bps) : "…"}`;
	return {
		id: `download:${task.id}`,
		appId: "shell",
		kind: "download",
		title: taskLabel(task),
		detail,
		status: "running",
		progress,
		icon: "arrow-down-03",
		startedAt: task.created_at * 1000,
		updatedAt: task.updated_at * 1000,
		action: { kind: "route", path: "/downloads" },
	};
}

export function formatSpeed(bps: number): string {
	return formatByteSize(bps, undefined, {
		fractionDigits: (_value, unit) => (unit === "kilobyte" ? 0 : 1),
		maxUnit: "megabyte",
		minUnit: "kilobyte",
		perSecond: true,
	});
}

/** Reconcile the whole downloads store against the live-activity registry: every
 *  in-flight task becomes a card; everything else is removed (the download
 *  center owns terminal history). */
function reconcile(tasks: Record<string, DownloadTask>) {
	const store = useLiveActivityStore.getState();
	const desired = Object.values(tasks)
		.sort((a, b) => b.created_at - a.created_at)
		.filter((t) => isInFlight(t.state))
		.map(downloadToActivity);
	store.applySourceSnapshot("shell", "download", desired);
}

/** Mount ONE app-wide reconciliation of downloads → live activities. Reads the
 *  existing downloads store reactively and re-syncs whenever its tasks change. */
export function useDownloadLiveActivities(): void {
	const tasks = useDownloadsStore((s) => s.tasks);

	useEffect(() => {
		reconcile(tasks);
	}, [tasks]);
}
