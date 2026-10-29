import "@fontsource-variable/geist";
import "@fontsource-variable/inter";
import "@fontsource-variable/geist-mono";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	SidebarItemPreview,
	SidebarPreviewMeta,
	SidebarPreviewTitle,
} from "../../src/components/layout/sidebar-item-preview.tsx";
import {
	CreateGitHubRepositoryDialog,
	GitActionDialog,
	type GitProgressPhase,
	GitProgressStatus,
	GitRemoteActions,
	type PullRequestAction,
	PullRequestDialog,
} from "../../src/components/panels/GitActionDialogs.tsx";
import {
	GitPullRequestStatusIcon,
	GitPullRequestSummary,
} from "../../src/components/panels/GitPullRequestSummary.tsx";
import type { GitCommitAction } from "../../src/lib/api/git.ts";
import {
	buildPullRequestCheckReport,
	type GitPullRequest,
} from "../../src/lib/api/pull-requests.ts";
import { textToDataUrl } from "../../src/lib/composer/attachments.ts";
import "../../src/index.css";

const BRANCH = "codex/gateway-posture-doctor";
const BRANCHES = [BRANCH, "main", "release/0.1"];
const PROOF_PULL_REQUEST: GitPullRequest = {
	baseRefName: "main",
	branch: BRANCH,
	commentsCount: 3,
	headRefName: BRANCH,
	headRefOid: "abc123def456",
	isDraft: false,
	mergedAt: null,
	number: 552,
	repository: "amajorai/ryu",
	state: "OPEN",
	statusCheckRollup: [
		{
			bucket: "fail",
			conclusion: "failure",
			description: "TypeScript diagnostics remain.",
			detailsUrl: "https://github.com/amajorai/ryu/actions/runs/1",
			name: "Type-check + lint (TS/JS)",
			state: "completed",
			status: "completed",
			workflowName: "CI",
		},
		{
			bucket: "fail",
			conclusion: "failure",
			description: "Host wiring suite failed.",
			detailsUrl: "https://github.com/amajorai/ryu/actions/runs/2",
			name: "DOM wiring + host suite",
			state: "completed",
			status: "completed",
			workflowName: "CI",
		},
		{
			bucket: "fail",
			conclusion: "failure",
			description: "Rust formatting and tests failed.",
			detailsUrl: "https://github.com/amajorai/ryu/actions/runs/3",
			name: "fmt + clippy + test + license scan",
			state: "completed",
			status: "completed",
			workflowName: "CI",
		},
		{
			bucket: "fail",
			conclusion: "failure",
			description: "Runtime certification failed.",
			detailsUrl: "https://github.com/amajorai/ryu/actions/runs/4",
			name: "plugin-runtime-cert",
			state: "completed",
			status: "completed",
			workflowName: "CI",
		},
		{
			bucket: "pass",
			conclusion: "success",
			description: null,
			detailsUrl: "https://github.com/amajorai/ryu/actions/runs/5",
			name: "security/snyk",
			state: "completed",
			status: "completed",
			workflowName: "CI",
		},
	],
	title: "Harden Gateway posture checks",
	updatedAt: "2026-08-18T00:00:00Z",
	url: "https://github.com/amajorai/ryu/pull/552",
};

const STATUS_PULL_REQUESTS: Array<{
	label: string;
	pullRequest: GitPullRequest;
}> = [
	{ label: "Open", pullRequest: PROOF_PULL_REQUEST },
	{
		label: "Draft",
		pullRequest: {
			...PROOF_PULL_REQUEST,
			isDraft: true,
			number: 553,
			state: "OPEN",
			title: "Stage Gateway posture checks",
		},
	},
	{
		label: "Closed",
		pullRequest: {
			...PROOF_PULL_REQUEST,
			isDraft: false,
			number: 554,
			state: "CLOSED",
			title: "Retire the old posture check",
		},
	},
	{
		label: "Merged",
		pullRequest: {
			...PROOF_PULL_REQUEST,
			isDraft: false,
			mergedAt: "2026-08-19T10:00:00Z",
			number: 555,
			state: "MERGED",
			title: "Ship Gateway posture checks",
		},
	},
];

