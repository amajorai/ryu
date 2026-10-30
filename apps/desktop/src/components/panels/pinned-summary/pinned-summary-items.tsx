import type { ComponentProps } from "react";
import { SectionTitle } from "@/src/components/panels/CoworkContextPanel.tsx";
import type { ContextSectionItem } from "../cowork-context/context-sections.tsx";
import type { PinnedSummaryPanelProps } from "../PinnedSummaryPanel.tsx";
import { EnvironmentDescription } from "./environment-description.tsx";
import { BackgroundProcessRow } from "./pinned-summary-parts.tsx";
import type { usePinnedBackgroundProcesses } from "./use-pinned-background-processes.ts";

type EnvProps = ComponentProps<typeof EnvironmentDescription>;
type BackgroundState = ReturnType<typeof usePinnedBackgroundProcesses>;

interface PinnedSummaryItemsFields
	extends Pick<
			BackgroundState,
			| "backgroundError"
			| "backgroundProcesses"
			| "handleStopBackgroundProcess"
			| "stoppingProcessId"
		>,
		Pick<
			EnvProps,
			| "canCreatePullRequest"
			| "chatRunning"
			| "commit"
			| "compareUrl"
			| "conversationId"
			| "existingPullRequest"
			| "folder"
			| "git"
			| "gitSetup"
			| "githubRepository"
			| "githubRepositoryLoading"
			| "hasWork"
			| "onInterruptChat"
			| "onWorktreeModeChange"
			| "pullRequest"
			| "pullRequestLoading"
			| "remote"
			| "repositoryOperation"
			| "showLineStats"
			| "simpleMode"
			| "target"
			| "worktreeActive"
			| "worktreeBranch"
			| "worktreeModeOverride"
		> {
	handleFixCi: () => void;
	handleFixMergeConflicts: () => void;
	handleHandOffToWorktree: (branchName: string) => void;
	handleInitializeGit: () => Promise<void>;
	handleRemoteGit: (action: "pull" | "sync") => Promise<void>;
	onAttachTextFile: PinnedSummaryPanelProps["onAttachTextFile"];
	openCommitDialog: () => void;
	openCreateRepositoryDialog: () => void;
	openPullRequestDialog: () => void;
	pullRequestsEnabled: boolean;
	stopGitOperation: () => void;
}

/**
 * The pinned summary's leading sections: Environment (always) and
 * Background processes (only while any run).
 */
export function pinnedSummaryItems({
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
	githubRepositoryLoading,
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
	worktreeActive,
	worktreeBranch,
	worktreeModeOverride,
}: PinnedSummaryItemsFields) {
	const backgroundItem: ContextSectionItem | null =
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
								<p
									className="text-status-destructive text-xs"
									role="alert"
									title={backgroundError}
								>
									Could not stop process. Try again.
								</p>
							)}
						</div>
					),
				};

	// The Environment row: read-only project context + git stats + remote/local git actions.
	// Always present — with no folder it degrades to the project row + a hint, which
	// keeps the panel from collapsing to nothing (see the file header).
	const environmentItem: ContextSectionItem = {
		id: "environment",
		icon: undefined,
		title: (
			<span className="font-semibold text-foreground text-sm">Environment</span>
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
				githubRepositoryLoading={githubRepositoryLoading}
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
				worktreeActive={worktreeActive}
				worktreeBranch={worktreeBranch}
				worktreeModeOverride={worktreeModeOverride}
			/>
		),
	};
	return { backgroundItem, environmentItem };
}
