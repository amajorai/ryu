import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentExecutionPolicyPanel } from "../../src/components/agents/AgentExecutionPolicyPanel.tsx";
import type {
	AgentLifecycleStatus,
	AgentSafetyProfile,
} from "../../src/lib/api/agents.ts";
import "../../src/index.css";

function AgentLifecycleSafetyProof() {
	const [lifecycleStatus, setLifecycleStatus] =
		useState<AgentLifecycleStatus>("trial");
	const [safetyProfile, setSafetyProfile] =
		useState<AgentSafetyProfile>("autonomous");

	return (
		<main className="min-h-screen bg-background px-6 py-12 text-foreground sm:px-10">
			<div className="mx-auto max-w-3xl">
				<header className="mb-8">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-section">
						Production component proof
					</p>
					<h1 className="mt-2 font-semibold text-4xl tracking-tight">
						Agent lifecycle &amp; safety
					</h1>
					<p className="mt-3 max-w-2xl text-muted-foreground">
						A new agent can be tested safely before it is allowed into
						automation or background execution.
					</p>
				</header>

				<section
					className="rounded-3xl border bg-card p-6 shadow-sm"
					data-testid="lifecycle-safety-proof"
				>
					<AgentExecutionPolicyPanel
						disabled={false}
						isNew
						lifecycleStatus={lifecycleStatus}
						onLifecycleStatusChange={setLifecycleStatus}
						onSafetyProfileChange={setSafetyProfile}
						safetyProfile={safetyProfile}
					/>
				</section>

				<div className="mt-6 grid gap-3 sm:grid-cols-2">
					<div className="rounded-2xl border bg-card/60 p-4">
						<p className="text-muted-foreground text-xs uppercase tracking-wide">
							Saved profile
						</p>
						<p className="mt-1 font-medium" data-testid="saved-profile">
							{safetyProfile === "autonomous"
								? "Autonomous"
								: safetyProfile === "approval_required"
									? "Approval required"
									: "Read-only"}
						</p>
					</div>
					<div className="rounded-2xl border bg-card/60 p-4">
						<p className="text-muted-foreground text-xs uppercase tracking-wide">
							Effective in Trial
						</p>
						<p className="mt-1 font-medium" data-testid="effective-profile">
							{lifecycleStatus === "trial"
								? "Read-only"
								: "Lifecycle controlled"}
						</p>
					</div>
				</div>
			</div>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(
	<AgentLifecycleSafetyProof />
);
