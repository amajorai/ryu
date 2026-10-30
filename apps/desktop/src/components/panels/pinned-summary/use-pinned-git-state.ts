import { useRef, useState } from "react";
import type {
	GitHubRepositoryVisibility,
	GitPullRequest,
} from "@/src/lib/api/pull-requests.ts";
import type { GitOperationState } from "./pinned-summary-parts.tsx";

/** The panel's git dialogs, drafts and in-flight operation state. */
export function usePinnedGitState() {
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
	return {
		commit,
		setCommit,
		gitSetup,
		setGitSetup,
		pullRequest,
		setPullRequest,
		remote,
		setRemote,
		repositoryOperation,
		setRepositoryOperation,
		commitDialogOpen,
		setCommitDialogOpen,
		commitMessage,
		setCommitMessage,
		includeUnstaged,
		setIncludeUnstaged,
		pullRequestDialogOpen,
		setPullRequestDialogOpen,
		pullRequestTitle,
		setPullRequestTitle,
		pullRequestDescription,
		setPullRequestDescription,
		pullRequestIncludeUnstaged,
		setPullRequestIncludeUnstaged,
		repositoryDialogOpen,
		setRepositoryDialogOpen,
		repositoryName,
		setRepositoryName,
		repositoryVisibility,
		setRepositoryVisibility,
		branches,
		setBranches,
		branchesLoading,
		setBranchesLoading,
		branchError,
		setBranchError,
		branchSwitching,
		setBranchSwitching,
		branchCreating,
		setBranchCreating,
		createdPullRequest,
		setCreatedPullRequest,
		activeGitOperationRef,
	};
}

export type PinnedGitState = ReturnType<typeof usePinnedGitState>;
