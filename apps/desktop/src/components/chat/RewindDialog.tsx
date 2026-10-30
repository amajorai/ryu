import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Empty, EmptyDescription } from "@ryu/ui/components/empty.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useCallback, useEffect, useState } from "react";
import {
	type ChatCheckpoint,
	type CheckpointFileChange,
	type CheckpointRestoreMode,
	type CheckpointRestoreResult,
	type CheckpointSkippedPath,
	fetchCheckpointChanges,
	listChatCheckpoints,
	restoreChatCheckpoint,
} from "@/src/lib/api/chat-checkpoints.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	pickInitialCheckpoint,
	type RewindPreselect,
} from "@/src/lib/chat-rewind.ts";

export type { RewindPreselect } from "@/src/lib/chat-rewind.ts";

const SKIP_REASONS: Record<string, string> = {
	error: "The folder snapshot failed for this turn.",
	gitUnavailable: "Git is not installed, so files were not captured.",
	notADirectory: "The chat folder was missing when this turn ran.",
	tooManyFiles: "The folder had too many changed files to capture.",
	unsafeRoot: "Home and filesystem root folders are not captured.",
};

const SKIPPED_REASONS: Record<CheckpointSkippedPath["reason"], string> = {
	notSaved: "its current content is not in any snapshot",
	pathBlocked: "a folder is in the way",
	symlinkParent: "a parent folder is a symbolic link",
	writeFailed: "the file could not be written",
};

const CHANGE_LABELS: Record<CheckpointFileChange["kind"], string> = {
	added: "remove",
	deleted: "recreate",
	modified: "restore",
};

function formatTime(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime())
		? iso
		: date.toLocaleString(undefined, {
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
				month: "short",
			});
}

function checkpointTitle(checkpoint: ChatCheckpoint): string {
	if (checkpoint.kind === "preRestore") {
		return "Before a rewind";
	}
	return checkpoint.preview?.trim() || "(message without text)";
}

/**
 * Claude Code-style rewind: pick the user turn to go back to, review the files
 * a restore would change, then restore code, conversation, or both. Core
 * snapshots the chat folder before every turn for every agent and provider.
 */
