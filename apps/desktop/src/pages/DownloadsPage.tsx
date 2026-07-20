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

import { Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { AvailableUpdates } from "@/src/components/downloads/AvailableUpdates.tsx";
import { DownloadRow } from "@/src/components/downloads/DownloadRow.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAvailableUpdates } from "@/src/hooks/useAvailableUpdates.ts";
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
	const { updates, loading, refresh } = useAvailableUpdates();
	const node = useActiveNode();

	const historyQuery = useQuery({
		queryKey: ["downloads", "history", node.url],
		queryFn: () =>
			listDownloadHistory({ url: node.url, token: node.token ?? null }),
	});

	const active = tasks.filter(
		(t) => isInFlight(t.state) || t.state === "paused"
	);
	const sessionTerminal = tasks.filter(
		(t) =>
			t.state === "completed" || t.state === "cancelled" || t.state === "failed"
	);
	const history = mergeHistory(sessionTerminal, historyQuery.data ?? []);

	const nothing =
		updates.length === 0 &&
		active.length === 0 &&
		history.length === 0 &&
		!(loading || historyQuery.isLoading);

	return (
		<div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-6 overflow-y-auto p-6">
			<header className="flex items-center justify-between gap-3">
				<div>
					<h1 className="font-semibold text-xl">Downloads</h1>
					<p className="text-muted-foreground text-sm">
						Updates, active downloads, and everything you've downloaded before.
					</p>
				</div>
				<Button
					onClick={() => {
						refresh();
						historyQuery.refetch().catch(() => undefined);
					}}
					size="sm"
					variant="outline"
				>
					Refresh
				</Button>
			</header>

			{nothing ? (
				<Empty className="py-10">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={Download01Icon} />
						</EmptyMedia>
						<EmptyTitle>Nothing downloading</EmptyTitle>
						<EmptyDescription>
							Installs and updates you start will appear here, and everything is
							up to date.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<>
					{updates.length > 0 && (
						<div className="rounded-lg border">
							<AvailableUpdates />
						</div>
					)}

					<Section title="Active">
						{active.length > 0 ? (
							<div className="divide-y rounded-lg border">
								{active.map((task) => (
									<DownloadRow friendly={friendly} key={task.id} task={task} />
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
							<div className="divide-y rounded-lg border">
								{history.map((task) => (
									<DownloadRow friendly={friendly} key={task.id} task={task} />
								))}
							</div>
						</Section>
					)}
				</>
			)}
		</div>
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
