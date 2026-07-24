// apps/desktop/src/components/panels/PinnedSummaryPanel.tsx
//
// The "Pinned summary" panel: a chromeless accordion sidebar shown once a
// conversation has a thread. It has no card background and no header — just the
// accordion whose rows each carry their own card surface. The first row is
// "Environment" (project ▸ branch ▸ worktree + live git +added/−removed line
// counts + a one-click "Commit & push"); the rest (Progress / Artifacts /
// Changes / Sources / Side chats) come from the shared CoworkContextPanel and
// only appear when they have something to show.
//
// The Environment row is shown (and default-open) only while a project folder is
// open; with no folder there is nothing to configure, so it is omitted too.
// Placement is owned by WorkspacePanels: normally a docked column stacked with
// the right panel (both push the chat narrower, both can be open at once); when
// the chat would get too narrow it auto-demotes to a floating overlay. Only the
// floating overlay passes `onDismiss` — the docked column never self-dismisses.

import {
	ArrowUpRight01Icon,
	FolderLibraryIcon,
	Loading01Icon,
	SentIcon,
	Tick02Icon,
	WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useRef, useState } from "react";
import { ProjectPicker } from "@/src/components/chat/ProjectPicker.tsx";
import { WorkspaceHeader } from "@/src/components/chat/WorkspaceHeader.tsx";
import { WorktreePicker } from "@/src/components/chat/WorktreePicker.tsx";
import type { CoworkContextPanelProps } from "@/src/components/panels/CoworkContextPanel.tsx";
import { CoworkContextPanel } from "@/src/components/panels/CoworkContextPanel.tsx";
import type { BouncyAccordionItem } from "@/src/components/ui/bouncy-accordion.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	commitPush,
	fetchGitStatus,
	type GitStatus,
} from "@/src/lib/api/git.ts";

interface PinnedSummaryPanelProps {
	conversationId?: string | null;
	/**
	 * The Cowork context (Progress / Artifacts / Changes / Sources / Side chats)
	 * rendered below the Environment row — the same content as the right panel's
	 * Context tab, merged into this accordion.
	 */
	cowork: CoworkContextPanelProps;
	folder: string | null;
	/**
	 * Called when the panel should hide itself because the user pressed away
	 * from it. Only passed in floating-overlay mode (where the panel overlaps
	 * the message column); the docked column never self-dismisses.
	 */
	onDismiss?: () => void;
	target: ApiTarget;
}

type CommitState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "done"; label: string }
	| { status: "error"; message: string };

/** +added / −removed line counts, matching the chat page's workspace picker. */
function DiffStat({
	insertions,
	deletions,
}: {
	deletions: number;
	insertions: number;
}) {
	return (
		<span className="flex items-center gap-1 font-medium tabular-nums">
			{insertions > 0 && (
				<span className="text-emerald-600 dark:text-emerald-400/90">
					+{insertions}
				</span>
			)}
			{deletions > 0 && (
				<span className="text-red-600/90 dark:text-red-400/90">
					−{deletions}
				</span>
			)}
		</span>
	);
}

/** The Environment row body: pickers + git line-stats + commit & push. */
function EnvironmentDescription({
	conversationId,
	target,
	git,
	commit,
	hasWork,
	onCommitPush,
}: {
	commit: CommitState;
	conversationId?: string | null;
	git: GitStatus | null;
	hasWork: boolean;
	onCommitPush: () => void;
	target: ApiTarget;
}) {
	const insertions = git?.insertions ?? 0;
	const deletions = git?.deletions ?? 0;
	const ahead = git?.ahead ?? 0;
	const clean = insertions === 0 && deletions === 0;

	return (
		<div className="flex flex-col gap-2">
			{/* Project ▸ branch ▸ worktree — the pickers relocated from the
			    composer's workspace bar. They read the workspace store reactively
			    and render nothing outside a git repo. Stacked one-per-row here (each
			    trigger stretched full-width and left-aligned) rather than the
			    composer's compact inline pills, so the narrow pinned panel reads as a
			    clean list: project on its row, branch on its row, worktree on its. */}
			<div className="flex flex-col items-stretch gap-1 [&_button]:w-full [&_button]:justify-start">
				<ProjectPicker />
				<WorkspaceHeader target={target} />
				<WorktreePicker conversationId={conversationId} target={target} />
			</div>

			{!git && (
				<p className="text-muted-foreground text-xs">Not a git repository.</p>
			)}
			{/* The +added/−removed counts already live in the accordion header, so the
			    body only carries what the header can't: the clean-tree state and any
			    unpushed-commit count. When the tree is dirty with nothing ahead, the
			    header alone says it all and this line is dropped. */}
			{git && (clean || ahead > 0) && (
				<div className="flex items-center gap-2 text-muted-foreground text-xs">
					<HugeiconsIcon
						aria-hidden
						className="size-3.5 shrink-0"
						icon={WorkflowCircle06Icon}
					/>
					{clean && (
						<span className="min-w-0 flex-1 truncate">
							No uncommitted changes
						</span>
					)}
					{ahead > 0 && (
						<span className="flex shrink-0 items-center gap-0.5 font-mono">
							<HugeiconsIcon
								aria-hidden
								className="size-3"
								icon={ArrowUpRight01Icon}
							/>
							{ahead}
						</span>
					)}
				</div>
			)}

			{git && (
				<button
					className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-2 py-1.5 font-medium text-primary-foreground text-xs transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
					disabled={commit.status === "loading" || !hasWork}
					onClick={onCommitPush}
					type="button"
				>
					<HugeiconsIcon
						aria-hidden
						className={cn(
							"size-3.5",
							commit.status === "loading" && "animate-spin"
						)}
						icon={commit.status === "loading" ? Loading01Icon : SentIcon}
					/>
					{commit.status === "loading" ? "Pushing…" : "Commit & push"}
				</button>
			)}

			{commit.status === "done" && (
				<p className="flex items-center gap-1 text-emerald-600 text-xs dark:text-emerald-400">
					<HugeiconsIcon aria-hidden className="size-3.5" icon={Tick02Icon} />
					{commit.label}
				</p>
			)}
			{commit.status === "error" && (
				<p className="break-words text-destructive text-xs">{commit.message}</p>
			)}
		</div>
	);
}

