// apps/desktop/src/components/downloads/DownloadRow.tsx
//
// One download row — kind glyph, progress, size/speed/ETA, and
// pause/resume/cancel/retry controls — shared by the compact download tray
// (DownloadCenter) and the full DownloadsPage so both render an identical row.
//
// Built on the shared TrayRow grid, so a download sits in the same rhythm as an
// approval or an available update: one title line, one thin progress bar, one
// dot-separated meta line. Everything a download used to stack (size line +
// state line + bar) now fits that shape.
//
// Controls live in a fixed-width slot and stay visible at 70% rather than being
// revealed on hover: hover-only controls left every row looking empty on the
// right, and made the row reflow the moment the pointer touched it.

import {
	Cancel01Icon,
	CheckmarkCircle02Icon,
	Delete02Icon,
	PauseIcon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import { activeLocale, translate as tl } from "@ryu/i18n/core";
import { formatByteSize, formatDurationUnit } from "@ryu/i18n/format-intl";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo";
import { useEffect, useState } from "react";
import {
	TrayAction,
	TrayIconAction,
	TrayRow,
	trayMeta,
} from "@/src/components/shell/TrayPopover.tsx";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	cancelDownload,
	clearDownload,
	type DownloadTask,
	isInFlight,
	pauseDownload,
	resumeDownload,
	retryDownload,
} from "@/src/lib/api/downloads.ts";
import {
	downloadBadge,
	stripRoleSuffix,
} from "@/src/lib/catalog/downloadBadge.ts";
import { friendlyDownloadLabel } from "@/src/lib/catalog/friendly.ts";
import { useDownloadsStore } from "@/src/store/useDownloadsStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { DownloadTypeBadge } from "./DownloadTypeBadge.tsx";
import { kindIcon } from "./kindIcons.ts";

/**
 * Surface a failed pause/resume/cancel/dismiss/retry. The usual cause is Core no
 * longer knowing the task (it restarted) or refusing the caller; swallowing it
 * leaves a button that silently does nothing.
 */
function reportControlFailure(title: string, error: unknown) {
	toast.error({
		title,
		description: error instanceof Error ? error.message : String(error),
	});
}

/** "512 B", "4.7 GB", "120 MB" in English; the UI locale's separators and
 *  unit names elsewhere. One decimal below 10 units, none above. */
export function formatBytes(n: number): string {
	return formatByteSize(n, undefined, {
		fractionDigits: (value, unit) => (unit === "byte" || value >= 10 ? 0 : 1),
		maxUnit: "terabyte",
	});
}

/** "12 MB/s" in English; the UI locale's separators and rate unit elsewhere. */
export function formatRate(bytesPerSecond: number, locale?: string): string {
	return formatByteSize(bytesPerSecond, locale, {
		fractionDigits: (value, unit) => (unit === "byte" || value >= 10 ? 0 : 1),
		maxUnit: "terabyte",
		perSecond: true,
	});
}

/** "5m left" in English, "noch 5 Min." style wording in the UI language
 *  elsewhere; `null` without a known size and a positive speed. */
export function formatEta(
	task: DownloadTask,
	locale: string = activeLocale()
): string | null {
	if (!(task.total_bytes && task.speed_bps) || task.speed_bps <= 0) {
		return null;
	}
	const remaining = task.total_bytes - task.received_bytes;
	if (remaining <= 0) {
		return null;
	}
	const secs = Math.round(remaining / task.speed_bps);
	let duration: string;
	if (secs < 60) {
		duration = formatDurationUnit(secs, "second", 0, locale);
	} else if (secs < 3600) {
		duration = formatDurationUnit(Math.round(secs / 60), "minute", 0, locale);
	} else {
		duration = formatDurationUnit(secs / 3600, "hour", 1, locale);
	}
	return tl("{remaining} left", { remaining: duration });
}

export function stateLabel(task: DownloadTask, tl: LiteralMessage): string {
	switch (task.state) {
		case "queued":
			return tl("Queued");
		case "active": {
			const speed = task.speed_bps ? formatRate(task.speed_bps) : null;
			const eta = formatEta(task);
			return [speed, eta].filter(Boolean).join(" · ") || tl("Downloading");
		}
		case "paused":
			return tl("Paused");
		case "verifying":
			return tl("Verifying");
		case "completed":
			return tl("Done");
		case "failed":
			return task.error
				? tl("Failed: {error}", { error: task.error })
				: tl("Failed");
		case "cancelled":
			return tl("Cancelled");
		default:
			return task.state;
	}
}

