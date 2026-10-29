// apps/desktop/src/components/downloads/DownloadCenter.tsx
//
// App-wide download tray (#456). A 28px icon button in the sidebar footer with
// a badge for active/failed downloads; click it for a panel with three parts:
// promoted "Available updates" (agents/engines/tools/plugins/app on a newer
// version — see AvailableUpdates), the downloads themselves split into Active
// and Finished, and an "Open downloads" action that pops out to the full
// DownloadsPage. Reads the downloads store (fed by the SSE stream) and the
// update aggregate, and drives Core's control endpoints on the active node.
//
// The live aggregate is the header's status line plus one full-bleed activity
// line under it — not a strip of its own. It used to be a third progress bar
// stacked above the per-row bars, which made a two-item download look like a
// loading screen.
//
// Chrome comes from TrayPopover (TrayMorph + shared row/header primitives),
// matching the Inbox tray so the two footer popovers read as one.

import { Download01Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
	TrayBadge,
	TrayEmpty,
	TrayFooter,
	TrayHeader,
	TrayMorph,
	type TrayPlacement,
	TrayProgressLine,
	TrayRefreshButton,
	TrayScroll,
	TraySectionLabel,
	TrayTextButton,
	trayMeta,
} from "@/src/components/shell/TrayPopover.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useAvailableUpdates } from "@/src/hooks/useAvailableUpdates.ts";
import { useDownloadBulkActions } from "@/src/hooks/useDownloadBulkActions.ts";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import { isInFlight } from "@/src/lib/api/downloads.ts";
import {
	selectAggregate,
	selectOrderedTasks,
	useDownloadsStore,
} from "@/src/store/useDownloadsStore.ts";
import { AvailableUpdates } from "./AvailableUpdates.tsx";
import { DownloadRow, formatBytes } from "./DownloadRow.tsx";

/**
 * The app-wide download control: a compact icon button (sidebar footer, beside
 * Settings) with a badge for active/failed downloads. Click to open a panel with
 * promoted available updates + every tracked download, and an "Open downloads"
 * action that pops out to the full page. Always rendered so it stays a stable
 * sidebar control; the panel shows an empty state when nothing is tracked.
 */
export function DownloadCenter({
	placement = "sidebar",
}: {
	placement?: TrayPlacement;
} = {}) {
	// useShallow: both selectors derive a fresh object/array each call; without a
	// shallow equality check Zustand's useSyncExternalStore sees a new snapshot
	// every render ("getSnapshot should be cached") and spins into an infinite
	// update loop.
	const aggregate = useDownloadsStore(useShallow(selectAggregate));
	const tasks = useDownloadsStore(useShallow(selectOrderedTasks));
	// Available updates (newer versions of installed agents/engines/tools/plugins)
	// feed the badge too, so the count shows even when nothing is actively
	// downloading — matching the "Updates" section in the panel body.
	const { refresh, updates } = useAvailableUpdates();
	const [friendly] = useFriendlyMode();
	const openTab = useTabSelector((state) => state.openTab);
	const [open, setOpen] = useState(false);

	const {
		clearFinished,
		clearUnfinished,
		pending: clearing,
	} = useDownloadBulkActions(tasks);

	// Active keeps everything still moving (or paused/failed and therefore
	// actionable) at the top; finished sinks below it.
	const active = tasks.filter(
		(t) => isInFlight(t.state) || t.state === "paused" || t.state === "failed"
	);
	const finished = tasks.filter(
		(t) => t.state === "completed" || t.state === "cancelled"
	);
	const speedBps = tasks.reduce(
		(sum, t) => sum + (isInFlight(t.state) ? (t.speed_bps ?? 0) : 0),
		0
	);
	const isEmpty =
		!aggregate.hasAny && updates.length === 0 && tasks.length === 0;

	// Badge priority: active downloads → failed downloads → available updates.
	// It surfaces the count that most needs attention, so a plain "3 newer
	// versions" still shows when nothing is downloading.
	let badgeCount = updates.length;
	let badgeLabel = "updates available";
	if (aggregate.inFlight > 0) {
		badgeCount = aggregate.inFlight;
		badgeLabel = "downloads in progress";
	} else if (aggregate.failed > 0) {
		badgeCount = aggregate.failed;
		badgeLabel = "failed downloads";
	}
	const badgeFailed = aggregate.inFlight === 0 && aggregate.failed > 0;

	let status: string | undefined;
	if (aggregate.inFlight > 0) {
		status = trayMeta(
			`${aggregate.inFlight} downloading`,
			aggregate.percent === null ? null : `${Math.round(aggregate.percent)}%`,
			speedBps > 0 ? `${formatBytes(speedBps)}/s` : null
		);
	} else if (aggregate.failed > 0) {
		status = `${aggregate.failed} failed`;
	} else if (updates.length > 0) {
		status = `${updates.length} update${updates.length === 1 ? "" : "s"} available`;
	}

	const openFullPage = () => {
		setOpen(false);
		openTab("/downloads");
	};

	return (
		<TrayMorph
			badge={
				<TrayBadge
					count={badgeCount}
					label={badgeLabel}
					tone={badgeFailed ? "danger" : "primary"}
				/>
			}
			icon={Download01Icon}
			label="Downloads"
			onOpenChange={setOpen}
			open={open}
			placement={placement}
		>
			<TrayHeader
				actions={
					<>
						<TrayRefreshButton onRefresh={refresh} />
						{finished.length > 0 || active.length > 0 ? (
							<>
								{active.length > 0 ? (
									<TrayTextButton
										disabled={clearing}
										onClick={() => {
											clearUnfinished().catch(() => undefined);
										}}
									>
										Clear unfinished
									</TrayTextButton>
								) : null}
								{finished.length > 0 ? (
									<TrayTextButton
										disabled={clearing}
										onClick={() => {
											clearFinished().catch(() => undefined);
										}}
									>
										Clear finished
									</TrayTextButton>
								) : null}
							</>
						) : null}
					</>
				}
				count={aggregate.inFlight}
				status={status}
				title="Downloads"
			/>
			{aggregate.inFlight > 0 && (
				<TrayProgressLine percent={aggregate.percent} />
			)}
			{isEmpty ? (
				<TrayEmpty
					description="Installs and updates you start show their progress here."
					icon={Download01Icon}
					title="Nothing downloading"
				/>
			) : (
				<TrayScroll onRefresh={refresh}>
					<AvailableUpdates compact />
					{active.length > 0 && (
						<>
							<TraySectionLabel count={active.length}>Active</TraySectionLabel>
							{active.map((task) => (
								<DownloadRow friendly={friendly} key={task.id} task={task} />
							))}
						</>
					)}
					{finished.length > 0 && (
						<>
							<TraySectionLabel count={finished.length}>
								Finished
							</TraySectionLabel>
							{finished.map((task) => (
								<DownloadRow friendly={friendly} key={task.id} task={task} />
							))}
						</>
					)}
				</TrayScroll>
			)}
			<TrayFooter label="Open downloads" onClick={openFullPage} />
		</TrayMorph>
	);
}
