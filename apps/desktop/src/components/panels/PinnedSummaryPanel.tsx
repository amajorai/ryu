// apps/desktop/src/components/panels/PinnedSummaryPanel.tsx
//
// The "Pinned summary" panel: a flush rail of disclosures shown once a
// conversation has a thread. Docked, it is a plain panel column (a hairline
// separates it from the chat, and hairlines separate its sections); only the
// floating overlay gets the popover surface and shadow. The first row is
// "Environment" (read-only project ▸ branch ▸ worktree context + live git
// counts + pull/sync/commit/push actions); the rest (Progress / Artifacts /
// Changes / Sources / Side chats) come from the shared CoworkContextPanel and
// only appear when they have something to show.
//
// The Environment row is ALWAYS present — including with no project folder open,
// where it collapses to a read-only project row plus a one-line hint. It used to be
// gated on `folder`, which left a folderless chat with zero accordion items: the
// panel then rendered nothing while its docked column still reserved its width,
// so the sidebar read as a blank strip.
// Placement is owned by WorkspacePanels: normally a docked column stacked with
// the right panel (both push the chat narrower, both can be open at once); when
// the chat would get too narrow it auto-demotes to a floating overlay. Only the
// floating overlay passes `onDismiss` — the docked column never self-dismisses.

import { cn } from "@ryu/ui/lib/utils.ts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { AttachedImage } from "@/components/agent-elements/input-bar.tsx";
import type { CoworkContextPanelProps } from "@/src/components/panels/CoworkContextPanel.tsx";
import { CoworkContextPanel } from "@/src/components/panels/CoworkContextPanel.tsx";
import { useGitPullRequest } from "@/src/hooks/useGitPullRequest.ts";
import {
	invalidateGitStatus,
	useGitStatus,
	useWorktreeStatus,
} from "@/src/hooks/useGitStatus.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { isPullRequestBranch } from "@/src/lib/api/git.ts";
import {
	buildGitHubCompareUrl,
	fetchGitHubRepository,
	gitPullRequestStatus,
	selectGitHubCompareBaseBranch,
} from "@/src/lib/api/pull-requests.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { pinnedGitBranchActions } from "./pinned-summary/pinned-git-branch-actions.ts";
import { pinnedGitCommitActions } from "./pinned-summary/pinned-git-commit-actions.ts";
import { renderPinnedGitDialogs } from "./pinned-summary/pinned-git-dialogs.tsx";
import { pinnedSummaryItems } from "./pinned-summary/pinned-summary-items.tsx";
import { pinnedSummaryOpenWasRequested } from "./pinned-summary/pinned-summary-open-request.ts";
import { repositoryUrlFromName } from "./pinned-summary/pinned-summary-parts.tsx";
import { usePinnedBackgroundProcesses } from "./pinned-summary/use-pinned-background-processes.ts";
import { usePinnedGitState } from "./pinned-summary/use-pinned-git-state.ts";

export {
	CompareBranchLink,
	CreateLocalGitButton,
} from "./pinned-summary/pinned-summary-parts.tsx";

export interface PinnedSummaryPanelProps {
	conversationId?: string | null;
	/**
	 * The Cowork context (Progress / Artifacts / Changes / Sources / Side chats)
	 * rendered below the Environment row — the same content as the right panel's
	 * Context tab, merged into this accordion.
	 */
	cowork: CoworkContextPanelProps;
	folder: string | null;
	/** Stage a generated CI report in the current chat composer. */
	onAttachTextFile?: (attachment: AttachedImage) => void;
	/**
	 * Called when the panel should hide itself because the user pressed away
	 * from it. Only passed in floating-overlay mode (where the panel overlaps
	 * the message column); the docked column never self-dismisses.
	 */
	onDismiss?: () => void;
	/** Update the active tab's run-mode override after a handoff. */
	onHandOffToWorktree?: (branchName: string) => void;
	/** Interrupt a live response before moving this chat to a worktree. */
	onInterruptChat?: () => void;
	/** Keep manual run-mode changes aligned with the active chat tab. */
	onWorktreeModeChange?: (enabled: boolean) => void;
	/** True when the app-owned GitHub provider can answer PR/check lookups. */
	pullRequestsEnabled?: boolean;
	showLineStats?: boolean;
	target: ApiTarget;
	/** The active chat's per-tab run-mode choice, when one exists. */
	worktreeModeOverride?: boolean;
}

