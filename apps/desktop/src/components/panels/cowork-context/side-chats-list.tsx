import { Delete01Icon, MessageQuestionIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useState } from "react";
import type { BtwEntry } from "@/src/lib/api/btw.ts";
import { compactAge } from "@/src/lib/time.ts";
import {
	OverflowRow,
	PANEL_ROW,
	PANEL_ROW_BADGE,
	PANEL_ROW_ICON,
} from "./cowork-rows.tsx";

// ── Side chats (persisted /btw asides) ─────────────────────────────────────────

export function SideChatsList({
	entries,
	deletingIds,
	onOpen,
	onDelete,
	limit,
}: {
	entries: BtwEntry[];
	deletingIds: string[];
	limit?: number;
	onDelete: (id: string) => void;
	onOpen?: (entry: BtwEntry) => void;
}) {
	const tl = useLiteralMessages();
	const [pendingDelete, setPendingDelete] = useState<BtwEntry | null>(null);
	const shown = limit === undefined ? entries : entries.slice(0, limit);
	const overflow = entries.length - shown.length;
	return (
		<>
			<ul className="flex flex-col gap-0.5">
				{shown.map((entry) => (
					<li className="group/side flex items-center gap-1" key={entry.id}>
						<button
							className={cn(PANEL_ROW, "w-auto flex-1")}
							onClick={() => onOpen?.(entry)}
							type="button"
						>
							<span aria-hidden className={PANEL_ROW_ICON}>
								<HugeiconsIcon
									className="size-3.5"
									icon={MessageQuestionIcon}
								/>
							</span>
							<span
								className="min-w-0 flex-1 truncate text-foreground"
								title={entry.question}
							>
								{entry.question}
							</span>
							<span className={PANEL_ROW_BADGE}>
								{compactAge(entry.created_at)}
							</span>
						</button>
						<button
							aria-label="Delete side chat"
							className="relative flex size-5 shrink-0 items-center justify-center rounded-lg opacity-0 transition-opacity after:absolute after:-inset-0.5 hover:bg-accent focus-visible:opacity-100 group-hover/side:opacity-100"
							disabled={deletingIds.includes(entry.id)}
							onClick={() => setPendingDelete(entry)}
							type="button"
						>
							<HugeiconsIcon
								className="size-3.5 text-muted-foreground"
								icon={Delete01Icon}
							/>
						</button>
					</li>
				))}
				{overflow > 0 && <OverflowRow count={overflow} label="side chats" />}
			</ul>
			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
					}
				}}
				open={pendingDelete !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete this side chat?</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingDelete
								? tl(
										'"{question}" and its answer will be permanently deleted.',
										{
											question: `${pendingDelete.question.slice(0, 120)}${
												pendingDelete.question.length > 120 ? "…" : ""
											}`,
										}
									)
								: ""}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (pendingDelete) {
									onDelete(pendingDelete.id);
								}
								setPendingDelete(null);
							}}
							variant="destructive"
						>
							Delete side chat
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
