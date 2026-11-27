// apps/desktop/src/components/chat/ImportOperationStatus.tsx
//
// The state of the imports a surface started, drawn from the node's operation
// records: progress while they run, then the counts and the failed items.
// Shared by the "Import agent setup" dialog and the onboarding migration step.
// Nothing here is component state, so the same view comes back after the
// surface was closed or the app was reloaded.

import { Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Progress } from "@ryu/ui/components/progress.tsx";
import { useState } from "react";
import type { ImportOperationsView } from "@/src/hooks/useImportOperations.ts";
import type { ImportOutcome } from "@/src/lib/api/import.ts";
import {
	type ImportOperationsSummary,
	importEndMessage,
	importTotals,
	summarizeImportOperations,
} from "./import-operation-summary.ts";
import { importOutcomeLine } from "./import-outcome-text.ts";

function RunningImport({
	hint,
	summary,
}: {
	hint: boolean;
	summary: ImportOperationsSummary;
}) {
	const tl = useLiteralMessages();
	const percent =
		summary.total > 0
			? Math.min(100, (summary.done / summary.total) * 100)
			: null;
	let line = tl("Importing…");
	if (summary.cancelRequested) {
		line = tl("Stopping…");
	} else if (summary.status === "queued") {
		line = tl("Waiting for another import to finish.");
	}
	return (
		<div className="flex flex-col gap-2" role="status">
			<div className="flex flex-wrap items-center justify-between gap-2 text-sm">
				<span className="flex items-center gap-2 text-foreground">
					{line}
					{summary.resumed ? (
						<Badge variant="secondary">{tl("Resumed after restart")}</Badge>
					) : null}
				</span>
				{summary.total > 0 ? (
					<span className="text-muted-foreground text-xs tabular-nums">
						{tl("{done} of {total, plural, one {# item} other {# items}}", {
							done: summary.done,
							total: summary.total,
						})}
					</span>
				) : null}
			</div>
			<Progress aria-label={tl("Importing…")} value={percent} />
			{hint ? (
				<p className="text-muted-foreground text-xs">
					{tl(
						"You can close this window. The import keeps running and shows in the Live section."
					)}
				</p>
			) : null}
		</div>
	);
}

/** The counts of an import and one line per failed item. Also drawn for the
 *  answer of an older node, which runs the whole batch inside the request. */
export function ImportOutcomeTotals({
	counts = true,
	outcomes,
}: {
	/** Off while the counts are not complete yet. */
	counts?: boolean;
	outcomes: readonly ImportOutcome[];
}) {
	const tl = useLiteralMessages();
	const totals = importTotals(outcomes);
	return (
		<>
			{counts ? (
				<p className="flex items-center gap-2 text-foreground" role="status">
					<HugeiconsIcon className="size-4 shrink-0" icon={Download01Icon} />
					{tl(
						"Imported {importedCount}, skipped {skippedCount}, failed {failedCount}",
						{
							importedCount: String(totals.imported),
							skippedCount: String(totals.skipped),
							failedCount: String(totals.failed),
						}
					)}
				</p>
			) : null}
			{outcomes
				.filter((o) => o.status === "failed" && o.detail)
				.map((o) => (
					<p
						className="text-status-destructive text-xs"
						key={`${o.kind}:${o.id}`}
					>
						{importOutcomeLine(o, tl)}
					</p>
				))}
		</>
	);
}

function EndedImport({
	outcomes,
	settled,
	summary,
}: {
	outcomes: readonly ImportOutcome[];
	/** The final record of every import is read, so the counts are complete. */
	settled: boolean;
	summary: ImportOperationsSummary;
}) {
	const tl = useLiteralMessages();
	const message = importEndMessage(summary.status, tl);
	return (
		<div className="flex flex-col gap-1 text-sm">
			{message ? (
				<p className="text-status-destructive" role="alert">
					{message}
				</p>
			) : null}
			{summary.error ? (
				<p className="text-muted-foreground text-xs">{summary.error}</p>
			) : null}
			<ImportOutcomeTotals counts={settled} outcomes={outcomes} />
		</div>
	);
}

/** Progress while the surface's imports run, the results once they ended.
 *  Renders nothing when the surface has no import to show. */
export function ImportOperationStatus({
	hint = true,
	view,
}: {
	/** Say that the window can be closed. Off where there is no window. */
	hint?: boolean;
	view: Pick<ImportOperationsView, "operations" | "outcomes" | "settled">;
}) {
	const summary = summarizeImportOperations(view.operations);
	if (!summary) {
		return null;
	}
	if (summary.status === "running" || summary.status === "queued") {
		return <RunningImport hint={hint} summary={summary} />;
	}
	return (
		<EndedImport
			outcomes={view.outcomes}
			settled={view.settled}
			summary={summary}
		/>
	);
}

/** The buttons that go with {@link ImportOperationStatus}: stop while the
 *  imports run, retry after an early end, and a way back to the folder picker.
 *  Renders nothing when the surface has no import to show. */
export function ImportOperationActions({
	onError,
	view,
}: {
	/** Told the message of a failed stop or retry, and `null` before each try. */
	onError: (message: string | null) => void;
	view: ImportOperationsView;
}) {
	const [working, setWorking] = useState(false);
	const summary = summarizeImportOperations(view.operations);
	if (!summary) {
		return null;
	}
	const run = async (action: () => Promise<void>) => {
		setWorking(true);
		onError(null);
		try {
			await action();
		} catch (cause) {
			onError(cause instanceof Error ? cause.message : "Failed to import");
		} finally {
			setWorking(false);
		}
	};
	if (summary.status === "running" || summary.status === "queued") {
		return (
			<Button
				disabled={working || summary.cancelRequested}
				onClick={() => void run(view.stop)}
				variant="outline"
			>
				Stop
			</Button>
		);
	}
	return (
		<>
			{summary.status === "succeeded" ? null : (
				<Button
					disabled={working}
					onClick={() => void run(view.retry)}
					variant="outline"
				>
					Retry
				</Button>
			)}
			<Button disabled={working} onClick={view.clear}>
				Import another folder
			</Button>
		</>
	);
}