export function PinnedSummaryPanel({
	conversationId,
	folder,
	target,
	cowork,
	onDismiss,
	onAttachTextFile,
	onInterruptChat,
	onHandOffToWorktree,
	onWorktreeModeChange,
	pullRequestsEnabled = false,
	showLineStats = true,
	worktreeModeOverride,
}: PinnedSummaryPanelProps) {
	const interfaceLevel = useInterfaceLevel();
	const simpleMode = interfaceLevel === "simple";
	const worktreeBranch = useWorkspaceStore((state) => state.worktreeBranch);
	const setWorktreeBranch = useWorkspaceStore(
		(state) => state.setWorktreeBranch
	);
	const setWorktreeMode = useWorkspaceStore((state) => state.setWorktreeMode);
	const gitState = usePinnedGitState();
	const {
		branches,
		commit,
		createdPullRequest,
		gitSetup,
		pullRequest,
		remote,
		repositoryOperation,
		setGitSetup,
		setRepositoryDialogOpen,
		setRepositoryName,
		setRepositoryOperation,
	} = gitState;

	// In floating-overlay mode (onDismiss set) the panel overlaps the message
	// column, so it behaves like a dismissible popover: a pointer press anywhere
	// outside it hides it, and the titlebar toggle brings it back. In docked
	// mode onDismiss is absent and no listener is bound.
	const panelRef = useRef<HTMLDivElement>(null);
	// The floating overlay is on demand: it mounts because the window is too
	// narrow to dock, not because the person asked. Unless a titlebar toggle
	// asked just now, dismiss before the first paint so it never covers the top
	// of the transcript on its own (pinned-summary-open-request.ts).
	const dismissRef = useRef(onDismiss);
	dismissRef.current = onDismiss;
	useLayoutEffect(() => {
		if (dismissRef.current && !pinnedSummaryOpenWasRequested()) {
			dismissRef.current();
		}
	}, []);
	useEffect(() => {
		if (!onDismiss) {
			return;
		}
		const handlePointerDown = (event: PointerEvent) => {
			const pressed = event.target;
			if (!(pressed instanceof Element)) {
				return;
			}
			// Ignore presses inside the panel, or inside a menu/popover/dialog the
			// pickers portal to the body root (project ▸ branch ▸ run mode) — those
			// live outside the panel's DOM subtree but are logically part of it.
			// The selector matches what the UI kit actually emits: these are Base UI
			// popups (`data-slot="…-content"`), never Radix — the old
			// `[data-radix-popper-content-wrapper]` probe could not match anything in
			// this app, so choosing a branch while the panel floated dismissed it.
			if (
				panelRef.current?.contains(pressed) ||
				pressed.closest(
					'[data-slot="dropdown-menu-content"],[data-slot="popover-content"],[data-slot="dialog-content"]'
				)
			) {
				return;
			}
			onDismiss();
		};
		document.addEventListener("pointerdown", handlePointerDown);
		return () => document.removeEventListener("pointerdown", handlePointerDown);
	}, [onDismiss]);

	const targetRef = useRef(target);
	targetRef.current = target;

	const {
		backgroundError,
		backgroundProcesses,
		handleStopBackgroundProcess,
		stoppingProcessId,
	} = usePinnedBackgroundProcesses(target);

	// Shared with every other git surface, so this panel's counts can never
	// disagree with the branch pill above it.
	const { status: gitStatus } = useGitStatus(target, folder);
	const worktreeStatus = useWorktreeStatus(target, conversationId);
	const git = gitStatus.is_repo ? gitStatus : null;
	const branch = git?.branch ?? "Repository";
	const githubRepositoryQuery = useQuery({
		enabled: pullRequestsEnabled && Boolean(folder && git),
		queryFn: ({ signal }) =>
			folder
				? fetchGitHubRepository(targetRef.current, folder, signal).catch(
						() => null
					)
				: Promise.resolve(null),
		queryKey: ["github-repository", target.url, folder],
		refetchOnMount: "always",
		refetchOnWindowFocus: true,
		staleTime: 0,
	});
	const githubRepository = githubRepositoryQuery.data ?? null;
	const { data: queriedPullRequest, isLoading: pullRequestLoading } =
		useGitPullRequest(
			target,
			folder,
			git?.branch ?? null,
			pullRequestsEnabled,
			"all"
		);
	const localPullRequest =
		createdPullRequest && createdPullRequest.branch === git?.branch
			? createdPullRequest
			: null;
	const existingPullRequest = queriedPullRequest ?? localPullRequest;
	const canCreatePullRequest =
		git !== null &&
		isPullRequestBranch(branch) &&
		(!existingPullRequest ||
			["closed", "merged"].includes(gitPullRequestStatus(existingPullRequest)));
	const baseBranch = selectGitHubCompareBaseBranch(null, null, branches);
	const compareBaseBranch = selectGitHubCompareBaseBranch(
		existingPullRequest?.baseRefName,
		githubRepository?.defaultBranch,
		branches
	);
	const compareRepository = githubRepository
		? githubRepository
		: existingPullRequest?.repository
			? { url: repositoryUrlFromName(existingPullRequest.repository) ?? "" }
			: null;
	const compareUrl =
		git && compareRepository
			? buildGitHubCompareUrl(compareRepository, branch, compareBaseBranch)
			: null;

	// An agent run mutates the tree, so re-read the moment it goes idle instead
	// of waiting out the poll interval.
	const chatStatus = cowork.chatStatus;
	const chatRunning = chatStatus === "streaming" || chatStatus === "submitted";
	const handleHandOffToWorktree = (branchName: string) => {
		setWorktreeBranch(branchName);
		setWorktreeMode(true);
		onHandOffToWorktree?.(branchName);
	};
	useEffect(() => {
		if (folder && chatStatus !== "streaming" && chatStatus !== "submitted") {
			invalidateGitStatus(folder);
		}
	}, [chatStatus, folder]);
	useEffect(() => {
		setGitSetup({ status: "idle" });
		setRepositoryOperation({ status: "idle" });
		setRepositoryDialogOpen(false);
		setRepositoryName("");
	}, [folder, target.url]);

	const {
		handleBranchMenuOpenChange,
		handleCreateBranch,
		handleCreateRepository,
		handleInitializeGit,
		handleRemoteGit,
		handleSelectBranch,
		openCommitDialog,
		openCreateRepositoryDialog,
		openPullRequestDialog,
		stopGitOperation,
	} = pinnedGitBranchActions(gitState, {
		branch,
		folder,
		githubRepositoryQuery,
		pullRequestsEnabled,
		targetRef,
	});

	const {
		handleCommitPush,
		handleFixCi,
		handleFixMergeConflicts,
		handlePullRequest,
	} = pinnedGitCommitActions(gitState, {
		baseBranch,
		branch,
		canCreatePullRequest,
		existingPullRequest,
		folder,
		onAttachTextFile,
		targetRef,
	});

	const changedCount = git?.changed_files_count ?? 0;
	const insertions = git?.insertions ?? 0;
	const deletions = git?.deletions ?? 0;
	const ahead = git?.ahead ?? 0;
	// A push is worth doing when there are local changes or unpushed commits.
	const hasWork = changedCount > 0 || ahead > 0;

	const { backgroundItem, environmentItem } = pinnedSummaryItems({
		backgroundError,
		backgroundProcesses,
		canCreatePullRequest,
		chatRunning,
		commit,
		compareUrl,
		conversationId,
		existingPullRequest,
		folder,
		git,
		gitSetup,
		githubRepository,
		handleFixCi,
		handleFixMergeConflicts,
		handleHandOffToWorktree,
		handleInitializeGit,
		handleRemoteGit,
		handleStopBackgroundProcess,
		hasWork,
		onAttachTextFile,
		onInterruptChat,
		onWorktreeModeChange,
		openCommitDialog,
		openCreateRepositoryDialog,
		openPullRequestDialog,
		pullRequest,
		pullRequestLoading,
		pullRequestsEnabled,
		remote,
		repositoryOperation,
		showLineStats,
		simpleMode,
		stopGitOperation,
		stoppingProcessId,
		target,
		worktreeBranch,
		worktreeModeOverride,
		githubRepositoryLoading: githubRepositoryQuery.isLoading,
		worktreeActive: worktreeStatus.active,
	});

	return (
		// Floating overlay caps its own height and scrolls; the docked column's
		// wrapper is full-height and owns scrolling, so no cap there.
		<div
			className={cn(
				"pointer-events-auto",
				onDismiss
					? "max-h-[70vh] w-72 overflow-y-auto rounded-xl border border-border bg-popover px-3 py-1 text-popover-foreground shadow-lg"
					: "w-full"
			)}
			ref={panelRef}
		>
			<CoworkContextPanel
				{...cowork}
				leadingItems={[
					environmentItem,
					...(backgroundItem ? [backgroundItem] : []),
				]}
				maxItemsPerSection={5}
				variant="summary"
			/>
			{renderPinnedGitDialogs(gitState, {
				baseBranch,
				branch,
				deletions,
				folder,
				handleBranchMenuOpenChange,
				handleCommitPush,
				handleCreateBranch,
				handleCreateRepository,
				handlePullRequest,
				handleSelectBranch,
				insertions,
			})}
		</div>
	);
}
