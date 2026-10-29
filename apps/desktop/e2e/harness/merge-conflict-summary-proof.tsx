import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { GitPullRequestSummary } from "../../src/components/panels/GitPullRequestSummary.tsx";
import { normalizeGitPullRequest } from "../../src/lib/api/pull-requests.ts";
import "../../src/index.css";

const pullRequest = normalizeGitPullRequest({
	baseRefName: "main",
	commentsCount: 3,
	headRefName: "codex/gateway-posture-doctor",
	headRefOid: "abc1234",
	isDraft: false,
	mergeStateStatus: "DIRTY",
	mergeable: "CONFLICTING",
	number: 42,
	repository: { nameWithOwner: "amajorai/ryu" },
	state: "OPEN",
	statusCheckRollup: [
		{
			bucket: "fail",
			name: "Gateway posture checks",
			workflowName: "CI",
		},
	],
	title: "Harden Gateway posture checks",
	url: "https://github.com/amajorai/ryu/pull/42",
});

function Story() {
	const [fixMessage, setFixMessage] = useState<string | null>(null);

	if (!pullRequest) {
		return null;
	}

	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="dark"
			enableSystem={false}
			forcedTheme="dark"
		>
			<main className="flex min-h-screen items-start justify-center bg-background px-6 py-12 text-foreground">
				<section className="w-full max-w-sm" data-testid="environment-preview">
					<p className="mb-2 px-1 font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-table-label)">
						Pinned summary
					</p>
					<div className="rounded-2xl border border-sidebar-border/80 bg-sidebar p-3 shadow-xl">
						<div className="mb-3 border-sidebar-border/70 border-b pb-3 font-semibold text-sm">
							Environment
						</div>
						<div className="mb-3 space-y-1.5 text-muted-foreground text-xs">
							<div className="flex items-center justify-between">
								<span>Changes</span>
								<span className="tabular-nums">+316,630 −30,643</span>
							</div>
							<div className="flex items-center justify-between">
								<span>Local</span>
								<span>codex/gateway-posture-doctor</span>
							</div>
							<div className="flex items-center justify-between">
								<span>Commit or push</span>
								<span>Ready</span>
							</div>
						</div>
						<div className="border-sidebar-border/70 border-t pt-3">
							<GitPullRequestSummary
								compact
								onFix={() => setFixMessage("CI report staged in composer")}
								onFixMergeConflicts={() =>
									setFixMessage("Merge conflict report staged in composer")
								}
								pullRequest={pullRequest}
							/>
						</div>
						{fixMessage ? (
							<div
								aria-live="polite"
								className="mt-3 rounded-lg bg-success/10 px-2.5 py-2 text-success text-xs dark:text-success"
								role="status"
							>
								{fixMessage}
							</div>
						) : null}
					</div>
				</section>
			</main>
		</ThemeProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
