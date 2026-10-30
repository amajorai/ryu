import { openExternal } from "@/lib/tauri-bridge.ts";
import type { PullRequestAction } from "@/src/components/panels/GitActionDialogs.tsx";
import { invalidateGitPullRequest } from "@/src/hooks/useGitPullRequest.ts";
import { invalidateGitStatus } from "@/src/hooks/useGitStatus.ts";
import {
	commitPush,
	createPullRequest,
	type GitCommitAction,
} from "@/src/lib/api/git.ts";
import {
	buildPullRequestCheckReport,
	buildPullRequestMergeConflictReport,
	type GitPullRequest,
	normalizeGitPullRequest,
	pullRequestHasMergeConflicts,
} from "@/src/lib/api/pull-requests.ts";
import { textToDataUrl } from "@/src/lib/composer/attachments.ts";
import type { PinnedSummaryPanelProps } from "../PinnedSummaryPanel.tsx";
import type { PinnedGitContext } from "./pinned-git-branch-actions.ts";
import type { PinnedGitState } from "./use-pinned-git-state.ts";

/**
 * Commit/push and pull-request actions of the pinned summary, plus the
 * "fix CI" and "fix merge conflicts" report attachments.
 */
export function pinnedGitCommitActions(
	state: PinnedGitState,
	{
		baseBranch,
		branch,
		canCreatePullRequest,
		existingPullRequest,
		folder,
		onAttachTextFile,
		targetRef,
	}: PinnedGitContext & {
		baseBranch: string;
		canCreatePullRequest: boolean;
		existingPullRequest: GitPullRequest | null;
		onAttachTextFile: PinnedSummaryPanelProps["onAttachTextFile"];
	}
) {
	const {
		activeGitOperationRef,
		commit,
		commitMessage,
		gitSetup,
		includeUnstaged,
		pullRequest,
		pullRequestDescription,
		pullRequestIncludeUnstaged,
		pullRequestTitle,
		remote,
		repositoryOperation,
		setCommit,
		setCommitDialogOpen,
		setCommitMessage,
		setCreatedPullRequest,
		setPullRequest,
		setPullRequestDialogOpen,
	} = state;

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
	return {
		handleCommitPush,
		handleFixCi,
		handleFixMergeConflicts,
		handlePullRequest,
	};
}
