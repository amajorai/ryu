import {
	ArrowUpRight01Icon,
	CloudUploadIcon,
	SentIcon,
	Share08Icon,
	Tick02Icon,
	WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import {
	DiffStat,
	WorkspacePicker,
} from "@/src/components/chat/WorkspacePicker.tsx";
import { WorktreeHandoffControl } from "@/src/components/chat/WorktreeHandoffControl.tsx";
import {
	GitProgressStatus,
	GitRemoteActions,
} from "@/src/components/panels/GitActionDialogs.tsx";
import { GitPullRequestSummary } from "@/src/components/panels/GitPullRequestSummary.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { GitStatus } from "@/src/lib/api/git.ts";
import type {
	GitHubRepository,
	GitPullRequest,
} from "@/src/lib/api/pull-requests.ts";
import {
	CompareBranchLink,
	CreateLocalGitButton,
	type GitOperationState,
} from "./pinned-summary-parts.tsx";

/** The Environment row body: pickers + git line-stats + remote/local git actions. */
export function EnvironmentDescription({
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
	const tl = useLiteralMessages();
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
			<Tooltip>
				<TooltipTrigger render={<div className="flex flex-col gap-2" />}>
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
				</TooltipTrigger>
				<TooltipContent>
					No project folder is attached to this chat yet. A local-file request
					will ask you to choose one.
				</TooltipContent>
			</Tooltip>
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
						{tl(
							"{changedFiles, plural, one {{changedFilesText} file} other {{changedFilesText} files}} changed",
							{
								changedFiles,
								changedFilesText: String(
									formatCount(changedFiles) ?? changedFiles
								),
							}
						)}
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
								className="size-3.5"
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
						<Button
							className="w-full"
							disabled={!hasWork}
							onClick={onOpenCommit}
							size="sm"
							variant="mono"
						>
							<HugeiconsIcon aria-hidden className="size-4" icon={SentIcon} />
							Commit or push
						</Button>
						{canCreatePullRequest && (
							<Button
								className="w-full"
								disabled={!hasWork || (githubAppEnabled && pullRequestLoading)}
								onClick={onOpenPullRequest}
								size="sm"
								variant="outline"
							>
								<HugeiconsIcon
									aria-hidden
									className="size-4"
									icon={Share08Icon}
								/>
								Create pull request
							</Button>
						)}
					</>
				))}

			{githubAppEnabled &&
				git &&
				!githubRepositoryLoading &&
				!githubRepository &&
				!existingPullRequest?.repository && (
					<Button
						className="w-full"
						disabled={repositoryOperation.status === "loading"}
						onClick={onOpenCreateRepository}
						size="sm"
						variant="outline"
					>
						<HugeiconsIcon
							aria-hidden
							className="size-4"
							icon={CloudUploadIcon}
						/>
						Create GitHub repository
					</Button>
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
				<p className="flex items-center gap-1 text-status-success text-xs">
					<HugeiconsIcon aria-hidden className="size-3.5" icon={Tick02Icon} />
					{commit.label}
				</p>
			)}
			{commit.status === "error" && (
				<p className="break-words text-status-destructive text-xs">
					{commit.message}
				</p>
			)}
			{remote.status === "done" && (
				<p className="flex items-center gap-1 text-status-success text-xs">
					<HugeiconsIcon aria-hidden className="size-3.5" icon={Tick02Icon} />
					{remote.label}
				</p>
			)}
			{remote.status === "error" && (
				<p className="break-words text-status-destructive text-xs">
					{remote.message}
				</p>
			)}
			{pullRequest.status === "done" && !existingPullRequest && (
				<p className="flex items-center gap-1 text-status-success text-xs">
					<HugeiconsIcon aria-hidden className="size-3.5" icon={Tick02Icon} />
					{pullRequest.url ? (
						<a
							className="truncate underline underline-offset-2"
							href={safeHttpUrl(pullRequest.url) ?? undefined}
							rel="noopener noreferrer"
							target="_blank"
							title={pullRequest.label}
						>
							{pullRequest.label}
						</a>
					) : (
						pullRequest.label
					)}
				</p>
			)}
			{pullRequest.status === "error" && (
				<p className="break-words text-status-destructive text-xs">
					{pullRequest.message}
				</p>
			)}
			{gitSetup.status === "done" && (
				<p className="flex items-center gap-1 text-status-success text-xs">
					<HugeiconsIcon aria-hidden className="size-3.5" icon={Tick02Icon} />
					{gitSetup.label}
				</p>
			)}
			{gitSetup.status === "error" && (
				<p className="break-words text-status-destructive text-xs">
					{gitSetup.message}
				</p>
			)}
			{repositoryOperation.status === "done" && (
				<p className="flex items-center gap-1 text-status-success text-xs">
					<HugeiconsIcon aria-hidden className="size-3.5" icon={Tick02Icon} />
					{repositoryOperation.url ? (
						<a
							className="truncate underline underline-offset-2"
							href={safeHttpUrl(repositoryOperation.url) ?? undefined}
							rel="noopener noreferrer"
							target="_blank"
							title={repositoryOperation.label}
						>
							{repositoryOperation.label}
						</a>
					) : (
						repositoryOperation.label
					)}
				</p>
			)}
			{repositoryOperation.status === "error" && (
				<p className="break-words text-status-destructive text-xs">
					{repositoryOperation.message}
				</p>
			)}
		</div>
	);
}
