import "@fontsource-variable/geist";
import "@fontsource-variable/inter";
import "@fontsource-variable/geist-mono";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { openExternal } from "../../lib/tauri-bridge.ts";
import {
	CreateGitHubRepositoryDialog,
	GitActionDialog,
	type GitProgressPhase,
	GitProgressStatus,
	GitRemoteActions,
	type PullRequestAction,
	PullRequestDialog,
} from "../../src/components/panels/GitActionDialogs.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import {
	checkoutBranch,
	commitPush,
	createBranch,
	createPullRequest,
	fetchGitBranches,
	fetchGitStatus,
	type GitCommitAction,
	type GitStatus,
	pullGit,
	syncGit,
} from "../../src/lib/api/git.ts";
import { repositoryCreationErrorMessage } from "../../src/lib/api/git-action-error-message.ts";
import {
	createGitHubRepository,
	fetchGitHubRepository,
	fetchPullRequestForBranch,
	type GitHubRepository,
	type GitHubRepositoryVisibility,
	type GitPullRequest,
} from "../../src/lib/api/pull-requests.ts";
import "../../src/index.css";

const WORKSPACE = "/fixture/git-actions-workspace";
const INITIAL_BRANCH = "codex/git-actions-fixture";
const INITIAL_BRANCHES = [INITIAL_BRANCH, "main", "release/0.1"];

interface ProofTauriCall {
	args: { path?: string; title?: string; url?: string } | undefined;
	command: string;
}

interface ProofTauriInternals {
	invoke: (
		command: string,
		args?: { path?: string; title?: string; url?: string }
	) => Promise<void>;
	transformCallback: (callback: (...args: unknown[]) => void) => number;
}

const tauriCalls: ProofTauriCall[] = [];
// SAFETY: This private write view installs the two authored bridge callbacks immediately below, before rendering; calls record the declared command and opaque args and return unknown.
const proofWindow = window as Window & {
	__TAURI_INTERNALS__?: ProofTauriInternals;
};
proofWindow.__TAURI_INTERNALS__ = {
	invoke: async (command, args) => {
		tauriCalls.push({ args, command });
		const output = document.getElementById("tauri-native-calls");
		if (output) {
			output.textContent = JSON.stringify(tauriCalls);
		}
		return undefined;
	},
	transformCallback: () => 0,
};

function createTarget(): ApiTarget {
	return { token: null, url: window.location.origin };
}

function waitForGeneratedMessage(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}

		const finish = () => {
			window.clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = window.setTimeout(finish, 500);
		signal.addEventListener("abort", finish, { once: true });
	});
}

function statusLabel(status: GitStatus): string {
	return [
		`branch ${status.branch ?? "none"}`,
		`ahead ${status.ahead}`,
		`behind ${status.behind}`,
		`changed files ${status.changed_files_count}`,
		status.dirty ? "dirty" : "clean",
	].join(" · ");
}