/** A single download row in a list. */
export function DownloadRow({
	task,
	friendly,
}: {
	task: DownloadTask;
	friendly: boolean;
}) {
	const getNode = useNodeStore((s) => s.getActiveNode);
	const target = toTarget(getNode());
	const [busy, setBusy] = useState(false);
	const tl = useLiteralMessages();
	async function runAction(
		failureTitle: string,
		action: () => Promise<unknown>
	) {
		setBusy(true);
		try {
			await action();
		} catch (error) {
			reportControlFailure(failureTitle, error);
		} finally {
			setBusy(false);
		}
	}

	// The type badge carries the role, so the redundant "(embedding model)"
	// parenthetical is stripped from the name; the raw label stays on hover.
	const badge = downloadBadge(task.role, task.kind, task.label);
	const displayLabel = stripRoleSuffix(
		friendly ? friendlyDownloadLabel(task.label, task.kind) : task.label
	);

	const sizeText = task.total_bytes
		? tl("{current} of {total}", {
				current: formatBytes(task.received_bytes),
				total: formatBytes(task.total_bytes),
			})
		: formatBytes(task.received_bytes);
	const percent =
		task.total_bytes && task.total_bytes > 0
			? Math.min(100, (task.received_bytes / task.total_bytes) * 100)
			: null;
	const done = task.state === "completed";
	const failed = task.state === "failed";
	const terminal = done || failed || task.state === "cancelled";
	const [holdFull, setHoldFull] = useState(false);
	useEffect(() => {
		if (!done) {
			return;
		}
		setHoldFull(true);
		const timer = setTimeout(() => setHoldFull(false), 430);
		return () => clearTimeout(timer);
	}, [done]);

	let tone: "default" | "danger" | "success" = "default";
	if (failed) {
		tone = "danger";
	} else if (done) {
		tone = "success";
	}

	let meta: string;
	if (failed) {
		meta = stateLabel(task, tl);
	} else if (terminal) {
		meta = trayMeta(done ? tl("Installed") : tl("Cancelled"), sizeText);
	} else {
		meta = trayMeta(sizeText, stateLabel(task, tl));
	}

	return (
		<TrayRow
			actions={
				<span className="flex items-center gap-1">
					{task.state === "active" && (
						<TrayIconAction
							icon={PauseIcon}
							label="Pause"
							onClick={() =>
								runAction(tl("Couldn't pause the download"), () =>
									pauseDownload(target, task.id)
								)
							}
						/>
					)}
					{(task.state === "paused" || task.state === "queued") && (
						<TrayIconAction
							icon={PlayIcon}
							label="Resume"
							onClick={() =>
								runAction(tl("Couldn't resume the download"), () =>
									resumeDownload(target, task.id)
								)
							}
						/>
					)}
					{isInFlight(task.state) || task.state === "paused" ? (
						<TrayIconAction
							icon={Cancel01Icon}
							label="Cancel"
							onClick={() =>
								runAction(tl("Couldn't cancel the download"), () =>
									cancelDownload(target, task.id)
								)
							}
							tone="danger"
						/>
					) : (
						<TrayIconAction
							icon={Delete02Icon}
							label="Dismiss"
							onClick={() =>
								runAction(tl("Couldn't dismiss the download"), async () => {
									await clearDownload(target, task.id);
									useDownloadsStore.getState().removeTask(task.id);
								})
							}
						/>
					)}
					{failed && task.retryable && (
						<TrayAction
							label="Retry"
							onClick={() =>
								runAction(tl("Couldn't retry the download"), () =>
									retryDownload(target, task.id)
								)
							}
						/>
					)}
				</span>
			}
			busy={busy}
			icon={done ? CheckmarkCircle02Icon : kindIcon(task.kind)}
			meta={meta}
			metaTone={failed ? "danger" : "default"}
			progress={terminal ? (holdFull ? 100 : undefined) : percent}
			// Native title attribute rather than a Tooltip: the row already carries
			// tooltipped controls, and nesting another trigger around the truncated
			// label made the whole row a tooltip target.
			title={<span title={task.label}>{displayLabel}</span>}
			tone={tone}
			trailing={badge ? <DownloadTypeBadge badge={badge} /> : undefined}
		/>
	);
}
