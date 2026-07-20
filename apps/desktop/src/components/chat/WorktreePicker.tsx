// apps/desktop/src/components/chat/WorktreePicker.tsx
//
// Composer worktree control (M1, persistent-session). Sits in the workspace bar
// above the textarea, beside the project + branch pickers. Lets the user choose
// whether a folder-rooted run executes directly in the selected folder or inside
// an isolated, persistent git worktree for the conversation.
//
// The worktree is created by Core on the first message and reused across turns
// (keyed by conversation id), so once a chat has a live worktree the branch name
// is fixed — this control then shows it read-only with the changed-file count.
// Before the first run it offers an editable, friendly branch name.
//
// Renders nothing when no folder is selected or the folder is not a git repo.

import {
	FolderTreeIcon,
	LaptopIcon,
	RefreshIcon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { cn } from "@ryu/ui/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	WORKSPACE_SELECT_LABEL,
	WORKSPACE_SELECT_POPOVER,
	WORKSPACE_SELECT_TRIGGER,
} from "@/components/agent-elements/input/composer-select.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchGitStatus,
	fetchWorktreeStatus,
	type WorktreeStatus,
} from "@/src/lib/api/git.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

interface WorktreePickerProps {
	/** The active conversation id, used to read this chat's live worktree. */
	conversationId?: string | null;
	target: ApiTarget;
}

const POLL_INTERVAL_MS = 5000;

const NO_WORKTREE: WorktreeStatus = {
	active: false,
	branch: null,
	path: null,
	has_changes: false,
	changed_files: 0,
};

/** The compact trigger label for the current run mode. */
function deriveBranchLabel(
	status: WorktreeStatus,
	worktreeMode: boolean
): string {
	if (status.active) {
		return status.branch ?? "worktree";
	}
	return worktreeMode ? "New worktree" : "This folder";
}

