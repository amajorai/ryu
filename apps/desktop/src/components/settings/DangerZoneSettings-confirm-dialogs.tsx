"use client";

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
import { Input } from "@ryu/ui/components/input.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import type { DangerCategory } from "@/src/components/settings/DangerZoneSettings-data.ts";

/** Reset node: type the node's name to arm a full wipe. */
export function ResetNodeDialog({
	nodeName,
	resetArmed,
	resetBusy,
	resetOpen,
	resetTyped,
	runReset,
	setResetOpen,
	setResetTyped,
}: {
	nodeName: string;
	resetArmed: boolean;
	resetBusy: boolean;
	resetOpen: boolean;
	resetTyped: string;
	runReset: () => Promise<void>;
	setResetOpen: (open: boolean) => void;
	setResetTyped: (typed: string) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<AlertDialog
			onOpenChange={(open) => {
				if (!open) {
					setResetOpen(false);
				}
			}}
			open={resetOpen}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Reset this node?</AlertDialogTitle>
					<AlertDialogDescription>
						This permanently deletes ALL data on{" "}
						<span className="font-medium text-foreground">{nodeName}</span>{" "}
						(every chat, space, memory, session, download, and setting), then
						restarts it to a fresh, just-installed state. This cannot be undone.
					</AlertDialogDescription>
				</AlertDialogHeader>

				<div className="flex flex-col gap-1.5">
					<span className="text-muted-foreground text-xs">
						Type <span className="font-medium text-foreground">{nodeName}</span>{" "}
						to confirm.
					</span>
					<Input
						aria-label={tl("Type {nodeName} to confirm", { nodeName })}
						autoComplete="off"
						onChange={(e) => setResetTyped(e.target.value)}
						placeholder={nodeName}
						value={resetTyped}
					/>
				</div>

				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						disabled={!resetArmed || resetBusy}
						onClick={(e) => {
							e.preventDefault();
							runReset().catch(() => undefined);
						}}
						variant="destructive"
					>
						{resetBusy ? "Resetting…" : "Reset node"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

/** Delete one category: type its confirm word to arm the delete. */
export function ClearCategoryDialog({
	active,
	armed,
	busy,
	runClear,
	setActive,
	setTyped,
	typed,
}: {
	active: DangerCategory | null;
	armed: boolean;
	busy: boolean;
	runClear: () => Promise<void>;
	setActive: (category: DangerCategory | null) => void;
	setTyped: (typed: string) => void;
	typed: string;
}) {
	const tl = useLiteralMessages();
	return (
		<AlertDialog
			onOpenChange={(open) => {
				if (!open) {
					setActive(null);
				}
			}}
			open={active !== null}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{active?.title}?</AlertDialogTitle>
					<AlertDialogDescription>
						{active
							? tl(
									"This will delete {count} {noun}. {detail} This cannot be undone.",
									{
										count: formatCount(active.count) ?? "—",
										detail: active.detail,
										noun: active.noun,
									}
								)
							: ""}
					</AlertDialogDescription>
				</AlertDialogHeader>

				<div className="flex flex-col gap-1.5">
					<span className="text-muted-foreground text-xs">
						Type{" "}
						<span className="font-medium text-foreground">
							{active?.confirm_word}
						</span>{" "}
						to confirm.
					</span>
					<Input
						aria-label={tl("Type {confirmWord} to confirm", {
							confirmWord: active?.confirm_word ?? "the confirmation word",
						})}
						autoComplete="off"
						onChange={(e) => setTyped(e.target.value)}
						placeholder={active?.confirm_word}
						value={typed}
					/>
				</div>

				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						disabled={!armed || busy}
						onClick={(e) => {
							// Keep the dialog open while the request runs; close on success.
							e.preventDefault();
							runClear().catch(() => undefined);
						}}
						variant="destructive"
					>
						{busy ? "Deleting…" : "Delete"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
