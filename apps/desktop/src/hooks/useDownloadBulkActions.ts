// The two bulk actions on the download center — "Clear finished" and "Clear
// unfinished" — shared by the tray popover and the full downloads page so the
// same words do the same thing in both places.
//
// This exists because the popover's version was fire-and-forget: it issued a
// DELETE per finished task, swallowed every rejection with `.catch(() =>
// undefined)`, and waited on Core's `removed` SSE event to update the list. Three
// ways that reads as "the button does nothing":
//
//   1. Core's `clear` is a no-op for a row that is not terminal, and answers
//      `{ok:false}` rather than an HTTP error — so a silent false was
//      indistinguishable from success.
//   2. A failing request (node unreachable, 401) was swallowed with no toast, no
//      log, and no change on screen.
//   3. Even on success, the durable history log kept its own copy, so the
//      downloads page's History section was untouched. There was no route to
//      clear it at all until `clearDownloadHistory`.
//
// So: await every call, drop the rows locally instead of waiting on the stream,
// clear the durable log as part of "finished", and report a failure out loud.

import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useRef, useState } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	cancelDownload,
	clearDownload,
	clearDownloadHistory,
	type DownloadTask,
	isInFlight,
} from "@/src/lib/api/downloads.ts";
import { useDownloadsStore } from "@/src/store/useDownloadsStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/** Terminal rows — the ones "Clear finished" retires. */
export function isFinishedTask(task: DownloadTask): boolean {
	return task.state === "completed" || task.state === "cancelled";
}

/** Everything still moving, stopped, or broken — what "Clear unfinished" retires.
 *  A live download has to be cancelled before Core will let go of it, so this is
 *  cancel-then-clear rather than a plain clear. */
export function isUnfinishedTask(task: DownloadTask): boolean {
	return (
		isInFlight(task.state) || task.state === "paused" || task.state === "failed"
	);
}

export interface DownloadBulkActions {
	/** Retire every completed/cancelled row, and the durable history log. */
	clearFinished: () => Promise<void>;
	/** Cancel and retire everything queued, downloading, paused or failed. */
	clearUnfinished: () => Promise<void>;
	/** True while either action is in flight (both share the flag: they mutate
	 *  the same list, so running them at once has no meaning). */
	pending: boolean;
}

export function useDownloadBulkActions(
	tasks: DownloadTask[]
): DownloadBulkActions {
	const getNode = useNodeStore((s) => s.getActiveNode);
	const removeTask = useDownloadsStore((s) => s.removeTask);
	const [pending, setPending] = useState(false);
	const tl = useLiteralMessages();
	const tlRef = useRef(tl);
	tlRef.current = tl;

	const run = useCallback(
		async (
			picked: DownloadTask[],
			step: (target: ReturnType<typeof toTarget>, id: string) => Promise<void>,
			after?: (target: ReturnType<typeof toTarget>) => Promise<void>
		) => {
			// `after` is the durable-history sweep, which has work to do even when the
			// live registry holds nothing terminal — that is the normal case on the
			// downloads page, where History outlives the session that produced it.
			if (picked.length === 0 && !after) {
				return;
			}
			setPending(true);
			const target = toTarget(getNode());
			try {
				const results = await Promise.allSettled(
					picked.map(async (task) => {
						await step(target, task.id);
						// Drop it here rather than waiting for Core's `removed` event: the
						// event is the happy path, but a row Core had already forgotten
						// never produces one, and that row would sit there forever.
						removeTask(task.id);
					})
				);
				await after?.(target);
				const failed = results.filter((r) => r.status === "rejected").length;
				if (failed > 0) {
					toast.error(
						failed === picked.length
							? "Couldn't clear those downloads."
							: tlRef.current("Couldn't clear {failed} of {total} downloads.", {
									failed: String(failed),
									total: String(picked.length),
								})
					);
				}
			} catch {
				toast.error("Couldn't clear those downloads.");
			} finally {
				setPending(false);
			}
		},
		[getNode, removeTask]
	);

	const clearFinished = useCallback(
		() =>
			run(
				tasks.filter(isFinishedTask),
				async (target, id) => {
					await clearDownload(target, id);
				},
				async (target) => {
					// The point of the whole action: the page's History section reads the
					// durable log, not the registry, so leaving it behind is what made
					// "Clear finished" look inert.
					await clearDownloadHistory(target);
				}
			),
		[run, tasks]
	);

	const clearUnfinished = useCallback(
		() =>
			run(tasks.filter(isUnfinishedTask), async (target, id) => {
				// Cancel first — Core refuses to clear a row that is not terminal, and a
				// bare clear on a downloading task is precisely the silent no-op this
				// hook exists to remove. A failed cancel is tolerated: the clear below
				// still runs, and its rejection is what `run` counts and reports.
				await cancelDownload(target, id).catch(() => undefined);
				await clearDownload(target, id);
			}),
		[run, tasks]
	);

	return { clearFinished, clearUnfinished, pending };
}