function GitActionsStatefulProof() {
	const [commitOpen, setCommitOpen] = useState(true);
	const [branch, setBranch] = useState(INITIAL_BRANCH);
	const [branches, setBranches] = useState(INITIAL_BRANCHES);
	const [branchesLoading, setBranchesLoading] = useState(false);
	const [branchError, setBranchError] = useState<string | null>(null);
	const [repositoryOpen, setRepositoryOpen] = useState(false);
	const [repositoryName, setRepositoryName] = useState("");
	const [repositoryVisibility, setRepositoryVisibility] =
		useState<GitHubRepositoryVisibility>("private");
	const [repositoryProgress, setRepositoryProgress] = useState<
		GitProgressPhase | undefined
	>();
	const [repositoryError, setRepositoryError] = useState<string | null>(null);
	const [repositoryReadback, setRepositoryReadback] =
		useState<GitHubRepository | null>(null);
	const [commitMessage, setCommitMessage] = useState("");
	const [commitError, setCommitError] = useState<string | null>(null);
	const [includeUnstaged, setIncludeUnstaged] = useState(true);
	const [commitProgress, setCommitProgress] = useState<
		GitProgressPhase | undefined
	>();
	const [pullRequestOpen, setPullRequestOpen] = useState(false);
	const [pullRequestTitle, setPullRequestTitle] = useState("");
	const [pullRequestDescription, setPullRequestDescription] = useState("");
	const [pullRequestIncludeUnstaged, setPullRequestIncludeUnstaged] =
		useState(true);
	const [pullRequestProgress, setPullRequestProgress] = useState<
		GitProgressPhase | undefined
	>();
	const [pullRequestError, setPullRequestError] = useState<string | null>(null);
	const [pullRequestReadback, setPullRequestReadback] =
		useState<GitPullRequest | null>(null);
	const [, setRemoteProgress] = useState<GitProgressPhase | undefined>();
	const [remoteError, setRemoteError] = useState<string | null>(null);
	const [statusReadback, setStatusReadback] = useState<GitStatus | null>(null);
	const [environmentPhase, setEnvironmentPhase] = useState<
		GitProgressPhase | undefined
	>();
	const [actionResult, setActionResult] = useState("No Git action has run.");
	const [externalUrl, setExternalUrl] = useState<string | null>(null);
	const activeOperationRef = useRef<AbortController | null>(null);
	const target = createTarget();

	const clearActiveOperation = (controller: AbortController) => {
		if (activeOperationRef.current === controller) {
			activeOperationRef.current = null;
		}
	};

	const stopGitOperation = () => {
		activeOperationRef.current?.abort();
		activeOperationRef.current = null;
		setEnvironmentPhase(undefined);
		setRemoteProgress(undefined);
		setCommitProgress(undefined);
		setPullRequestProgress(undefined);
		setRepositoryProgress(undefined);
		setCommitOpen(false);
		setPullRequestOpen(false);
		setRepositoryOpen(false);
		setActionResult(
			"Git action cancelled; the local fixture did not persist a change."
		);
	};

	const refreshGitStatus = async (signal?: AbortSignal) => {
		const nextStatus = await fetchGitStatus(target, WORKSPACE, signal);
		if (!signal?.aborted && nextStatus.is_repo) {
			setStatusReadback(nextStatus);
			setBranch(nextStatus.branch ?? INITIAL_BRANCH);
		}
		return nextStatus;
	};

	const loadBranches = async () => {
		setBranchesLoading(true);
		setBranchError(null);
		try {
			const result = await fetchGitBranches(target, WORKSPACE);
			if (result.is_repo) {
				setBranches(result.branches);
				setBranch(result.current ?? branch);
			}
		} finally {
			setBranchesLoading(false);
		}
	};

	const handleSelectBranch = async (nextBranch: string) => {
		if (nextBranch === branch) {
			return;
		}
		setBranchError(null);
		const result = await checkoutBranch(target, WORKSPACE, nextBranch);
		if (!result.success) {
			setBranchError(result.error ?? "Failed to switch branch");
			return;
		}
		const [branchResult, nextStatus] = await Promise.all([
			fetchGitBranches(target, WORKSPACE),
			fetchGitStatus(target, WORKSPACE),
		]);
		if (branchResult.is_repo) {
			setBranches(branchResult.branches);
			setBranch(branchResult.current ?? result.branch ?? nextBranch);
		}
		setStatusReadback(nextStatus);
		setActionResult(
			`Checked out and read back ${nextStatus.branch ?? nextBranch}.`
		);
	};

	const handleCreateBranch = async (name: string): Promise<string | null> => {
		const result = await createBranch(target, WORKSPACE, name);
		if (!result.success) {
			return result.error ?? "Failed to create branch";
		}
		const [branchResult, nextStatus] = await Promise.all([
			fetchGitBranches(target, WORKSPACE),
			fetchGitStatus(target, WORKSPACE),
		]);
		if (branchResult.is_repo) {
			setBranches(branchResult.branches);
			setBranch(branchResult.current ?? result.branch ?? name);
		}
		setStatusReadback(nextStatus);
		setActionResult(
			`Created and read back branch ${nextStatus.branch ?? name}.`
		);
		return null;
	};

	const runRemoteAction = async (action: "pull" | "sync") => {
		const controller = new AbortController();
		activeOperationRef.current = controller;
		setRemoteError(null);
		setRemoteProgress(action === "pull" ? "pulling" : "syncing");
		setEnvironmentPhase(action === "pull" ? "pulling" : "syncing");
		try {
			const result =
				action === "pull"
					? await pullGit(target, WORKSPACE, controller.signal)
					: await syncGit(target, WORKSPACE, controller.signal);
			if (controller.signal.aborted) {
				return;
			}
			if (!result.success) {
				setRemoteError(result.error ?? `Git ${action} failed`);
				setActionResult(`Git ${action} failed; retry is available.`);
				return;
			}
			const nextStatus = await refreshGitStatus(controller.signal);
			if (controller.signal.aborted) {
				return;
			}
			setActionResult(
				action === "pull"
					? "Pulled and read back remote changes."
					: "Synced and read back remote changes."
			);
			if (!nextStatus.is_repo) {
				setRemoteError(
					"The local Git fixture did not return repository status."
				);
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				setRemoteError(
					error instanceof Error ? error.message : `Git ${action} failed`
				);
			}
		} finally {
			clearActiveOperation(controller);
			if (!controller.signal.aborted) {
				setRemoteProgress(undefined);
				setEnvironmentPhase(undefined);
			}
		}
	};

	const runCommit = async (action: GitCommitAction) => {
		const controller = new AbortController();
		activeOperationRef.current = controller;
		setCommitError(null);
		setCommitProgress(action === "push" ? "pushing" : "committing");
		setEnvironmentPhase(action === "push" ? "pushing" : "committing");
		const message = commitMessage.trim() || undefined;
		try {
			if (!message && action !== "push") {
				setCommitProgress("generating");
				setEnvironmentPhase("generating");
				await waitForGeneratedMessage(controller.signal);
			}
			if (controller.signal.aborted) {
				return;
			}

			let result: Awaited<ReturnType<typeof commitPush>>;
			if (action === "commit-push") {
				const committed = await commitPush(
					target,
					WORKSPACE,
					message,
					controller.signal,
					"commit",
					includeUnstaged
				);
				if (controller.signal.aborted) {
					return;
				}
				if (committed.success) {
					setCommitProgress("pushing");
					setEnvironmentPhase("pushing");
					const pushed = await commitPush(
						target,
						WORKSPACE,
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
				result = await commitPush(
					target,
					WORKSPACE,
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
				setCommitError(result.error ?? "Commit or push failed");
				setActionResult(`Git ${action} failed; retry is available.`);
				return;
			}
			const nextStatus = await refreshGitStatus(controller.signal);
			if (controller.signal.aborted) {
				return;
			}
			const actionLabel =
				action === "commit"
					? "Committed"
					: action === "commit-push"
						? "Committed and pushed"
						: "Pushed";
			setActionResult(
				`${actionLabel} ${result.commit ?? "fixture revision"}; read back ${statusLabel(nextStatus)}.`
			);
			setCommitMessage("");
			setCommitOpen(false);
		} catch (error) {
			if (!controller.signal.aborted) {
				setCommitError(
					error instanceof Error ? error.message : "Commit or push failed"
				);
			}
		} finally {
			clearActiveOperation(controller);
			if (!controller.signal.aborted) {
				setCommitProgress(undefined);
				setEnvironmentPhase(undefined);
			}
		}
	};

	const runCreateRepository = async (
		visibility: GitHubRepositoryVisibility
	) => {
		const name = repositoryName.trim();
		if (!name) {
			return;
		}
		const controller = new AbortController();
		activeOperationRef.current = controller;
		setRepositoryError(null);
		setRepositoryProgress("committing");
		setEnvironmentPhase("committing");
		try {
			const commit = await commitPush(
				target,
				WORKSPACE,
				"Initial commit",
				controller.signal,
				"commit",
				true
			);
			if (controller.signal.aborted) {
				return;
			}
			if (!commit.success) {
				setRepositoryError(
					commit.error ?? "Could not create the initial commit."
				);
				return;
			}

			setRepositoryProgress("creating-repository");
			setEnvironmentPhase("creating-repository");
			const created = await createGitHubRepository(target, WORKSPACE, {
				name,
				visibility,
			});
			if (controller.signal.aborted) {
				return;
			}
			const saved = await fetchGitHubRepository(
				target,
				WORKSPACE,
				controller.signal
			);
			if (controller.signal.aborted) {
				return;
			}
			const repository = saved ?? created;
			setRepositoryReadback(repository);
			setActionResult(
				`Published ${repository.nameWithOwner} and read it back.`
			);
			setRepositoryName("");
			setRepositoryOpen(false);
		} catch (error) {
			if (!controller.signal.aborted) {
				setRepositoryError(repositoryCreationErrorMessage(error));
			}
		} finally {
			clearActiveOperation(controller);
			if (!controller.signal.aborted) {
				setRepositoryProgress(undefined);
				setEnvironmentPhase(undefined);
			}
		}
	};

	const runPullRequest = async (action: PullRequestAction) => {
		const controller = new AbortController();
		activeOperationRef.current = controller;
		setPullRequestError(null);
		const phase = pullRequestIncludeUnstaged ? "committing" : "pushing";
		setPullRequestProgress(phase);
		setEnvironmentPhase(phase);
		try {
			const result = await createPullRequest(
				target,
				WORKSPACE,
				{
					base: "main",
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
				setPullRequestError(result.error ?? "Could not create pull request");
				setActionResult("Pull request failed; retry is available.");
				return;
			}
			const readback = await fetchPullRequestForBranch(
				target,
				WORKSPACE,
				branch,
				controller.signal
			);
			if (controller.signal.aborted) {
				return;
			}
			setPullRequestReadback(readback);
			const pullRequestUrl = readback?.url ?? result.pr_url ?? null;
			if (action === "open" && pullRequestUrl) {
				await openExternal(pullRequestUrl).catch(() => undefined);
				setExternalUrl(pullRequestUrl);
			}
			const actionLabel =
				action === "draft" ? "Draft PR created" : "PR created";
			const readbackLabel = readback
				? ` and read back #${readback.number}`
				: "";
			const browserTargetLabel =
				pullRequestUrl && action === "open"
					? "; browser target captured."
					: ".";
			setActionResult(`${actionLabel}${readbackLabel}${browserTargetLabel}`);
			setPullRequestOpen(false);
		} catch (error) {
			if (!controller.signal.aborted) {
				setPullRequestError(
					error instanceof Error
						? error.message
						: "Could not create pull request"
				);
			}
		} finally {
			clearActiveOperation(controller);
			if (!controller.signal.aborted) {
				setPullRequestProgress(undefined);
				setEnvironmentPhase(undefined);
			}
		}
	};

	const remotePhase =
		environmentPhase === "pulling" || environmentPhase === "syncing";

	return (
		<main className="min-h-screen bg-background p-6 text-foreground sm:p-8">
			<div className="mx-auto max-w-5xl space-y-5">
				<header className="rounded-2xl border border-border/70 bg-card p-6">
					<p className="font-heading text-primary text-xs uppercase tracking-(--tracking-section)">
						Ryu · Git workspace · Local fixture
					</p>
					<h1 className="mt-2 font-heading font-semibold text-2xl tracking-tight">
						Git action dialog verification
					</h1>
					<p className="mt-2 max-w-3xl text-muted-foreground text-sm">
						These production dialogs call the typed Git API client against a
						local browser fixture. No shell command, local repository, GitHub
						account, or remote Git operation is used.
					</p>
					<div className="mt-4 flex flex-wrap gap-2">
						<button
							className="rounded-full border border-border/70 px-4 py-2 text-sm transition hover:bg-muted"
							onClick={() => setRepositoryOpen(true)}
							type="button"
						>
							Open repository dialog
						</button>
						<button
							className="rounded-full border border-border/70 px-4 py-2 text-sm transition hover:bg-muted"
							onClick={() => {
								setCommitError(null);
								setCommitProgress(undefined);
								setCommitOpen(true);
								setEnvironmentPhase(undefined);
							}}
							type="button"
						>
							Open commit dialog
						</button>
						<button
							className="rounded-full border border-border/70 px-4 py-2 text-sm transition hover:bg-muted"
							onClick={() => {
								setPullRequestError(null);
								setPullRequestProgress(undefined);
								setPullRequestOpen(true);
								setEnvironmentPhase(undefined);
							}}
							type="button"
						>
							Open pull request dialog
						</button>
					</div>
				</header>

				<div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
					<section className="space-y-5 rounded-2xl border border-border/70 bg-card p-6">
						<div>
							<div className="flex items-center justify-between gap-3">
								<h2 className="font-medium text-base">Environment</h2>
								<span className="text-muted-foreground text-xs">
									Local Git fixture
								</span>
							</div>
							<div className="mt-3" data-testid="environment-status">
								{environmentPhase ? (
									<GitProgressStatus
										onStop={remotePhase ? undefined : stopGitOperation}
										phase={environmentPhase}
									/>
								) : (
									<>
										<p className="text-muted-foreground text-sm">
											Git actions are ready.
										</p>
										<div className="mt-3">
											<GitRemoteActions
												onPull={() => void runRemoteAction("pull")}
												onSync={() => void runRemoteAction("sync")}
											/>
										</div>
									</>
								)}
								{remoteError ? (
									<p
										className="mt-3 text-sm text-status-destructive"
										role="alert"
									>
										{remoteError}
									</p>
								) : null}
							</div>
						</div>

						<div className="border-border/70 border-t pt-4">
							<h2 className="font-medium text-base">Workspace</h2>
							<p className="mt-2 text-muted-foreground text-sm">{WORKSPACE}</p>
							<p
								className="mt-1 font-mono text-xs"
								data-testid="branch-readback"
							>
								Current branch: {branch}
							</p>
							{branchError ? (
								<p
									className="mt-2 text-sm text-status-destructive"
									role="alert"
								>
									{branchError}
								</p>
							) : null}
						</div>

						<div className="border-border/70 border-t pt-4">
							<h2 className="font-medium text-base">Last action</h2>
							<p
								className="mt-2 text-sm"
								data-testid="action-result"
								role="status"
							>
								{actionResult}
							</p>
						</div>
					</section>

					<aside className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
						<h2 className="font-medium text-base">Fixture read-back</h2>
						<div>
							<p className="text-muted-foreground text-xs">Git status</p>
							<p
								className="mt-1 font-mono text-xs"
								data-testid="git-status-readback"
							>
								{statusReadback ? statusLabel(statusReadback) : "Not read yet"}
							</p>
						</div>
						<div>
							<p className="text-muted-foreground text-xs">GitHub repository</p>
							<p className="mt-1 text-sm" data-testid="repository-readback">
								{repositoryReadback
									? repositoryReadback.nameWithOwner
									: "Not created"}
							</p>
						</div>
						<div>
							<p className="text-muted-foreground text-xs">Pull request</p>
							<p className="mt-1 text-sm" data-testid="pull-request-readback">
								{pullRequestReadback
									? `#${pullRequestReadback.number} · ${pullRequestReadback.isDraft ? "draft" : "ready"} · ${pullRequestReadback.title}`
									: "Not created"}
							</p>
						</div>
						{externalUrl ? (
							<p
								className="break-all text-success text-xs"
								data-testid="external-url-requested"
							>
								Browser target: {externalUrl}
							</p>
						) : null}
						<output className="sr-only" data-testid="tauri-native-calls">
							{JSON.stringify(tauriCalls)}
						</output>
					</aside>
				</div>
			</div>

			<GitActionDialog
				branch={branch}
				branches={branches}
				branchesLoading={branchesLoading}
				commitMessage={commitMessage}
				deletions={3}
				error={commitError ?? branchError}
				includeUnstaged={includeUnstaged}
				insertions={7}
				onBranchMenuOpenChange={(open) => {
					if (open) {
						void loadBranches();
					}
				}}
				onCommitMessageChange={setCommitMessage}
				onCreateBranch={handleCreateBranch}
				onIncludeUnstagedChange={setIncludeUnstaged}
				onOpenChange={setCommitOpen}
				onSelectBranch={(nextBranch) => void handleSelectBranch(nextBranch)}
				onSubmit={(action) => void runCommit(action)}
				open={commitOpen}
				progress={commitProgress}
			/>
			<CreateGitHubRepositoryDialog
				error={repositoryError}
				name={repositoryName}
				onNameChange={setRepositoryName}
				onOpenChange={setRepositoryOpen}
				onSubmit={(visibility) => void runCreateRepository(visibility)}
				onVisibilityChange={setRepositoryVisibility}
				open={repositoryOpen}
				progress={repositoryProgress}
				visibility={repositoryVisibility}
			/>
			<PullRequestDialog
				baseBranch="main"
				branch={branch}
				deletions={3}
				description={pullRequestDescription}
				error={pullRequestError}
				includeUnstaged={pullRequestIncludeUnstaged}
				insertions={7}
				onDescriptionChange={setPullRequestDescription}
				onIncludeUnstagedChange={setPullRequestIncludeUnstaged}
				onOpenChange={setPullRequestOpen}
				onSubmit={(action) => void runPullRequest(action)}
				onTitleChange={setPullRequestTitle}
				open={pullRequestOpen}
				progress={pullRequestProgress}
				title={pullRequestTitle}
			/>
		</main>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Git action fixture root is missing");
}

createRoot(root).render(<GitActionsStatefulProof />);
