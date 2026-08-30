// apps/desktop/src/components/panels/PinnedSummaryPanel.tsx
//
// The "Pinned summary" panel: a connected accordion rail shown once a
// conversation has a thread. The rail owns one rounded surface and uses subtle
// dividers between its sections instead of stacking unrelated cards. The first row is
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

import {
	ArrowUpRight01Icon,
	CloudUploadIcon,
	ComputerTerminal01Icon,
	GitBranchIcon,
	SentIcon,
	Share08Icon,
	StopIcon,
	Tick02Icon,
	WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils";
import { IconBrandGithub } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { AttachedImage } from "@/components/agent-elements/input-bar.tsx";
import { openExternal } from "@/lib/tauri-bridge.ts";
import {
	DiffStat,
	WorkspacePicker,
} from "@/src/components/chat/WorkspacePicker.tsx";
import { WorktreeHandoffControl } from "@/src/components/chat/WorktreeHandoffControl.tsx";
import type { CoworkContextPanelProps } from "@/src/components/panels/CoworkContextPanel.tsx";
import {
	CoworkContextPanel,
	SectionTitle,
} from "@/src/components/panels/CoworkContextPanel.tsx";
import {
	CreateGitHubRepositoryDialog,
	GitActionDialog,
	type GitProgressPhase,
	GitProgressStatus,
	GitRemoteActions,
	type PullRequestAction,
	PullRequestDialog,
} from "@/src/components/panels/GitActionDialogs.tsx";
import { GitPullRequestSummary } from "@/src/components/panels/GitPullRequestSummary.tsx";
import type { BouncyAccordionItem } from "@/src/components/ui/bouncy-accordion.tsx";
import {
	invalidateGitPullRequest,
	useGitPullRequest,
} from "@/src/hooks/useGitPullRequest.ts";
import {
	invalidateGitStatus,
	useGitStatus,
	useWorktreeStatus,
} from "@/src/hooks/useGitStatus.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import {
	type BackgroundProcess,
	listBackgroundProcesses,
	requestStopBackgroundProcess,
} from "@/src/lib/api/background-processes.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	checkoutBranch,
	commitPush,
	createBranch,
	createPullRequest,
	fetchGitBranches,
	type GitCommitAction,
	type GitStatus,
	initializeGit,
	isPullRequestBranch,
	pullGit,
	syncGit,
} from "@/src/lib/api/git.ts";
import {
	buildGitHubCompareUrl,
	buildPullRequestCheckReport,
	buildPullRequestMergeConflictReport,
	createGitHubRepository,
	fetchGitHubRepository,
	type GitHubRepository,
	type GitHubRepositoryVisibility,
	type GitPullRequest,
	gitPullRequestStatus,
	normalizeGitPullRequest,
	pullRequestHasMergeConflicts,
	selectGitHubCompareBaseBranch,
} from "@/src/lib/api/pull-requests.ts";
import { textToDataUrl } from "@/src/lib/composer/attachments.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

