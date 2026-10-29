import { AlertCircleIcon, FolderTreeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useEffect, useId, useState } from "react";

export interface WorktreeHandoffControlProps {
	/** The suggested branch name shown whenever the dialog opens. */
	branchName: string;
	/** True when the current chat has an in-flight response to interrupt. */
	chatRunning: boolean;
	/** Persist the selected branch and arm the current chat for a worktree. */
	onHandOff: (branchName: string) => void;
	/** Stop the active response before the handoff is armed. */
	onInterrupt?: () => void;
}

/**
 * The pinned-summary Environment action for moving the current chat onto a
 * persistent worktree. Core still owns worktree creation; this control updates
 * the current chat's run mode so the next turn is created in the selected
 * worktree.
 */
export function WorktreeHandoffControl({
	branchName,
	chatRunning,
	onHandOff,
	onInterrupt,
}: WorktreeHandoffControlProps) {
	const [open, setOpen] = useState(false);
	const [draftBranchName, setDraftBranchName] = useState(branchName);
	const inputId = useId();

	useEffect(() => {
		if (open) {
			setDraftBranchName(branchName);
		}
	}, [branchName, open]);

	const trimmedBranchName = draftBranchName.trim();

	const handleHandOff = () => {
		if (!trimmedBranchName) {
			return;
		}
		if (chatRunning) {
			onInterrupt?.();
		}
		onHandOff(trimmedBranchName);
		setOpen(false);
	};

	return (
		<>
			<Button
				appearance="worktree-handoff"
				className="flex w-full items-center justify-center"
				data-testid="open-worktree-handoff"
				onClick={() => setOpen(true)}
				type="button"
				variant="outline"
			>
				<HugeiconsIcon aria-hidden className="size-3.5" icon={FolderTreeIcon} />
				Hand off to worktree
			</Button>

			<Dialog onOpenChange={setOpen} open={open}>
				<DialogContent
					appearance="worktree-handoff"
					data-testid="worktree-handoff-dialog"
				>
					<DialogHeader purpose="marketplace-guide">
						<div className="flex items-center gap-3">
							<HugeiconsIcon
								aria-hidden
								className="size-5 shrink-0 text-muted-foreground"
								icon={FolderTreeIcon}
								strokeWidth={1.7}
							/>
							<DialogTitle typography="explanation">
								Hand off chat to worktree
							</DialogTitle>
						</div>
						<DialogDescription>
							Create and check out a branch in a new worktree to continue
							working in parallel.
						</DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-2">
						<label className="font-medium text-sm" htmlFor={inputId}>
							Branch name
						</label>
						<Input
							autoFocus
							id={inputId}
							onChange={(event) => setDraftBranchName(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									handleHandOff();
								}
							}}
							placeholder="codex/my-feature"
							purpose="worktree-branch"
							spellCheck={false}
							value={draftBranchName}
						/>
					</div>

					{chatRunning && (
						<div
							className="flex items-start gap-3 text-sm leading-6"
							role="alert"
						>
							<HugeiconsIcon
								aria-hidden
								className="mt-1 size-4 shrink-0 text-status-warning"
								icon={AlertCircleIcon}
								strokeWidth={1.8}
							/>
							<span>
								This chat is running, so handing it off will interrupt the
								current response
							</span>
						</div>
					)}

					<Button
						className="h-13 w-full"
						disabled={!trimmedBranchName}
						onClick={handleHandOff}
						type="button"
					>
						Hand off
					</Button>
				</DialogContent>
			</Dialog>
		</>
	);
}
