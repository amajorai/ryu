import "@fontsource-variable/inter";
import {
	ArrowUpRight01Icon,
	Folder03Icon,
	GitBranchIcon,
	LockIcon,
	Share08Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { isPullRequestBranch } from "../../src/lib/api/git.ts";
import { messageNeedsWorkspace } from "../../src/lib/workspace-intent.ts";
import "../../src/index.css";

const PROJECT_NAME = "ryu-closed";

function SimpleWorkspaceProof() {
	const [branch, setBranch] = useState("codex/simple-ui");
	const [draft, setDraft] = useState("");
	const [folder, setFolder] = useState<string | null>(null);
	const [promptOpen, setPromptOpen] = useState(false);
	const canCreatePullRequest = isPullRequestBranch(branch);

	useEffect(() => {
		document.documentElement.classList.add("dark");
		return () => document.documentElement.classList.remove("dark");
	}, []);

	const handleSend = () => {
		if (messageNeedsWorkspace(draft) && !folder) {
			setPromptOpen(true);
		}
	};

	return (
		<main className="min-h-screen bg-background px-8 py-10 text-foreground">
			<div className="mx-auto max-w-6xl">
				<header className="max-w-3xl">
					<p className="font-heading font-semibold text-primary text-xs uppercase tracking-(--tracking-section)">
						Ryu · Simple chat
					</p>
					<h1 className="mt-3 font-heading font-semibold text-4xl tracking-tight">
						Start talking first. Add a project when work needs one.
					</h1>
					<p className="mt-3 text-muted-foreground text-sm leading-6">
						Simple mode removes the upfront folder choice while keeping the
						safety prompt, per-chat environment context, and GitHub hand-off
						close at hand.
					</p>
				</header>

				<div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
					<section className="rounded-4xl border border-border/70 bg-card p-6 shadow-2xl">
						<div className="flex items-center justify-between gap-4">
							<div>
								<p className="font-medium text-sm">New conversation</p>
								<p className="mt-1 text-muted-foreground text-xs">
									No project selected yet
								</p>
							</div>
							<span className="rounded-full bg-primary/10 px-2.5 py-1 font-medium text-primary text-xs">
								Simple
							</span>
						</div>

						<div className="mt-8 rounded-3xl border border-border/70 bg-background/70 p-4">
							<textarea
								aria-label="Chat message"
								className="min-h-28 w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
								onChange={(event) => setDraft(event.target.value)}
								placeholder="What do you want to do?"
								value={draft}
							/>
							<div className="mt-4 flex items-center justify-between border-border/60 border-t pt-3">
								<span
									className="text-muted-foreground text-xs"
									data-testid="composer-footer"
								>
									Simple mode · no project picker
								</span>
								<button
									className="rounded-xl bg-primary px-4 py-2 font-medium text-primary-foreground text-xs transition hover:bg-primary/90"
									data-testid="send-message"
									onClick={handleSend}
									type="button"
								>
									Send
								</button>
							</div>
						</div>

						<div className="mt-4 rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3 text-xs">
							<p className="font-medium">Contextual project safety</p>
							<p className="mt-1 text-muted-foreground leading-5">
								Only a clear local-file request asks for a project; ordinary
								questions can stay folderless.
							</p>
						</div>
					</section>

					<section
						className="rounded-4xl border border-border/70 bg-card p-5 shadow-2xl"
						data-testid="environment-summary"
					>
						<div className="flex items-center justify-between gap-3">
							<p className="font-medium text-sm">Environment</p>
							<span className="text-muted-foreground text-xs">
								Pinned summary
							</span>
						</div>

						<div className="mt-4 space-y-1 rounded-2xl border border-border/60 bg-background/60 p-2">
							<div
								aria-label={`Project folder: ${folder ?? "No project folder"}`}
								className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-sm"
								data-testid="pinned-summary-folder"
							>
								<HugeiconsIcon
									aria-hidden
									className="size-4 text-muted-foreground"
									icon={Folder03Icon}
								/>
								<span className="min-w-0 flex-1 truncate">
									{folder ?? "No project folder"}
								</span>
								<span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
									<HugeiconsIcon
										aria-hidden
										className="size-3"
										icon={LockIcon}
									/>
									Read only
								</span>
							</div>
							<div className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-sm">
								<HugeiconsIcon
									aria-hidden
									className="size-4 text-muted-foreground"
									icon={GitBranchIcon}
								/>
								<span className="min-w-0 flex-1 truncate">{branch}</span>
								<span className="text-muted-foreground text-xs">Local</span>
							</div>
						</div>

						<div className="mt-4 flex items-center justify-between gap-3 text-muted-foreground text-xs">
							<span data-testid="files-changed">3 files changed</span>
							<span className="inline-flex items-center gap-1 tabular-nums">
								<HugeiconsIcon
									aria-hidden
									className="size-3"
									icon={ArrowUpRight01Icon}
								/>
								2 ahead
							</span>
						</div>

						<div className="mt-4 grid gap-2">
							<button
								className="w-full rounded-xl bg-primary px-3 py-2 font-medium text-primary-foreground text-xs"
								data-testid="commit-push"
								type="button"
							>
								Commit or push
							</button>
							{canCreatePullRequest && (
								<button
									className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-border/70 px-3 py-2 font-medium text-muted-foreground text-xs transition hover:bg-muted/60 hover:text-foreground"
									data-testid="create-pull-request"
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
						</div>

						<button
							className="mt-4 text-left text-muted-foreground text-xs underline underline-offset-4"
							data-testid="toggle-branch"
							onClick={() =>
								setBranch((current) =>
									current === "main" ? "codex/simple-ui" : "main"
								)
							}
							type="button"
						>
							{branch === "main"
								? "Switch to feature branch"
								: "Switch to main branch"}
						</button>
					</section>
				</div>

				<p className="mt-6 text-muted-foreground text-xs">
					{folder
						? `Current chat folder: ${PROJECT_NAME}`
						: "Folder is attached after the local-work prompt."}
				</p>
			</div>

			{promptOpen && (
				<div
					className="fixed inset-0 z-20 grid place-items-center bg-black/50 p-6"
					role="presentation"
				>
					<section
						aria-labelledby="workspace-prompt-title"
						className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-2xl"
						data-testid="workspace-required-dialog"
						role="dialog"
					>
						<h2
							className="font-heading font-semibold text-xl"
							id="workspace-prompt-title"
						>
							Choose a project to edit
						</h2>
						<p className="mt-2 text-muted-foreground text-sm leading-6">
							This request mentions local files or code. Pick a project once and
							Ryu will send it there; ordinary questions do not need a folder.
						</p>
						<button
							className="mt-6 flex w-full items-center justify-between rounded-2xl border border-border/70 bg-background/70 px-4 py-3 text-left text-sm transition hover:bg-muted"
							data-testid="choose-project"
							onClick={() => {
								setFolder(PROJECT_NAME);
								setPromptOpen(false);
							}}
							type="button"
						>
							<span className="inline-flex items-center gap-2">
								<HugeiconsIcon
									aria-hidden
									className="size-4"
									icon={Folder03Icon}
								/>
								{PROJECT_NAME}
							</span>
							<span className="text-muted-foreground text-xs">Choose</span>
						</button>
					</section>
				</div>
			)}
		</main>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Simple workspace proof root is missing");
}

createRoot(root).render(<SimpleWorkspaceProof />);