export function RewindDialog({
	conversationId,
	disabled,
	onOpenChange,
	onRestored,
	open,
	preselect,
	target,
}: {
	conversationId: string | null;
	/** A turn is running; restoring is refused until it stops. */
	disabled: boolean;
	onOpenChange: (open: boolean) => void;
	onRestored: (
		result: CheckpointRestoreResult,
		mode: CheckpointRestoreMode
	) => void | Promise<void>;
	open: boolean;
	preselect: RewindPreselect | null;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const [checkpoints, setCheckpoints] = useState<ChatCheckpoint[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [changes, setChanges] = useState<CheckpointFileChange[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadingChanges, setLoadingChanges] = useState(false);
	const [working, setWorking] = useState<CheckpointRestoreMode | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [skipped, setSkipped] = useState<CheckpointSkippedPath[]>([]);
	// Re-list after a restore that keeps the dialog open, so the new
	// "Before a rewind" checkpoint is offered as the undo.
	const [reloadToken, setReloadToken] = useState(0);
	useEffect(() => {
		if (open) {
			setSkipped([]);
		}
	}, [open]);

	useEffect(() => {
		if (!(open && conversationId)) {
			return;
		}
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		setChanges(null);
		listChatCheckpoints(target, conversationId, controller.signal)
			.then((list) => {
				setCheckpoints(list);
				setSelectedId(pickInitialCheckpoint(list, preselect));
			})
			.catch((failure: unknown) => {
				if (!controller.signal.aborted) {
					setError(
						failure instanceof Error
							? failure.message
							: "Could not list checkpoints."
					);
				}
			})
			.finally(() => {
				if (!controller.signal.aborted) {
					setLoading(false);
				}
			});
		return () => controller.abort();
	}, [conversationId, open, preselect, reloadToken, target]);

	const selected =
		checkpoints.find((checkpoint) => checkpoint.id === selectedId) ?? null;

	useEffect(() => {
		setChanges(null);
		if (!(open && conversationId && selected?.hasFiles)) {
			return;
		}
		const controller = new AbortController();
		setLoadingChanges(true);
		fetchCheckpointChanges(
			target,
			conversationId,
			selected.id,
			controller.signal
		)
			.then(setChanges)
			.catch((failure: unknown) => {
				if (!controller.signal.aborted) {
					setError(
						failure instanceof Error
							? failure.message
							: "Could not read the folder changes."
					);
				}
			})
			.finally(() => {
				if (!controller.signal.aborted) {
					setLoadingChanges(false);
				}
			});
		return () => controller.abort();
	}, [conversationId, open, selected?.hasFiles, selected?.id, target]);

	const restore = useCallback(
		async (mode: CheckpointRestoreMode) => {
			if (!(conversationId && selected)) {
				return;
			}
			setWorking(mode);
			setError(null);
			try {
				const result = await restoreChatCheckpoint(
					target,
					conversationId,
					selected.id,
					mode
				);
				await onRestored(result, mode);
				const left = result.files?.skipped ?? [];
				if (left.length > 0) {
					// Keep the dialog open: the user must see what was protected.
					setSkipped(left);
					setReloadToken((token) => token + 1);
				} else {
					onOpenChange(false);
				}
			} catch (failure) {
				setError(failure instanceof Error ? failure.message : "Rewind failed.");
			} finally {
				setWorking(null);
			}
		},
		[conversationId, onOpenChange, onRestored, selected, target]
	);

	const canRestoreConversation = selected?.kind === "turn";
	const canRestoreCode = Boolean(selected?.hasFiles);
	const busy = working !== null || disabled;

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent appearance="git-history" data-testid="rewind-dialog">
				<DialogHeader purpose="records-panel">
					<DialogTitle>Rewind</DialogTitle>
					<DialogDescription>
						Go back to before a message. Restore the chat folder, the
						conversation, or both. Files changed by the agent, its tools, and
						its shell commands are restored; ignored files are not.
					</DialogDescription>
				</DialogHeader>
				<div className="min-h-0 space-y-4 overflow-y-auto px-6 py-5">
					{skipped.length > 0 ? (
						<div
							className="space-y-2 rounded-xl border border-status-warning/40 bg-status-warning/5 p-3 text-xs"
							data-testid="rewind-skipped"
							role="alert"
						>
							<p className="font-medium text-sm">
								{tl(
									"Rewind finished, but {count, plural, one {{countText} file was} other {{countText} files were}} left unchanged to protect unsaved work.",
									{
										count: skipped.length,
										countText: String(skipped.length),
									}
								)}
							</p>
							<ul className="max-h-40 space-y-1 overflow-y-auto font-mono">
								{skipped.map((item) => (
									<li key={item.path}>
										<span>{item.path}</span>
										<span className="text-muted-foreground">
											{" "}
											— {SKIPPED_REASONS[item.reason]}
										</span>
									</li>
								))}
							</ul>
							<p className="text-muted-foreground">
								Every other file was restored. To undo this rewind, restore the
								newest “Before a rewind” checkpoint.
							</p>
						</div>
					) : null}
					{error ? (
						<p className="text-status-destructive text-xs" role="alert">
							{error}
						</p>
					) : null}
					{disabled ? (
						<p className="text-muted-foreground text-xs" role="status">
							Stop the running turn to rewind.
						</p>
					) : null}
					{loading ? (
						<p className="flex items-center gap-2 text-muted-foreground text-sm">
							<Spinner /> Reading checkpoints…
						</p>
					) : checkpoints.length === 0 ? (
						<Empty spacing="compact">
							<EmptyDescription>
								No checkpoints yet. One is taken before each message you send.
							</EmptyDescription>
						</Empty>
					) : (
						<div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
							<div
								aria-label="Checkpoints"
								className="max-h-80 space-y-0.5 overflow-y-auto"
								role="listbox"
							>
								{checkpoints.map((checkpoint) => (
									<button
										aria-selected={selectedId === checkpoint.id}
										className={`w-full rounded-lg px-3 py-2 text-left transition-colors duration-150 hover:duration-0 ${
											selectedId === checkpoint.id
												? "bg-accent"
												: "hover:bg-muted"
										}`}
										key={checkpoint.id}
										onClick={() => setSelectedId(checkpoint.id)}
										role="option"
										type="button"
									>
										<span className="line-clamp-2 block break-words font-medium text-sm">
											{checkpointTitle(checkpoint)}
										</span>
										<span className="mt-1 block text-muted-foreground text-xs">
											{formatTime(checkpoint.createdAt)}
											{checkpoint.hasFiles ? " · code + chat" : " · chat only"}
										</span>
									</button>
								))}
							</div>
							<div className="min-h-40 rounded-xl bg-muted p-3 text-sm">
								{selected ? (
									<SelectedCheckpoint
										changes={changes}
										checkpoint={selected}
										loadingChanges={loadingChanges}
									/>
								) : (
									<p className="text-muted-foreground">
										Select a message to rewind to.
									</p>
								)}
							</div>
						</div>
					)}
				</div>
				<DialogFooter purpose="panel-actions">
					<Button onClick={() => onOpenChange(false)} variant="ghost">
						Cancel
					</Button>
					<Button
						disabled={busy || !canRestoreCode}
						onClick={() => void restore("code")}
						variant="outline"
					>
						{working === "code" ? <Spinner className="mr-2" /> : null}
						Restore code
					</Button>
					<Button
						disabled={busy || !canRestoreConversation}
						onClick={() => void restore("conversation")}
						variant="outline"
					>
						{working === "conversation" ? <Spinner className="mr-2" /> : null}
						Restore conversation
					</Button>
					<Button
						disabled={busy || !(canRestoreCode && canRestoreConversation)}
						onClick={() => void restore("codeAndConversation")}
					>
						{working === "codeAndConversation" ? (
							<Spinner className="mr-2" />
						) : null}
						Restore both
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function SelectedCheckpoint({
	changes,
	checkpoint,
	loadingChanges,
}: {
	changes: CheckpointFileChange[] | null;
	checkpoint: ChatCheckpoint;
	loadingChanges: boolean;
}) {
	return (
		<div className="space-y-3">
			<p className="text-muted-foreground text-xs">
				{checkpoint.kind === "preRestore"
					? "The folder as it was just before a rewind. Restoring it undoes that rewind's file changes."
					: "The folder and conversation as they were just before this message."}
			</p>
			{checkpoint.workspace ? (
				<p
					className="truncate font-mono text-muted-foreground text-xs"
					title={checkpoint.workspace}
				>
					{checkpoint.workspace}
				</p>
			) : null}
			{checkpoint.hasFiles ? null : (
				<p className="text-muted-foreground text-xs">
					{checkpoint.skipReason
						? (SKIP_REASONS[checkpoint.skipReason] ??
							"Files were not captured for this turn.")
						: "This chat has no folder, so only the conversation can be rewound."}
				</p>
			)}
			{checkpoint.hasFiles && loadingChanges ? (
				<p className="flex items-center gap-2 text-muted-foreground text-xs">
					<Spinner /> Comparing files…
				</p>
			) : null}
			{checkpoint.hasFiles && changes ? (
				changes.length === 0 ? (
					<p className="text-muted-foreground text-xs">
						No file changes since this point.
					</p>
				) : (
					<ul
						className="max-h-56 space-y-1 overflow-y-auto font-mono text-xs"
						data-testid="rewind-file-changes"
					>
						{changes.map((change) => (
							<li className="flex gap-2" key={change.path}>
								<span className="w-16 shrink-0 text-muted-foreground">
									{CHANGE_LABELS[change.kind]}
								</span>
								<span className="truncate" title={change.path}>
									{change.path}
								</span>
							</li>
						))}
					</ul>
				)
			) : null}
		</div>
	);
}