export function WorktreePicker({
	target,
	conversationId,
}: WorktreePickerProps) {
	const folder = useWorkspaceStore((s) => s.folder);
	const worktreeMode = useWorkspaceStore((s) => s.worktreeMode);
	const worktreeBranch = useWorkspaceStore((s) => s.worktreeBranch);
	const setWorktreeMode = useWorkspaceStore((s) => s.setWorktreeMode);
	const setWorktreeBranch = useWorkspaceStore((s) => s.setWorktreeBranch);
	const regenerateWorktreeBranch = useWorkspaceStore(
		(s) => s.regenerateWorktreeBranch
	);

	const [isRepo, setIsRepo] = useState(false);
	const [status, setStatus] = useState<WorktreeStatus>(NO_WORKTREE);
	const [open, setOpen] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	// One-shot git-repo probe whenever the folder changes — the worktree control
	// only applies to git repositories.
	useEffect(() => {
		if (!folder) {
			setIsRepo(false);
			return;
		}
		let active = true;
		fetchGitStatus(target, folder)
			.then((s) => {
				if (active) {
					setIsRepo(s.is_repo);
				}
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, [folder, target]);

	// Poll this conversation's live worktree status (created lazily on first run).
	useEffect(() => {
		if (!(folder && conversationId)) {
			setStatus(NO_WORKTREE);
			return;
		}
		let active = true;
		const run = async () => {
			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;
			const next = await fetchWorktreeStatus(
				target,
				conversationId,
				controller.signal
			);
			if (active) {
				setStatus(next);
			}
		};
		run();
		const id = setInterval(run, POLL_INTERVAL_MS);
		return () => {
			active = false;
			clearInterval(id);
			abortRef.current?.abort();
		};
	}, [folder, conversationId, target]);

	const handleSelectLocal = useCallback(() => {
		setWorktreeMode(false);
	}, [setWorktreeMode]);

	const handleSelectWorktree = useCallback(() => {
		setWorktreeMode(true);
	}, [setWorktreeMode]);

	if (!(folder && isRepo)) {
		return null;
	}

	const branchLabel = deriveBranchLabel(status, worktreeMode);
	const triggerIcon =
		status.active || worktreeMode ? FolderTreeIcon : LaptopIcon;

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				render={
					<Button
						aria-label="Worktree mode"
						className={WORKSPACE_SELECT_TRIGGER}
						size="sm"
						title={
							status.active
								? `Isolated worktree: ${status.branch ?? ""}`
								: "Choose how this chat runs"
						}
						type="button"
						variant="ghost"
					/>
				}
			>
				<HugeiconsIcon className="size-3.5 shrink-0" icon={triggerIcon} />
				<span className="max-w-32 truncate">{branchLabel}</span>
				{status.active && status.has_changes && (
					<span
						aria-label="Uncommitted changes in worktree"
						className="size-1.5 shrink-0 rounded-full bg-warning"
					/>
				)}
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className={cn(WORKSPACE_SELECT_POPOVER, "min-w-[260px] max-w-[320px]")}
				side="top"
				sideOffset={6}
			>
				{status.active ? (
					<div className="flex flex-col gap-2 py-0.5">
						<div className={WORKSPACE_SELECT_LABEL}>Isolated worktree</div>
						<div className="flex items-center gap-2 px-2">
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={FolderTreeIcon}
							/>
							<span className="min-w-0 flex-1 truncate font-mono text-[13px]">
								{status.branch}
							</span>
						</div>
						<p className="px-2 text-[12px] text-muted-foreground">
							{status.changed_files > 0
								? `${status.changed_files} changed file${status.changed_files === 1 ? "" : "s"}. Review and apply from the diff panel.`
								: "This chat runs in its own worktree. Changes are isolated until you apply them from the diff panel."}
						</p>
					</div>
				) : (
					<div className="flex flex-col gap-1">
						<div className={WORKSPACE_SELECT_LABEL}>Run mode</div>
						<ModeRow
							description="Edit the selected folder directly."
							icon={LaptopIcon}
							onSelect={handleSelectLocal}
							selected={!worktreeMode}
							title="Work in this folder"
						/>
						<ModeRow
							description="Run in a persistent git worktree, reused across this chat."
							icon={FolderTreeIcon}
							onSelect={handleSelectWorktree}
							selected={worktreeMode}
							title="Isolated worktree"
						/>
						{worktreeMode && (
							<div className="mt-1 flex flex-col gap-1.5 px-2 pt-1">
								<span className="text-[11px] text-muted-foreground">
									Branch name
								</span>
								<div className="flex items-center gap-1.5">
									<Input
										className="h-7 flex-1 font-mono text-[12px]"
										onChange={(e) => setWorktreeBranch(e.target.value)}
										placeholder="ryu/my-feature"
										spellCheck={false}
										value={worktreeBranch}
									/>
									<Button
										aria-label="Suggest a new branch name"
										className="size-7 shrink-0"
										onClick={regenerateWorktreeBranch}
										size="icon"
										title="Suggest a new name"
										type="button"
										variant="ghost"
									>
										<HugeiconsIcon className="size-4" icon={RefreshIcon} />
									</Button>
								</div>
								<p className="text-[11px] text-muted-foreground">
									Created on the first message and reused for this chat.
								</p>
							</div>
						)}
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}

function ModeRow({
	title,
	description,
	icon,
	selected,
	onSelect,
}: {
	title: string;
	description: string;
	icon: typeof FolderTreeIcon;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			className={cn(
				"flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-foreground/10",
				selected && "bg-foreground/10"
			)}
			onClick={onSelect}
			type="button"
		>
			<HugeiconsIcon
				className="mt-0.5 size-4 shrink-0 text-muted-foreground"
				icon={icon}
			/>
			<span className="min-w-0 flex-1">
				<span className="block truncate font-medium text-[13px] text-foreground/80">
					{title}
				</span>
				<span className="block text-[11px] text-muted-foreground">
					{description}
				</span>
			</span>
			{selected && (
				<HugeiconsIcon
					className="mt-0.5 shrink-0 text-muted-foreground"
					icon={Tick02Icon}
					size={16}
					strokeWidth={2}
				/>
			)}
		</button>
	);
}
