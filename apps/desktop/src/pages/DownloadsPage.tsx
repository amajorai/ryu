// apps/desktop/src/pages/DownloadsPage.tsx
//
// The full-page download center — the pop-out from the sidebar download popup
// (mirrors how the Inbox popover opens the full Inbox page). Three sections:
//   1. Available updates — promoted, suggested downloads for anything installed
//      that has a newer version (see AvailableUpdates).
//   2. Active downloads — everything currently queued/downloading/paused.
//   3. History — previously finished downloads. The durable Core history log
//      (survives restart) merged with any terminal tasks from the live session.
//
// Durable history comes from GET /api/downloads/history (Core persists finished
// downloads to ~/.ryu/downloads-history.json); the live store adds this run's
// just-finished tasks before they land in the log, deduped by id.

import { Download01Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { PullToRefresh } from "@ryu/ui/components/pull-to-refresh";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { AvailableUpdates } from "@/src/components/downloads/AvailableUpdates.tsx";
import { DownloadRow } from "@/src/components/downloads/DownloadRow.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAvailableUpdates } from "@/src/hooks/useAvailableUpdates.ts";
import {
	isUnfinishedTask,
	useDownloadBulkActions,
} from "@/src/hooks/useDownloadBulkActions.ts";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import {
	type DownloadTask,
	isInFlight,
	listDownloadHistory,
} from "@/src/lib/api/downloads.ts";
import {
	selectOrderedTasks,
	useDownloadsStore,
} from "@/src/store/useDownloadsStore.ts";

/** How long the Refresh button stays in its pressed state, so a refetch that
 *  resolves instantly still reads as an action that happened. */
const MIN_REFRESH_MS = 600;

/** Merge live-session terminal tasks with the durable history log, deduped by id
 *  (the live copy wins), newest first. */
function mergeHistory(
	session: DownloadTask[],
	persisted: DownloadTask[]
): DownloadTask[] {
	const byId = new Map<string, DownloadTask>();
	for (const t of persisted) {
		byId.set(t.id, t);
	}
	for (const t of session) {
		byId.set(t.id, t);
	}
	return [...byId.values()].sort((a, b) => b.updated_at - a.updated_at);
}

export default function DownloadsPage() {
	const tasks = useDownloadsStore(useShallow(selectOrderedTasks));
	const [friendly] = useFriendlyMode();
	const { openTab } = useTabsContext();
	const { updates, loading, refresh } = useAvailableUpdates();
	const node = useActiveNode();

	const historyQuery = useQuery({
		queryKey: ["downloads", "history", node.url],
		queryFn: () =>
			listDownloadHistory({
				url: node.url,
				token: node.token,
				userJwt: node.userJwt ?? null,
			}),
	});

	const active = tasks.filter(
		(t) => isInFlight(t.state) || t.state === "paused"
	);
	const sessionTerminal = tasks.filter(
		(t) =>
			t.state === "completed" || t.state === "cancelled" || t.state === "failed"
	);
	const history = mergeHistory(sessionTerminal, historyQuery.data ?? []);
	const unfinished = tasks.filter(isUnfinishedTask);

	const {
		clearFinished,
		clearUnfinished,
		pending: clearing,
	} = useDownloadBulkActions(tasks);

	// A refresh that resolves in 80ms and redraws the same rows is indistinguishable
	// from a dead button, so the pressed state is held for a beat. `MIN_REFRESH_MS`
	// is a floor on the *feedback*, never a delay on the data — the queries are
	// already refetching while it runs.
	const [refreshHeld, setRefreshHeld] = useState(false);
	const refreshing = refreshHeld || loading || historyQuery.isFetching;
	const onRefresh = useCallback(() => {
		setRefreshHeld(true);
		refresh();
		historyQuery.refetch().catch(() => undefined);
		setTimeout(() => setRefreshHeld(false), MIN_REFRESH_MS);
	}, [historyQuery, refresh]);

	const nothing =
		updates.length === 0 &&
		active.length === 0 &&
		history.length === 0 &&
		!(loading || historyQuery.isLoading);

	return (
		<PullToRefresh className="scroll-fade h-full" onRefresh={onRefresh}>
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
				<header className="flex items-center justify-between gap-3">
					<div>
						<h1 className="font-medium text-xl">Downloads</h1>
						<p className="text-muted-foreground text-sm">
							Updates, active downloads, and everything you've downloaded
							before.
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						{unfinished.length > 0 && (
							<Button
								disabled={clearing}
								onClick={() => {
									clearUnfinished().catch(() => undefined);
								}}
								size="sm"
								variant="ghost"
							>
								Clear unfinished
							</Button>
						)}
						{history.length > 0 && (
							<Button
								disabled={clearing}
								onClick={() => {
									// Refetch after: History is served by this query, and clearing
									// the durable log server-side does not invalidate its cache.
									clearFinished()
										.then(() => historyQuery.refetch())
										.catch(() => undefined);
								}}
								size="sm"
								variant="ghost"
							>
								Clear finished
							</Button>
						)}
						{/* Refresh reports itself. Both feeds it kicks off resolve in well
					    under a second on a local node, so without a held state the button
					    looked inert on every press — the list simply redrew identical
					    content. The state is driven by the queries' own in-flight flags
					    plus a floor, so it is never a lie about work that already ended. */}
						<Button
							loading={refreshing}
							onClick={() => {
								onRefresh();
							}}
							size="sm"
							variant="ghost"
						>
							<HugeiconsIcon icon={Refresh01Icon} />
							{refreshing ? "Refreshing…" : "Refresh"}
						</Button>
					</div>
				</header>

				{nothing ? (
					<Empty className="py-10">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HugeiconsIcon icon={Download01Icon} />
							</EmptyMedia>
							<EmptyTitle>Nothing downloading</EmptyTitle>
							<EmptyDescription>
								Installs and updates you start will appear here, and everything
								is up to date.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button
								onClick={() => openTab("/store", { title: "Store" })}
								size="sm"
							>
								Browse the Store
							</Button>
						</EmptyContent>
					</Empty>
				) : (
					<>
						{updates.length > 0 && (
							<div className="rounded-2xl bg-card">
								<AvailableUpdates />
							</div>
						)}

						<Section title="Active">
							{active.length > 0 ? (
								<div className="flex flex-col rounded-2xl bg-card p-1">
									{active.map((task) => (
										<DownloadRow
											friendly={friendly}
											key={task.id}
											task={task}
										/>
									))}
								</div>
							) : (
								<p className="px-1 text-muted-foreground text-sm">
									No active downloads.
								</p>
							)}
						</Section>

						{history.length > 0 && (
							<Section title="History">
								<div className="flex flex-col rounded-2xl bg-card p-1">
									{history.map((task) => (
										<DownloadRow
											friendly={friendly}
											key={task.id}
											task={task}
										/>
									))}
								</div>
							</Section>
						)}
					</>
				)}
			</div>
		</PullToRefresh>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<h2 className="font-medium text-muted-foreground text-sm">{title}</h2>
			{children}
		</section>
	);
}
