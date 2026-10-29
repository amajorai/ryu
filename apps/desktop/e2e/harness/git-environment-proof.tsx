import { CloudUploadIcon, GitBranchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CreateGitHubRepositoryDialog } from "../../src/components/panels/GitActionDialogs.tsx";
import {
	CompareBranchLink,
	CreateLocalGitButton,
} from "../../src/components/panels/PinnedSummaryPanel.tsx";
import type { GitHubRepositoryVisibility } from "../../src/lib/api/pull-requests.ts";
import "../../src/index.css";

const COMPARE_URL =
	"https://github.com/amajorai/ryu/compare/main...feature%2Fcompare?expand=1";

function GitEnvironmentProof() {
	const [localGitReady, setLocalGitReady] = useState(false);
	const [repositoryDialogOpen, setRepositoryDialogOpen] = useState(false);
	const [repositoryName, setRepositoryName] = useState("ryu-workspace");
	const [visibility, setVisibility] =
		useState<GitHubRepositoryVisibility>("private");
	const [flowStatus, setFlowStatus] = useState(
		"This folder is local until you choose to publish it."
	);

	const handlePublish = (nextVisibility: GitHubRepositoryVisibility) => {
		setVisibility(nextVisibility);
		setRepositoryDialogOpen(false);
		setFlowStatus(
			`Ready to create ${repositoryName.trim()} as a ${nextVisibility} repository.`
		);
	};

	return (
		<main
			className="dark min-h-screen bg-background px-6 py-10 text-foreground sm:px-10"
			data-testid="git-environment-proof"
		>
			<div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
				<header className="max-w-2xl space-y-3">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Pinned Environment · Git workflow
					</p>
					<h1 className="font-semibold text-3xl tracking-tight sm:text-4xl">
						A clear path from local work to GitHub.
					</h1>
					<p className="text-muted-foreground text-sm leading-6">
						Git controls stay scoped to repositories. Ryu Work can initialize
						the folder first, then the Pull Requests app handles the provider
						publish step.
					</p>
				</header>

				<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,390px)_minmax(0,1fr)]">
					<section
						aria-label="Pinned Environment summary"
						className="rounded-3xl border border-white/10 bg-card p-4 shadow-2xl shadow-black/20"
						data-testid="environment-card"
					>
						<div className="flex items-center justify-between px-2 pb-3">
							<div>
								<p className="font-medium text-sm">Environment</p>
								<p className="mt-0.5 text-muted-foreground text-xs">Ryu Work</p>
							</div>
							<span className="rounded-full bg-success/10 px-2.5 py-1 font-medium text-success text-xs">
								{localGitReady ? "Git ready" : "Local folder"}
							</span>
						</div>
						<div className="overflow-hidden rounded-2xl border border-white/10 bg-background">
							<div className="flex items-center gap-3 border-white/10 border-b px-3.5 py-3">
								<span className="grid size-7 place-items-center rounded-lg bg-white/5 text-muted-foreground">
									<span className="text-sm">⌁</span>
								</span>
								<span className="min-w-0 flex-1 truncate text-sm">
									~/Projects/ryu-workspace
								</span>
							</div>
							{localGitReady ? (
								<>
									<div className="flex items-center gap-3 border-white/10 border-b px-3.5 py-3 text-sm">
										<HugeiconsIcon
											aria-hidden
											className="size-4 text-muted-foreground"
											icon={GitBranchIcon}
										/>
										<span className="min-w-0 flex-1 truncate">
											feature/compare
										</span>
										<span className="text-success text-xs">+16,604</span>
									</div>
									<div className="flex items-center gap-3 border-white/10 border-b px-3.5 py-3 text-sm">
										<span className="type-micro grid size-4 place-items-center rounded-full border border-white/50 text-muted-foreground">
											↳
										</span>
										<span className="min-w-0 flex-1 truncate">
											Commit or push
										</span>
										<span className="text-muted-foreground text-xs">local</span>
									</div>
									<div className="p-2">
										<CompareBranchLink href={COMPARE_URL} />
										<button
											className="mt-2 flex w-full items-center justify-center gap-2 rounded-md bg-primary px-2 py-2 font-medium text-primary-foreground text-xs transition hover:bg-primary/90"
											data-testid="create-github-repository"
											onClick={() => setRepositoryDialogOpen(true)}
											type="button"
										>
											<HugeiconsIcon
												aria-hidden
												className="size-3.5"
												icon={CloudUploadIcon}
											/>
											Create GitHub repository
										</button>
									</div>
								</>
							) : (
								<div className="space-y-3 p-3.5">
									<p className="text-muted-foreground text-xs leading-5">
										This folder is not a Git repository yet. Create local Git to
										unlock branch and publish controls.
									</p>
									<CreateLocalGitButton
										busy={false}
										onClick={() => {
											setLocalGitReady(true);
											setFlowStatus("Local Git is ready on main.");
										}}
									/>
								</div>
							)}
						</div>
					</section>

					<section className="rounded-3xl border border-white/10 bg-white/[0.03] p-6">
						<p className="font-medium text-sm">What the flow does</p>
						<div className="mt-5 grid gap-3 sm:grid-cols-3">
							{[
								["01", "Create local Git", "No files staged or published."],
								["02", "Choose visibility", "Name the GitHub repository."],
								[
									"03",
									"Commit and push",
									"Create origin and publish the branch.",
								],
							].map(([number, title, description]) => (
								<div
									className="rounded-2xl border border-white/10 bg-black/10 p-4"
									key={number}
								>
									<p className="font-mono text-muted-foreground text-xs">
										{number}
									</p>
									<p className="mt-3 font-medium text-sm">{title}</p>
									<p className="mt-1 text-muted-foreground text-xs leading-5">
										{description}
									</p>
								</div>
							))}
						</div>
						<div
							className="mt-5 rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-muted-foreground text-sm"
							data-testid="flow-status"
						>
							{flowStatus}
						</div>
						<p className="mt-4 text-muted-foreground text-xs leading-5">
							Compare branch opens GitHub's configured base against the current
							feature branch. The provider interaction is owned by Pull
							Requests; this preview does not call GitHub.
						</p>
					</section>
				</div>
			</div>
			<CreateGitHubRepositoryDialog
				name={repositoryName}
				onNameChange={setRepositoryName}
				onOpenChange={setRepositoryDialogOpen}
				onSubmit={handlePublish}
				onVisibilityChange={setVisibility}
				open={repositoryDialogOpen}
				visibility={visibility}
			/>
		</main>
	);
}

document.documentElement.classList.add("dark");

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<GitEnvironmentProof />);
}
