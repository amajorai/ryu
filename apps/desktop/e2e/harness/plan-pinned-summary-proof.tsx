import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type CSSProperties, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArtifactRenderer } from "../../src/components/chat/ArtifactRenderer.tsx";
import { CoworkContextPanel } from "../../src/components/panels/CoworkContextPanel.tsx";
import type { Artifact } from "../../src/lib/artifacts.ts";
import { extractPlans, planArtifact } from "../../src/lib/plan-artifacts.ts";
import "../../src/index.css";

const PLAN_MESSAGES = [
	{
		id: "acp-plan-message",
		role: "assistant",
		parts: [
			{
				type: "tool-TodoWrite",
				state: "output-available",
				input: {
					todos: [
						{ content: "Inspect the pinned summary", status: "completed" },
						{ content: "Add the Plans section", status: "in_progress" },
						{ content: "Verify opening the artifact", status: "pending" },
					],
				},
				toolCallId: "acp-plan-call",
			},
		],
	},
	{
		id: "pi-plan-message",
		role: "assistant",
		parts: [
			{
				type: "tool-PlanWrite",
				state: "output-available",
				input: {
					plan: {
						title: "Persist plans to Artifacts",
						summary:
							"Save every ACP and Pi plan snapshot as a markdown document in the Artifacts Space.",
					},
				},
				toolCallId: "pi-plan-call",
			},
		],
	},
];

const PLAN_ARTIFACTS = extractPlans(PLAN_MESSAGES).map((plan, index) =>
	planArtifact(plan, {
		documentId: `document-${index + 1}`,
		spaceId: "artifacts-space",
	})
);

const queryClient = new QueryClient();

function Story() {
	const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(
		null
	);

	const surfaceStyle: CSSProperties & { "--proof-accent": string } = {
		"--proof-accent": "var(--primary)",
	};

	return (
		<div
			className="flex h-screen flex-col bg-background text-foreground"
			style={surfaceStyle}
		>
			<header className="flex shrink-0 items-center justify-between border-border/60 border-b px-6 py-4">
				<div>
					<p className="font-medium text-sm">Pinned summary · Plans proof</p>
					<p className="text-muted-foreground text-xs">
						ACP and Pi plans are saved in Artifacts and open as markdown.
					</p>
				</div>
				<span className="rounded-full bg-muted px-2 py-1 text-muted-foreground text-xs">
					{PLAN_ARTIFACTS.length} saved plans
				</span>
			</header>

			<main className="grid min-h-0 flex-1 grid-cols-[minmax(280px,360px)_minmax(0,1fr)] gap-4 p-4">
				<aside
					aria-label="Pinned summary"
					className="min-h-0 overflow-y-auto"
					data-testid="pinned-summary-proof"
				>
					<CoworkContextPanel
						messages={PLAN_MESSAGES}
						onOpenArtifact={setSelectedArtifact}
						planArtifacts={PLAN_ARTIFACTS}
						runId={null}
						target={{ url: "", token: null }}
						variant="summary"
					/>
				</aside>

				<section
					aria-label="Opened plan artifact"
					className="min-h-0 overflow-hidden rounded-2xl border border-border/70 bg-card"
					data-testid="plan-artifact-viewer"
				>
					{selectedArtifact ? (
						<ArtifactRenderer artifact={selectedArtifact} />
					) : (
						<div
							className="flex h-full items-center justify-center p-8 text-center text-muted-foreground text-sm"
							data-testid="plan-artifact-empty"
						>
							Choose a plan in the pinned summary to open its artifact.
						</div>
					)}
				</section>
			</main>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<Story />
		</QueryClientProvider>
	);
}
