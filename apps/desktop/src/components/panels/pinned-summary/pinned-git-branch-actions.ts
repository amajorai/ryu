import type { MutableRefObject } from "react";
import { invalidateGitPullRequest } from "@/src/hooks/useGitPullRequest.ts";
import { invalidateGitStatus } from "@/src/hooks/useGitStatus.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	checkoutBranch,
	commitPush,
	createBranch,
	fetchGitBranches,
	initializeGit,
	pullGit,
	syncGit,
} from "@/src/lib/api/git.ts";
import { repositoryCreationErrorMessage } from "@/src/lib/api/git-action-error-message.ts";
import {
	createGitHubRepository,
	type GitHubRepositoryVisibility,
} from "@/src/lib/api/pull-requests.ts";
import { defaultRepositoryName } from "./pinned-summary-parts.tsx";
import type { PinnedGitState } from "./use-pinned-git-state.ts";

export interface PinnedGitContext {
	branch: string;
	folder: string | null;
	targetRef: MutableRefObject<ApiTarget>;
}

/**
 * Branch, local-Git, GitHub repository and pull/sync actions of the pinned
 * summary. Recreated each render like the inline handlers they replace.
 */
export function pinnedGitBranchActions(
	state: PinnedGitState,
	{
		branch,
		folder,
		githubRepositoryQuery,
		pullRequestsEnabled,
		targetRef,
	}: PinnedGitContext & {
		githubRepositoryQuery: { refetch: () => Promise<unknown> };
		pullRequestsEnabled: boolean;
	}
) {
	const {
		activeGitOperationRef,
		branchCreating,
		branchSwitching,
		commit,
		gitSetup,
		pullRequest,
		remote,
		repositoryName,
		repositoryOperation,
		setBranchCreating,
		setBranchError,
		setBranchSwitching,
		setBranches,
		setBranchesLoading,
		setCommit,
		setCommitDialogOpen,
		setCreatedPullRequest,
		setGitSetup,
		setPullRequest,
		setPullRequestDialogOpen,
		setRemote,
		setRepositoryDialogOpen,
		setRepositoryName,
		setRepositoryOperation,
	} = state;

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
				message: repositoryCreationErrorMessage(error),
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
	return {
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
	};
}
