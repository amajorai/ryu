import {
	CreateGitHubRepositoryDialog,
	GitActionDialog,
	type PullRequestAction,
	PullRequestDialog,
} from "@/src/components/panels/GitActionDialogs.tsx";
import type { GitCommitAction } from "@/src/lib/api/git.ts";
import type { GitHubRepositoryVisibility } from "@/src/lib/api/pull-requests.ts";
import type { PinnedGitState } from "./use-pinned-git-state.ts";

interface PinnedGitDialogsInput {
	baseBranch: string;
	branch: string;
	deletions: number;
	folder: string | null;
	handleBranchMenuOpenChange: (open: boolean) => void;
	handleCommitPush: (action: GitCommitAction) => Promise<void>;
	handleCreateBranch: (name: string) => Promise<string | null>;
	handleCreateRepository: (
		visibility: GitHubRepositoryVisibility
	) => Promise<void>;
	handlePullRequest: (action: PullRequestAction) => Promise<void>;
	handleSelectBranch: (nextBranch: string) => Promise<void>;
	insertions: number;
}

/** The commit, pull-request and create-repository dialogs of the pinned summary. */
export function renderPinnedGitDialogs(
	state: PinnedGitState,
	{
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
	}: PinnedGitDialogsInput
) {
	const {
		branches,
		branchesLoading,
		branchError,
		commit,
		commitDialogOpen,
		commitMessage,
		includeUnstaged,
		pullRequest,
		pullRequestDescription,
		pullRequestDialogOpen,
		pullRequestIncludeUnstaged,
		pullRequestTitle,
		repositoryDialogOpen,
		repositoryName,
		repositoryOperation,
		repositoryVisibility,
		setCommitDialogOpen,
		setCommitMessage,
		setIncludeUnstaged,
		setPullRequestDescription,
		setPullRequestDialogOpen,
		setPullRequestIncludeUnstaged,
		setPullRequestTitle,
		setRepositoryDialogOpen,
		setRepositoryName,
		setRepositoryVisibility,
	} = state;
	return (
		<>
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
		</>
	);
}