interface PinnedSummaryPanelProps {
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

type GitOperationState =
	| { status: "idle" }
	| { phase: GitProgressPhase; status: "loading" }
	| { label: string; status: "done"; url?: string }
	| { status: "error"; message: string };

function defaultRepositoryName(folder: string | null): string {
	return folder?.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

function repositoryUrlFromName(repository: string | null): string | null {
	const normalized = repository?.trim();
	if (!normalized) {
		return null;
	}
	if (/^https:\/\//i.test(normalized)) {
		return normalized;
	}
	return `https://github.com/${normalized.replace(/^\/+/, "")}`;
}

function formatBackgroundElapsed(elapsedMs: number): string {
	const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${seconds % 60}s`;
}

/** The provider-facing compare action shown only when the current branch can be compared. */
export function CompareBranchLink({ href }: { href: string }) {
	return (
		<a
			aria-label="Compare branch"
			className="flex w-full items-center gap-2 rounded-md border border-border/70 px-2 py-1.5 font-medium text-muted-foreground text-xs transition hover:bg-muted/60 hover:text-foreground"
			data-testid="compare-branch-link"
			href={href}
			rel="noopener noreferrer"
			target="_blank"
		>
			<IconBrandGithub aria-hidden className="size-3.5 shrink-0" />
			<span className="min-w-0 flex-1 truncate">Compare branch</span>
			<HugeiconsIcon
				aria-hidden
				className="size-3.5 shrink-0"
				icon={ArrowUpRight01Icon}
			/>
		</a>
	);
}

/** Ryu Work's only Git affordance for a folder that is not a repository yet. */
export function CreateLocalGitButton({
	busy,
	onClick,
}: {
	busy: boolean;
	onClick: () => void;
}) {
	return (
		<button
			aria-label="Create local Git"
			className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border/70 px-2 py-1.5 font-medium text-muted-foreground text-xs transition hover:bg-muted/60 hover:text-foreground disabled:cursor-wait disabled:opacity-50"
			disabled={busy}
			onClick={onClick}
			type="button"
		>
			<HugeiconsIcon aria-hidden className="size-3.5" icon={GitBranchIcon} />
			Create local Git
		</button>
	);
}

function BackgroundProcessRow({
	process,
	stopping,
	onStop,
}: {
	onStop: (processId: string) => void;
	process: BackgroundProcess;
	stopping: boolean;
}) {
	const label = process.label?.trim() || process.command;
	return (
		<div className="group flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-muted/50">
			<span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
				<HugeiconsIcon
					aria-hidden
					className="size-3.5"
					icon={ComputerTerminal01Icon}
				/>
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate" title={process.command}>
					{label}
				</span>
				<span className="block truncate text-[10px] text-muted-foreground">
					{process.cwd} · {formatBackgroundElapsed(process.elapsed_ms)}
				</span>
			</span>
			<button
				aria-label={`Stop ${label}`}
				className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-100 group-hover:opacity-100"
				disabled={stopping}
				onClick={(event) => {
					event.stopPropagation();
					onStop(process.process_id);
				}}
				title={stopping ? "Stopping…" : "Stop process"}
				type="button"
			>
				<HugeiconsIcon
					aria-hidden
					className={cn("size-3.5", stopping && "animate-pulse")}
					icon={StopIcon}
				/>
			</button>
		</div>
	);
}

/** The Environment row body: pickers + git line-stats + remote/local git actions. */
function EnvironmentDescription({
	conversationId,
	target,
	folder,
	git,
	remote,
	commit,
	existingPullRequest,
	compareUrl,
	githubRepository,
	githubRepositoryLoading,
	githubAppEnabled,
	gitSetup,
	hasWork,
	chatRunning,
	onHandOffToWorktree,
	onInterruptChat,
	onOpenCommit,
	onOpenCreateRepository,
	onOpenPullRequest,
	onInitializeGit,
	onPull,
	onSync,
	onFixCi,
	onFixMergeConflicts,
	onStop,
	onWorktreeModeChange,
	pullRequest,
	pullRequestLoading,
	repositoryOperation,
	simpleMode,
	canCreatePullRequest,
	worktreeActive,
	worktreeBranch,
	worktreeModeOverride,
	showLineStats,
}: {
	canCreatePullRequest: boolean;
	chatRunning: boolean;
	commit: GitOperationState;
	conversationId?: string | null;
	existingPullRequest: GitPullRequest | null;
	compareUrl: string | null;
	folder: string | null;
	git: GitStatus | null;
	githubRepository: GitHubRepository | null;
	githubRepositoryLoading: boolean;
	githubAppEnabled: boolean;
	gitSetup: GitOperationState;
	hasWork: boolean;
	onFixCi?: () => void;
	onFixMergeConflicts?: () => void;
	onHandOffToWorktree: (branchName: string) => void;
	onInterruptChat?: () => void;
	onOpenCommit: () => void;
	onOpenCreateRepository: () => void;
	onOpenPullRequest: () => void;
	onInitializeGit: () => void;
	onPull: () => void;
	onSync: () => void;
	onStop: () => void;
	onWorktreeModeChange?: (enabled: boolean) => void;
	pullRequest: GitOperationState;
	pullRequestLoading: boolean;
	remote: GitOperationState;
	repositoryOperation: GitOperationState;
	simpleMode: boolean;
	showLineStats: boolean;
	target: ApiTarget;
	worktreeActive: boolean;
	worktreeBranch: string;
	worktreeModeOverride?: boolean;
}) {
	const insertions = git?.insertions ?? 0;
	const deletions = git?.deletions ?? 0;
	const ahead = git?.ahead ?? 0;
	const changedFiles = git?.changed_files_count ?? 0;
	const clean = changedFiles === 0 && insertions === 0 && deletions === 0;
	const progress =
		gitSetup.status === "loading"
			? gitSetup.phase
			: repositoryOperation.status === "loading"
				? repositoryOperation.phase
				: remote.status === "loading"
					? remote.phase
					: commit.status === "loading"
						? commit.phase
						: pullRequest.status === "loading"
							? pullRequest.phase
							: undefined;

	// No folder: the branch and run-mode rows and every git affordance render
	// nothing, so the row shows just the read-only folder state and says why it is bare.
	if (!folder) {
		return (
			<div className="flex flex-col gap-2">
				<WorkspacePicker
					conversationId={conversationId}
					folderOverride={folder}
					folderReadOnly
					onWorktreeModeChange={onWorktreeModeChange}
					showLineStats={showLineStats}
					stacked
					target={target}
					worktreeModeOverride={worktreeModeOverride}
				/>
				<p className="text-muted-foreground text-xs">
					No project folder is attached to this chat yet. A local-file request
					will ask you to choose one.
				</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-2">
			{/* Project ▸ branch ▸ run mode — the SAME picker the composer's workspace
			    bar renders, in its `stacked` variant: three full-width rows rather
			    than one inline chip, because this column is 288px wide. The panel
			    used to mount three separate picker components here, which is how the
			    two families drifted; it now owns no picker markup of its own. */}
			<WorkspacePicker
				conversationId={conversationId}
				folderOverride={folder}
				folderReadOnly
				onWorktreeModeChange={onWorktreeModeChange}
				showLineStats={showLineStats}
				stacked
				target={target}
				worktreeModeOverride={worktreeModeOverride}
			/>

			{conversationId && git && !worktreeActive && (
				<WorktreeHandoffControl
					branchName={worktreeBranch}
					chatRunning={chatRunning}
					onHandOff={onHandOffToWorktree}
					onInterrupt={onInterruptChat}
				/>
			)}

			{!git &&
				(simpleMode ? (
					<>
						<p className="text-muted-foreground text-xs">
							This folder is not a Git repository yet.
						</p>
						{gitSetup.status === "loading" ? (
							<GitProgressStatus onStop={onStop} phase={gitSetup.phase} />
						) : (
							<CreateLocalGitButton busy={false} onClick={onInitializeGit} />
						)}
					</>
				) : (
					<p className="text-muted-foreground text-xs">
						This folder is not a Git repository.
					</p>
				))}
			{/* Summary headers stay quiet: the line stats live in the body so the
			    header is only the section name, while the useful numbers remain
			    available when Environment is expanded. */}
			{git && (
				<div className="flex items-center gap-2 text-muted-foreground text-xs">
					{showLineStats && <DiffStat stat={{ insertions, deletions }} />}
					<span className="shrink-0 tabular-nums">
						{formatCount(changedFiles) ?? changedFiles} file
						{changedFiles === 1 ? "" : "s"} changed
					</span>
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
						<span className="flex shrink-0 items-center gap-0.5 tabular-nums">
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

			{git &&
				(progress ? (
					<GitProgressStatus
						onStop={remote.status === "loading" ? undefined : onStop}
						phase={progress}
					/>
				) : (
					<>
						<GitRemoteActions onPull={onPull} onSync={onSync} />
						<button
							className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-2 py-1.5 font-medium text-primary-foreground text-xs transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
							disabled={!hasWork}
							onClick={onOpenCommit}
							type="button"
						>
							<HugeiconsIcon aria-hidden className="size-3.5" icon={SentIcon} />
							Commit or push
						</button>
						{canCreatePullRequest && (
							<button
								className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border/70 px-2 py-1.5 font-medium text-muted-foreground text-xs transition hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
								disabled={!hasWork || (githubAppEnabled && pullRequestLoading)}
								onClick={onOpenPullRequest}
								type="button"
							>
								<HugeiconsIcon
									aria-hidden
									className="size-3.5"
									icon={Share08Icon}
								/>
								Create pull request
							</button>
						)}
					</>
				))}

			{githubAppEnabled &&
				git &&
				!githubRepositoryLoading &&
				!githubRepository &&
				!existingPullRequest?.repository && (
					<button
						className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border/70 px-2 py-1.5 font-medium text-muted-foreground text-xs transition hover:bg-muted/60 hover:text-foreground disabled:cursor-wait disabled:opacity-50"
						disabled={repositoryOperation.status === "loading"}
						onClick={onOpenCreateRepository}
						type="button"
					>
						<HugeiconsIcon
							aria-hidden
							className="size-3.5"
							icon={CloudUploadIcon}
						/>
						Create GitHub repository
					</button>
				)}
			{git && compareUrl && <CompareBranchLink href={compareUrl} />}

			{githubAppEnabled &&
				!existingPullRequest &&
				pullRequestLoading &&
				pullRequest.status !== "loading" && (
					<p className="text-muted-foreground text-xs">Checking GitHub…</p>
				)}

			{existingPullRequest && (
				<GitPullRequestSummary
					compact
					onFix={onFixCi}
					onFixMergeConflicts={onFixMergeConflicts}
					pullRequest={existingPullRequest}
				/>
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
			{remote.status === "done" && (
				<p className="flex items-center gap-1 text-emerald-600 text-xs dark:text-emerald-400">
					<HugeiconsIcon aria-hidden className="size-3.5" icon={Tick02Icon} />
					{remote.label}
				</p>
			)}
			{remote.status === "error" && (
				<p className="break-words text-destructive text-xs">{remote.message}</p>
			)}
			{pullRequest.status === "done" && !existingPullRequest && (
				<p className="flex items-center gap-1 text-emerald-600 text-xs dark:text-emerald-400">
					<HugeiconsIcon aria-hidden className="size-3.5" icon={Tick02Icon} />
					{pullRequest.url ? (
						<a
							className="truncate underline underline-offset-2"
							href={pullRequest.url}
							rel="noopener noreferrer"
							target="_blank"
						>
							{pullRequest.label}
						</a>
					) : (
						pullRequest.label
					)}
				</p>
			)}
			{pullRequest.status === "error" && (
				<p className="break-words text-destructive text-xs">
					{pullRequest.message}
				</p>
			)}
			{gitSetup.status === "done" && (
				<p className="flex items-center gap-1 text-emerald-600 text-xs dark:text-emerald-400">
					<HugeiconsIcon aria-hidden className="size-3.5" icon={Tick02Icon} />
					{gitSetup.label}
				</p>
			)}
			{gitSetup.status === "error" && (
				<p className="break-words text-destructive text-xs">
					{gitSetup.message}
				</p>
			)}
			{repositoryOperation.status === "done" && (
				<p className="flex items-center gap-1 text-emerald-600 text-xs dark:text-emerald-400">
					<HugeiconsIcon aria-hidden className="size-3.5" icon={Tick02Icon} />
					{repositoryOperation.url ? (
						<a
							className="truncate underline underline-offset-2"
							href={repositoryOperation.url}
							rel="noopener noreferrer"
							target="_blank"
						>
							{repositoryOperation.label}
						</a>
					) : (
						repositoryOperation.label
					)}
				</p>
			)}
			{repositoryOperation.status === "error" && (
				<p className="break-words text-destructive text-xs">
					{repositoryOperation.message}
				</p>
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
	const [commit, setCommit] = useState<GitOperationState>({ status: "idle" });
	const [gitSetup, setGitSetup] = useState<GitOperationState>({
		status: "idle",
	});
	const [pullRequest, setPullRequest] = useState<GitOperationState>({
		status: "idle",
	});
	const [remote, setRemote] = useState<GitOperationState>({ status: "idle" });
	const [repositoryOperation, setRepositoryOperation] =
		useState<GitOperationState>({ status: "idle" });
	const [commitDialogOpen, setCommitDialogOpen] = useState(false);
	const [commitMessage, setCommitMessage] = useState("");
	const [includeUnstaged, setIncludeUnstaged] = useState(true);
	const [pullRequestDialogOpen, setPullRequestDialogOpen] = useState(false);
	const [pullRequestTitle, setPullRequestTitle] = useState("");
	const [pullRequestDescription, setPullRequestDescription] = useState("");
	const [pullRequestIncludeUnstaged, setPullRequestIncludeUnstaged] =
		useState(true);
	const [repositoryDialogOpen, setRepositoryDialogOpen] = useState(false);
	const [repositoryName, setRepositoryName] = useState("");
	const [repositoryVisibility, setRepositoryVisibility] =
		useState<GitHubRepositoryVisibility>("private");
	const [branches, setBranches] = useState<string[]>([]);
	const [branchesLoading, setBranchesLoading] = useState(false);
	const [branchError, setBranchError] = useState<string | null>(null);
	const [branchSwitching, setBranchSwitching] = useState<string | null>(null);
	const [branchCreating, setBranchCreating] = useState(false);
	const [createdPullRequest, setCreatedPullRequest] =
		useState<GitPullRequest | null>(null);
	const activeGitOperationRef = useRef<AbortController | null>(null);

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

	const [stoppingProcessId, setStoppingProcessId] = useState<string | null>(
		null
	);
	const [backgroundError, setBackgroundError] = useState<string | null>(null);
	const backgroundProcessesQuery = useQuery({
		enabled: Boolean(target.url),
		queryFn: () => listBackgroundProcesses(target),
		queryKey: ["background-processes", target.url],
		refetchInterval: 1000,
		retry: false,
		staleTime: 0,
	});
	const backgroundProcesses = backgroundProcessesQuery.data ?? [];

	const handleStopBackgroundProcess = async (processId: string) => {
		if (stoppingProcessId) {
			return;
		}
		setBackgroundError(null);
		setStoppingProcessId(processId);
		try {
			await requestStopBackgroundProcess(targetRef.current, processId);
			await backgroundProcessesQuery.refetch();
		} catch (error) {
			setBackgroundError(
				error instanceof Error ? error.message : "Could not stop process."
			);
		} finally {
			setStoppingProcessId(null);
		}
	};

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

	const loadBranches = async () => {
		if (!folder) {
			return;
		}
		setBranchesLoading(true);
		setBranchError(null);
		try {
			const result = await fetchGitBranches(targetRef.current, folder);
			setBranches(result.branches);
		} finally {
			setBranchesLoading(false);
		}
	};

	const handleBranchMenuOpenChange = (open: boolean) => {
		if (open) {
			void loadBranches();
		}
	};

	const openCommitDialog = () => {
		setCommitDialogOpen(true);
		void loadBranches();
	};

	const openPullRequestDialog = () => {
		setPullRequestDialogOpen(true);
		void loadBranches();
	};

	const openCreateRepositoryDialog = () => {
		setRepositoryName((current) => current || defaultRepositoryName(folder));
		setRepositoryOperation({ status: "idle" });
		setRepositoryDialogOpen(true);
	};

	const handleInitializeGit = async () => {
		if (!folder || gitSetup.status === "loading") {
			return;
		}
		const controller = new AbortController();
		activeGitOperationRef.current = controller;
		setGitSetup({ status: "loading", phase: "initializing" });
		try {
			const result = await initializeGit(
				targetRef.current,
				folder,
				controller.signal
			);
			if (controller.signal.aborted) {
				return;
			}
			if (!result.success) {
				setGitSetup({
					status: "error",
					message: result.error ?? "Could not create local Git.",
				});
				return;
			}
			setGitSetup({
				status: "done",
				label: result.initialized ? "Local Git ready" : "Local Git is ready",
			});
			invalidateGitStatus(folder);
		} catch (error) {
			if (controller.signal.aborted) {
				return;
			}
			setGitSetup({
				status: "error",
				message:
					error instanceof Error
						? error.message
						: "Could not create local Git.",
			});
		} finally {
			if (activeGitOperationRef.current === controller) {
				activeGitOperationRef.current = null;
			}
		}
	};

	const handleCreateRepository = async (
		visibility: GitHubRepositoryVisibility
	) => {
		const name = repositoryName.trim();
		if (
			!(folder && pullRequestsEnabled && name) ||
			repositoryOperation.status === "loading"
		) {
			return;
		}
		const controller = new AbortController();
		activeGitOperationRef.current = controller;
		setRepositoryOperation({ status: "loading", phase: "committing" });
		try {
			const committed = await commitPush(
				targetRef.current,
				folder,
				"Initial commit",
				controller.signal,
				"commit",
				true
			);
			if (controller.signal.aborted) {
				return;
			}
			if (!committed.success) {
				setRepositoryOperation({
					status: "error",
					message: committed.error ?? "Could not create the initial commit.",
				});
				return;
			}
			setRepositoryOperation({
				status: "loading",
				phase: "creating-repository",
			});
			const repository = await createGitHubRepository(
				targetRef.current,
				folder,
				{ name, visibility },
				controller.signal
			);
			if (controller.signal.aborted) {
				return;
			}
			setRepositoryOperation({
				status: "done",
				label: `Published ${repository.nameWithOwner}`,
				url: repository.url,
			});
			setRepositoryDialogOpen(false);
			setRepositoryName("");
			invalidateGitStatus(folder);
			void githubRepositoryQuery.refetch();
		} catch (error) {
			if (controller.signal.aborted) {
				return;
			}
			setRepositoryOperation({
				status: "error",
				message:
					error instanceof Error
						? error.message
						: "Could not create the GitHub repository.",
			});
		} finally {
			if (activeGitOperationRef.current === controller) {
				activeGitOperationRef.current = null;
			}
		}
	};

	const handleRemoteGit = async (action: "pull" | "sync") => {
		if (
			!folder ||
			gitSetup.status === "loading" ||
			repositoryOperation.status === "loading" ||
			commit.status === "loading" ||
			pullRequest.status === "loading" ||
			remote.status === "loading"
		) {
			return;
		}
		const controller = new AbortController();
		activeGitOperationRef.current = controller;
		setRemote({
			status: "loading",
			phase: action === "pull" ? "pulling" : "syncing",
		});
		try {
			const result =
				action === "pull"
					? await pullGit(targetRef.current, folder, controller.signal)
					: await syncGit(targetRef.current, folder, controller.signal);
			if (controller.signal.aborted) {
				return;
			}
			if (!result.success) {
				setRemote({
					status: "error",
					message: result.error ?? `git ${action} failed`,
				});
				return;
			}
			setRemote({
				status: "done",
				label:
					action === "pull" ? "Pulled latest changes" : "Synced with remote",
			});
			invalidateGitStatus(folder);
		} catch (error) {
			if (controller.signal.aborted) {
				return;
			}
			setRemote({
				status: "error",
				message:
					error instanceof Error ? error.message : `git ${action} failed`,
			});
		} finally {
			if (activeGitOperationRef.current === controller) {
				activeGitOperationRef.current = null;
			}
		}
	};

	const handleSelectBranch = async (nextBranch: string) => {
		if (!folder || nextBranch === branch || branchSwitching) {
			return;
		}
		setBranchSwitching(nextBranch);
		setBranchError(null);
		const result = await checkoutBranch(targetRef.current, folder, nextBranch);
		setBranchSwitching(null);
		if (result.success) {
			setCreatedPullRequest(null);
			invalidateGitStatus(folder);
			invalidateGitPullRequest(folder, nextBranch);
		} else {
			setBranchError(result.error ?? "Failed to switch branch");
		}
	};

	const handleCreateBranch = async (name: string): Promise<string | null> => {
		if (!folder || branchCreating) {
			return "No project folder is selected.";
		}
		setBranchCreating(true);
		const result = await createBranch(targetRef.current, folder, name);
		setBranchCreating(false);
		if (!result.success) {
			return result.error ?? "Failed to create branch";
		}
		invalidateGitStatus(folder);
		void loadBranches();
		return null;
	};

	const stopGitOperation = () => {
		activeGitOperationRef.current?.abort();
		activeGitOperationRef.current = null;
		setGitSetup({ status: "idle" });
		setCommit({ status: "idle" });
		setPullRequest({ status: "idle" });
		setRemote({ status: "idle" });
		setRepositoryOperation({ status: "idle" });
		setCommitDialogOpen(false);
		setPullRequestDialogOpen(false);
		setRepositoryDialogOpen(false);
	};

	const handleCommitPush = async (action: GitCommitAction) => {
		if (
			!folder ||
			gitSetup.status === "loading" ||
			repositoryOperation.status === "loading" ||
			commit.status === "loading" ||
			pullRequest.status === "loading" ||
			remote.status === "loading"
		) {
			return;
		}
		const controller = new AbortController();
		activeGitOperationRef.current = controller;
		const message = commitMessage.trim() || undefined;
		try {
			if (!message && action !== "push") {
				setCommit({ status: "loading", phase: "generating" });
				await new Promise((resolve) => setTimeout(resolve, 120));
			}
			if (controller.signal.aborted) {
				return;
			}

			let result: Awaited<ReturnType<typeof commitPush>>;
			if (action === "commit-push") {
				setCommit({ status: "loading", phase: "committing" });
				const committed = await commitPush(
					targetRef.current,
					folder,
					message,
					controller.signal,
					"commit",
					includeUnstaged
				);
				if (committed.success) {
					setCommit({ status: "loading", phase: "pushing" });
					const pushed = await commitPush(
						targetRef.current,
						folder,
						undefined,
						controller.signal,
						"push",
						false
					);
					result = {
						...pushed,
						commit: committed.commit,
						committed: committed.committed,
					};
				} else {
					result = committed;
				}
			} else {
				setCommit({
					status: "loading",
					phase: action === "push" ? "pushing" : "committing",
				});
				result = await commitPush(
					targetRef.current,
					folder,
					message,
					controller.signal,
					action,
					includeUnstaged
				);
			}

			if (controller.signal.aborted) {
				return;
			}
			if (!result.success) {
				setCommit({
					status: "error",
					message: result.error ?? "commit/push failed",
				});
				return;
			}

			const label =
				action === "commit"
					? `Committed ${result.commit ?? "changes"}`
					: result.committed
						? `Pushed ${result.commit ?? "commit"}`
						: "Push complete";
			setCommit({ status: "done", label });
			setCommitDialogOpen(false);
			setCommitMessage("");
			// Everything on screen just changed, not only this panel.
			invalidateGitStatus(folder);
		} catch (error) {
			if (controller.signal.aborted) {
				return;
			}
			setCommit({
				status: "error",
				message: error instanceof Error ? error.message : "commit/push failed",
			});
		} finally {
			if (activeGitOperationRef.current === controller) {
				activeGitOperationRef.current = null;
			}
		}
	};

	const handlePullRequest = async (action: PullRequestAction) => {
		if (
			!(folder && canCreatePullRequest) ||
			gitSetup.status === "loading" ||
			repositoryOperation.status === "loading" ||
			commit.status === "loading" ||
			pullRequest.status === "loading" ||
			remote.status === "loading"
		) {
			return;
		}
		const controller = new AbortController();
		activeGitOperationRef.current = controller;
		setPullRequest({
			status: "loading",
			phase: pullRequestIncludeUnstaged ? "committing" : "pushing",
		});
		try {
			const result = await createPullRequest(
				targetRef.current,
				folder,
				{
					base: baseBranch,
					body: pullRequestDescription.trim() || undefined,
					draft: action === "draft",
					includeUnstaged: pullRequestIncludeUnstaged,
					title: pullRequestTitle.trim() || undefined,
				},
				controller.signal
			);
			if (controller.signal.aborted) {
				return;
			}
			if (!result.success) {
				setPullRequest({
					status: "error",
					message: result.error ?? "Could not create pull request",
				});
				return;
			}
			const label = result.already_exists
				? "Using existing PR"
				: action === "draft"
					? "Draft PR created"
					: "PR created";
			const nextPullRequest = normalizeGitPullRequest({
				base: baseBranch,
				branch,
				comments_count: result.comments_count,
				is_draft: action === "draft",
				number: result.number,
				pr_url: result.pr_url,
				repository: result.repository,
				title: result.title ?? (pullRequestTitle.trim() || `Update ${branch}`),
			});
			if (nextPullRequest) {
				setCreatedPullRequest(nextPullRequest);
			}
			setPullRequest({
				status: "done",
				label,
				url: result.pr_url ?? undefined,
			});
			setPullRequestDialogOpen(false);
			invalidateGitStatus(folder);
			invalidateGitPullRequest(folder, branch);
			if (action === "open" && result.pr_url) {
				await openExternal(result.pr_url).catch(() => undefined);
			}
		} catch (error) {
			if (controller.signal.aborted) {
				return;
			}
			setPullRequest({
				status: "error",
				message:
					error instanceof Error
						? error.message
						: "Could not create pull request",
			});
		} finally {
			if (activeGitOperationRef.current === controller) {
				activeGitOperationRef.current = null;
			}
		}
	};

	const handleFixCi = () => {
		if (!(existingPullRequest && onAttachTextFile)) {
			return;
		}
		const report = buildPullRequestCheckReport(existingPullRequest);
		onAttachTextFile({
			filename: `ci-failures-pr-${existingPullRequest.number}.txt`,
			id: `ci-failures-${existingPullRequest.number}-${Date.now()}`,
			mimeType: "text/plain",
			size: new TextEncoder().encode(report).byteLength,
			url: textToDataUrl(report),
		});
	};

	const handleFixMergeConflicts = () => {
		if (
			!(
				existingPullRequest &&
				onAttachTextFile &&
				pullRequestHasMergeConflicts(existingPullRequest)
			)
		) {
			return;
		}
		const report = buildPullRequestMergeConflictReport(existingPullRequest);
		onAttachTextFile({
			filename: `merge-conflicts-pr-${existingPullRequest.number}.txt`,
			id: `merge-conflicts-${existingPullRequest.number}-${Date.now()}`,
			mimeType: "text/plain",
			size: new TextEncoder().encode(report).byteLength,
			url: textToDataUrl(report),
		});
	};

	const changedCount = git?.changed_files_count ?? 0;
	const insertions = git?.insertions ?? 0;
	const deletions = git?.deletions ?? 0;
	const ahead = git?.ahead ?? 0;
	// A push is worth doing when there are local changes or unpushed commits.
	const hasWork = changedCount > 0 || ahead > 0;

	const backgroundItem: BouncyAccordionItem | null =
		backgroundProcesses.length === 0
			? null
			: {
					id: "background-processes",
					icon: undefined,
					title: (
						<SectionTitle
							count={backgroundProcesses.length}
							title="Background processes"
						/>
					),
					description: (
						<div className="flex flex-col gap-1">
							{backgroundProcesses.map((process) => (
								<BackgroundProcessRow
									key={process.process_id}
									onStop={(processId) => {
										void handleStopBackgroundProcess(processId);
									}}
									process={process}
									stopping={stoppingProcessId === process.process_id}
								/>
							))}
							{backgroundError && (
								<p className="px-1.5 text-[10px] text-destructive">
									{backgroundError}
								</p>
							)}
						</div>
					),
				};

	// The Environment row: read-only project context + git stats + remote/local git actions.
	// Always present — with no folder it degrades to the project row + a hint, which
	// keeps the panel from collapsing to nothing (see the file header).
	const environmentItem: BouncyAccordionItem = {
		id: "environment",
		icon: undefined,
		title: (
			<span className="font-medium text-foreground text-xs">Environment</span>
		),
		description: (
			<EnvironmentDescription
				canCreatePullRequest={canCreatePullRequest}
				chatRunning={chatRunning}
				commit={commit}
				compareUrl={compareUrl}
				conversationId={conversationId}
				existingPullRequest={existingPullRequest}
				folder={folder}
				git={git}
				githubAppEnabled={pullRequestsEnabled}
				githubRepository={githubRepository}
				githubRepositoryLoading={
					githubRepositoryQuery.isLoading || githubRepositoryQuery.isFetching
				}
				gitSetup={gitSetup}
				hasWork={hasWork}
				onFixCi={onAttachTextFile ? handleFixCi : undefined}
				onFixMergeConflicts={
					onAttachTextFile ? handleFixMergeConflicts : undefined
				}
				onHandOffToWorktree={handleHandOffToWorktree}
				onInitializeGit={() => {
					void handleInitializeGit();
				}}
				onInterruptChat={onInterruptChat}
				onOpenCommit={openCommitDialog}
				onOpenCreateRepository={openCreateRepositoryDialog}
				onOpenPullRequest={openPullRequestDialog}
				onPull={() => {
					void handleRemoteGit("pull");
				}}
				onStop={stopGitOperation}
				onSync={() => {
					void handleRemoteGit("sync");
				}}
				onWorktreeModeChange={onWorktreeModeChange}
				pullRequest={pullRequest}
				pullRequestLoading={pullRequestLoading}
				remote={remote}
				repositoryOperation={repositoryOperation}
				showLineStats={showLineStats}
				simpleMode={simpleMode}
				target={target}
				worktreeActive={worktreeStatus.active}
				worktreeBranch={worktreeBranch}
				worktreeModeOverride={worktreeModeOverride}
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
				leadingItems={[
					environmentItem,
					...(backgroundItem ? [backgroundItem] : []),
				]}
				maxItemsPerSection={5}
				variant="summary"
			/>
			<GitActionDialog
				branch={branch}
				branches={branches}
				branchesLoading={branchesLoading}
				commitMessage={commitMessage}
				deletions={deletions}
				error={commit.status === "error" ? commit.message : branchError}
				includeUnstaged={includeUnstaged}
				insertions={insertions}
				onBranchMenuOpenChange={handleBranchMenuOpenChange}
				onCommitMessageChange={setCommitMessage}
				onCreateBranch={folder ? handleCreateBranch : undefined}
				onIncludeUnstagedChange={setIncludeUnstaged}
				onOpenChange={setCommitDialogOpen}
				onSelectBranch={(nextBranch) => {
					void handleSelectBranch(nextBranch);
				}}
				onSubmit={(action) => {
					void handleCommitPush(action);
				}}
				open={commitDialogOpen}
				progress={commit.status === "loading" ? commit.phase : undefined}
			/>
			<PullRequestDialog
				baseBranch={baseBranch}
				branch={branch}
				deletions={deletions}
				description={pullRequestDescription}
				error={pullRequest.status === "error" ? pullRequest.message : null}
				includeUnstaged={pullRequestIncludeUnstaged}
				insertions={insertions}
				onDescriptionChange={setPullRequestDescription}
				onIncludeUnstagedChange={setPullRequestIncludeUnstaged}
				onOpenChange={setPullRequestDialogOpen}
				onSubmit={(action) => {
					void handlePullRequest(action);
				}}
				onTitleChange={setPullRequestTitle}
				open={pullRequestDialogOpen}
				progress={
					pullRequest.status === "loading" ? pullRequest.phase : undefined
				}
				title={pullRequestTitle}
			/>
			<CreateGitHubRepositoryDialog
				error={
					repositoryOperation.status === "error"
						? repositoryOperation.message
						: null
				}
				name={repositoryName}
				onNameChange={setRepositoryName}
				onOpenChange={setRepositoryDialogOpen}
				onSubmit={(visibility) => {
					void handleCreateRepository(visibility);
				}}
				onVisibilityChange={setRepositoryVisibility}
				open={repositoryDialogOpen}
				progress={
					repositoryOperation.status === "loading"
						? repositoryOperation.phase
						: undefined
				}
				visibility={repositoryVisibility}
			/>
		</div>
	);
}