function GitActionsProof() {
	const [commitOpen, setCommitOpen] = useState(true);
	const [branch, setBranch] = useState(BRANCH);
	const [repositoryOpen, setRepositoryOpen] = useState(false);
	const [repositoryName, setRepositoryName] = useState("");
	const [visibility, setVisibility] = useState<"private" | "public">("private");
	const [pullRequestOpen, setPullRequestOpen] = useState(false);
	const [commitMessage, setCommitMessage] = useState("");
	const [includeUnstaged, setIncludeUnstaged] = useState(true);
	const [pullRequestTitle, setPullRequestTitle] = useState("");
	const [pullRequestDescription, setPullRequestDescription] = useState("");
	const [pullRequestIncludeUnstaged, setPullRequestIncludeUnstaged] =
		useState(true);
	const [commitProgress, setCommitProgress] = useState<
		GitProgressPhase | undefined
	>();
	const [pullRequestProgress, setPullRequestProgress] = useState<
		GitProgressPhase | undefined
	>();
	const [environmentPhase, setEnvironmentPhase] = useState<
		GitProgressPhase | undefined
	>();
	const [ciAttachment, setCiAttachment] = useState<{
		filename: string;
		url: string;
	} | null>(null);

	useEffect(() => {
		document.documentElement.classList.toggle(
			"dark",
			new URLSearchParams(window.location.search).get("theme") !== "light"
		);
		return () => document.documentElement.classList.remove("dark");
	}, []);

	const handleCommit = (action: GitCommitAction) => {
		const phase = action === "push" ? "pushing" : "committing";
		setCommitProgress(phase);
		setEnvironmentPhase(phase);
	};

	const handlePullRequest = (_action: PullRequestAction) => {
		setPullRequestProgress("creating");
		setEnvironmentPhase("creating");
	};

	const handleFixCi = () => {
		const report = buildPullRequestCheckReport(PROOF_PULL_REQUEST);
		setCiAttachment({
			filename: `ci-failures-pr-${PROOF_PULL_REQUEST.number}.txt`,
			url: textToDataUrl(report),
		});
	};

	const remotePhase =
		environmentPhase === "pulling" || environmentPhase === "syncing";

	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
				<section className="rounded-2xl border border-border/70 bg-card p-8">
					<p className="font-heading font-semibold text-primary text-xs uppercase tracking-(--tracking-section)">
						Ryu · Git workspace · Sample data
					</p>
					<h1 className="mt-3 font-heading font-semibold text-3xl tracking-tight">
						Ship changes from the pinned summary
					</h1>
					<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
						The production dialogs keep branch targeting, line stats, and the
						commit, push, and pull-request actions in one focused surface.
					</p>

					<div className="mt-10 rounded-3xl border border-border/60 bg-background/70 p-5">
						<div className="flex items-center justify-between gap-4">
							<div>
								<p className="font-medium text-sm">Workspace changes</p>
								<p className="mt-1 text-muted-foreground text-xs">
									{BRANCH} · local environment
								</p>
							</div>
							<span className="font-heading font-medium text-2xl text-success tabular-nums">
								+76,383 <span className="text-destructive">−8,438</span>
							</span>
						</div>
						<div className="mt-5 border-border/60 border-t pt-4">
							<div className="flex items-center justify-between gap-3">
								<p className="font-medium text-sm">Environment</p>
								<span className="text-muted-foreground text-xs">
									Pinned summary status
								</span>
							</div>
							<div className="mt-3" data-testid="environment-status">
								{environmentPhase ? (
									<GitProgressStatus
										onStop={
											remotePhase
												? undefined
												: () => {
														setEnvironmentPhase(undefined);
														setCommitProgress(undefined);
														setPullRequestProgress(undefined);
													}
										}
										phase={environmentPhase}
									/>
								) : (
									<>
										<p className="text-muted-foreground text-xs">
											Commit or push is ready.
										</p>
										<div className="mt-2">
											<GitRemoteActions
												onPull={() => setEnvironmentPhase("pulling")}
												onSync={() => setEnvironmentPhase("syncing")}
											/>
										</div>
									</>
								)}
							</div>
							<div
								className="mt-5 border-border/60 border-t pt-4"
								data-testid="pr-ci-summary"
							>
								<div className="flex items-center justify-between gap-3">
									<p className="font-medium text-sm">Existing pull request</p>
									<span className="text-muted-foreground text-xs">
										GitHub app
									</span>
								</div>
								<div className="mt-3">
									<GitPullRequestSummary
										onFix={handleFixCi}
										pullRequest={PROOF_PULL_REQUEST}
									/>
								</div>
								{ciAttachment ? (
									<p
										className="mt-3 rounded-md bg-success/10 px-2 py-1.5 text-success text-xs"
										data-testid="ci-report-attached"
									>
										Attached {ciAttachment.filename}
									</p>
								) : null}
							</div>
						</div>
					</div>

					<div className="mt-6 flex flex-wrap gap-2">
						<button onClick={() => setRepositoryOpen(true)} type="button">
							Open repository dialog
						</button>
						<button
							className="rounded-full border border-border/70 px-4 py-2 text-sm transition hover:bg-muted"
							data-testid="show-generating"
							onClick={() => setEnvironmentPhase("generating")}
							type="button"
						>
							Show generating status
						</button>
						<button
							className="rounded-full border border-border/70 px-4 py-2 text-sm transition hover:bg-muted"
							data-testid="open-commit-dialog"
							onClick={() => {
								setCommitProgress(undefined);
								setCommitOpen(true);
							}}
							type="button"
						>
							Open commit dialog
						</button>
						<button
							className="rounded-full border border-border/70 px-4 py-2 text-sm transition hover:bg-muted"
							data-testid="open-pr-dialog"
							onClick={() => {
								setPullRequestProgress(undefined);
								setPullRequestOpen(true);
							}}
							type="button"
						>
							Open pull request dialog
						</button>
					</div>
				</section>

				<aside className="rounded-2xl border border-border/70 bg-card p-5">
					<p className="font-medium text-sm">Verification surface</p>
					<dl className="mt-4 space-y-3 text-xs">
						<div>
							<dt className="text-muted-foreground">Branch</dt>
							<dd className="mt-1 truncate font-mono">{BRANCH}</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">Diff</dt>
							<dd className="mt-1 font-mono text-success">+76,383 −8,438</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">Actions</dt>
							<dd className="mt-1">
								Pull · Sync · Commit · Commit and push · Push
							</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">Pull request</dt>
							<dd className="mt-1">Draft · Create · Open in browser</dd>
						</div>
					</dl>
					<div className="mt-8 border-border/60 border-t pt-4">
						<p className="text-muted-foreground text-xs">Chat hover preview</p>
						<SidebarItemPreview
							className="mt-2"
							content={
								<SidebarPreviewTitle title="Gateway posture chat">
									<SidebarPreviewMeta label="Branch" value={BRANCH} />
									<SidebarPreviewMeta
										label="Folder"
										value="/Users/jiawei/Documents/Code/ryu-closed"
										wrap
									/>
								</SidebarPreviewTitle>
							}
							renderContent={(open) =>
								open ? (
									<div className="mt-3 border-border/60 border-t pt-3">
										<GitPullRequestSummary pullRequest={PROOF_PULL_REQUEST} />
									</div>
								) : null
							}
						>
							<span
								className="block cursor-default rounded-lg border border-border/60 px-3 py-2 text-sm transition hover:bg-muted"
								data-testid="sidebar-chat-trigger"
							>
								Gateway posture chat
							</span>
						</SidebarItemPreview>
					</div>
					<div
						className="mt-8 border-border/60 border-t pt-4"
						data-testid="code-mode-pr-statuses"
					>
						<p className="font-medium text-sm">Code mode chat sessions</p>
						<p className="mt-1 text-muted-foreground text-xs">
							Compact linked status icons use the same GitHub colors.
						</p>
						<div className="mt-3 space-y-1.5">
							{STATUS_PULL_REQUESTS.map(({ label, pullRequest }) => (
								<div
									className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/60 px-3 py-2"
									key={pullRequest.number}
								>
									<span className="min-w-0 truncate text-sm">
										{pullRequest.title}
									</span>
									<GitPullRequestStatusIcon pullRequest={pullRequest} />
									<span className="sr-only">{label}</span>
								</div>
							))}
						</div>
					</div>
				</aside>
			</div>

			<GitActionDialog
				branch={branch}
				branches={BRANCHES}
				branchesLoading={false}
				commitMessage={commitMessage}
				deletions={8438}
				error={null}
				includeUnstaged={includeUnstaged}
				insertions={76_383}
				onBranchMenuOpenChange={() => undefined}
				onCommitMessageChange={setCommitMessage}
				onCreateBranch={async () => null}
				onIncludeUnstagedChange={setIncludeUnstaged}
				onOpenChange={setCommitOpen}
				onSelectBranch={setBranch}
				onSubmit={handleCommit}
				open={commitOpen}
				progress={commitProgress}
			/>
			<CreateGitHubRepositoryDialog
				name={repositoryName}
				onNameChange={setRepositoryName}
				onOpenChange={setRepositoryOpen}
				onSubmit={() => setRepositoryOpen(false)}
				onVisibilityChange={setVisibility}
				open={repositoryOpen}
				visibility={visibility}
			/>
			<PullRequestDialog
				baseBranch="main"
				branch={BRANCH}
				deletions={8438}
				description={pullRequestDescription}
				error={null}
				includeUnstaged={pullRequestIncludeUnstaged}
				insertions={76_383}
				onDescriptionChange={setPullRequestDescription}
				onIncludeUnstagedChange={setPullRequestIncludeUnstaged}
				onOpenChange={setPullRequestOpen}
				onSubmit={handlePullRequest}
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
	throw new Error("Git actions proof root is missing");
}

createRoot(root).render(<GitActionsProof />);
