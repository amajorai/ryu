import "@fontsource-variable/geist";
import "@fontsource-variable/inter";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { WorktreeHandoffControl } from "../../src/components/chat/WorktreeHandoffControl.tsx";
import "../../src/index.css";

function WorktreeHandoffProof() {
	const [branchName, setBranchName] = useState("codex/release-version-020");
	const [chatRunning, setChatRunning] = useState(true);
	const [handedOffBranch, setHandedOffBranch] = useState<string | null>(null);

	useEffect(() => {
		document.documentElement.classList.add("dark");
		return () => document.documentElement.classList.remove("dark");
	}, []);

	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-5xl grid-cols-[minmax(0,1fr)_20rem] gap-8">
				<section className="flex flex-col justify-center rounded-4xl border border-border/70 bg-card p-10 shadow-2xl">
					<p className="font-heading font-semibold text-primary text-xs uppercase tracking-(--tracking-section)">
						Ryu · Active chat
					</p>
					<h1 className="mt-3 font-heading font-semibold text-3xl tracking-tight">
						Keep the conversation, change the checkout
					</h1>
					<p className="mt-3 max-w-xl text-muted-foreground text-sm leading-6">
						The pinned summary can move a live chat into an isolated worktree
						without creating a second conversation.
					</p>
					<div className="mt-8 rounded-2xl border border-border/60 bg-background/60 p-4">
						<div className="flex items-center justify-between gap-4">
							<span className="font-medium text-sm">Current response</span>
							<span
								className="rounded-full bg-warning/10 px-2 py-1 text-warning text-xs"
								data-testid="chat-state"
							>
								{chatRunning ? "Running" : "Interrupted"}
							</span>
						</div>
						{handedOffBranch ? (
							<p
								className="mt-3 rounded-lg bg-success/10 px-3 py-2 text-sm text-success"
								data-testid="handoff-result"
							>
								Handed off to {handedOffBranch}
							</p>
						) : null}
					</div>
				</section>

				<aside
					className="self-center rounded-3xl border border-border/70 bg-card p-1 shadow-2xl"
					data-testid="pinned-summary"
				>
					<div className="border-border/70 border-b px-3 py-3">
						<p className="font-medium text-foreground text-xs">
							Pinned summary
						</p>
						<p className="type-caption mt-1 text-muted-foreground">
							What this chat is working in
						</p>
					</div>
					<section className="p-3" data-testid="environment-section">
						<div className="flex items-center justify-between gap-3">
							<p className="font-medium text-foreground text-xs">Environment</p>
							<span className="type-caption text-muted-foreground">
								Expanded
							</span>
						</div>
						<div className="mt-3 flex flex-col gap-1.5 text-muted-foreground text-xs">
							<div className="rounded-md bg-muted/50 px-2 py-1.5">
								Project · ryu
							</div>
							<div className="rounded-md bg-muted/50 px-2 py-1.5">
								Branch · main
							</div>
						</div>
						<div className="mt-3">
							<WorktreeHandoffControl
								branchName={branchName}
								chatRunning={chatRunning}
								onHandOff={(nextBranch) => {
									setBranchName(nextBranch);
									setHandedOffBranch(nextBranch);
								}}
								onInterrupt={() => setChatRunning(false)}
							/>
						</div>
					</section>
				</aside>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<WorktreeHandoffProof />);
}