export function PinnedSummaryPanel({
	conversationId,
	folder,
	target,
	cowork,
	onDismiss,
}: PinnedSummaryPanelProps) {
	const [git, setGit] = useState<GitStatus | null>(null);
	const [commit, setCommit] = useState<CommitState>({ status: "idle" });

	// In floating-overlay mode (onDismiss set) the panel overlaps the message
	// column, so it behaves like a dismissible popover: a pointer press anywhere
	// outside it hides it, and the titlebar toggle brings it back. In docked
	// mode onDismiss is absent and no listener is bound.
	const panelRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!onDismiss) {
			return;
		}
		const handlePointerDown = (event: PointerEvent) => {
			const pressed = event.target as HTMLElement | null;
			if (!pressed) {
				return;
			}
			// Ignore presses inside the panel, or inside a Radix popover the
			// pickers portal to the body root (project ▸ branch ▸ worktree) — those
			// live outside the panel's DOM subtree but are logically part of it.
			if (
				panelRef.current?.contains(pressed) ||
				pressed.closest("[data-radix-popper-content-wrapper]")
			) {
				return;
			}
			onDismiss();
		};
		document.addEventListener("pointerdown", handlePointerDown);
		return () => document.removeEventListener("pointerdown", handlePointerDown);
	}, [onDismiss]);

	// Git status refreshes when the run goes idle, so the count tracks the agent.
	const _chatStatus = cowork.chatStatus;

	const targetRef = useRef(target);
	targetRef.current = target;

	// Refresh git status when the folder changes or a run goes idle, so the
	// changed-files count and ahead/behind track what the agent just did.
	useEffect(() => {
		if (!folder) {
			setGit(null);
			return;
		}
		const controller = new AbortController();
		fetchGitStatus(targetRef.current, folder, controller.signal)
			.then((status) => {
				if (!controller.signal.aborted) {
					setGit(status.is_repo ? status : null);
				}
			})
			.catch(() => {
				/* treated as "not a repo" */
			});
		return () => controller.abort();
	}, [folder]);

	const refreshGit = () => {
		if (!folder) {
			return;
		}
		fetchGitStatus(targetRef.current, folder)
			.then((status) => setGit(status.is_repo ? status : null))
			.catch(() => {
				/* ignore */
			});
	};

	const handleCommitPush = async () => {
		if (!folder || commit.status === "loading") {
			return;
		}
		setCommit({ status: "loading" });
		const result = await commitPush(targetRef.current, folder);
		if (result.success) {
			const label = result.committed
				? `Pushed ${result.commit ?? "commit"}`
				: "Pushed (nothing to commit)";
			setCommit({ status: "done", label });
			refreshGit();
		} else {
			setCommit({
				status: "error",
				message: result.error ?? "commit/push failed",
			});
		}
	};

	const changedCount = git?.changed_files_count ?? 0;
	const insertions = git?.insertions ?? 0;
	const deletions = git?.deletions ?? 0;
	const ahead = git?.ahead ?? 0;
	// A push is worth doing when there are local changes or unpushed commits.
	const hasWork = changedCount > 0 || ahead > 0;

	// The Environment row: pickers + git line-stats + commit & push. Only present
	// while a folder is open — with no folder there is nothing to configure, so
	// the row (and its default-open state) is dropped entirely.
	const environmentItem: BouncyAccordionItem = {
		id: "environment",
		icon: (
			<HugeiconsIcon aria-hidden className="size-4" icon={FolderLibraryIcon} />
		),
		title: (
			<span className="flex items-center gap-2">
				<span className="font-medium text-foreground text-xs">Environment</span>
				{git && (insertions > 0 || deletions > 0) && (
					<span className="text-[11px]">
						<DiffStat deletions={deletions} insertions={insertions} />
					</span>
				)}
			</span>
		),
		description: (
			<EnvironmentDescription
				commit={commit}
				conversationId={conversationId}
				git={git}
				hasWork={hasWork}
				onCommitPush={handleCommitPush}
				target={target}
			/>
		),
	};

	return (
		// Floating overlay caps its own height and scrolls; the docked column's
		// wrapper is full-height and owns scrolling, so no cap there.
		<div
			className={cn(
				"pointer-events-auto w-72",
				onDismiss && "max-h-[70vh] overflow-y-auto"
			)}
			ref={panelRef}
		>
			<CoworkContextPanel
				{...cowork}
				leadingItems={folder ? [environmentItem] : []}
			/>
		</div>
	);
}
