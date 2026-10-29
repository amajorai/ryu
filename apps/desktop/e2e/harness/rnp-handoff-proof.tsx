import type {
	RnpResumeResultV0,
	RnpWorkspaceResumeResultV0,
} from "@ryuhq/protocol/continuity";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ContinueOnNodeDialog } from "../../src/components/chat/ContinueOnNodeDialog.tsx";
import type { Node } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const proofOrigin = window.location.origin;
const nodes: Node[] = [
	{
		name: "Laptop",
		url: `${proofOrigin}/source`,
		token: "source-token",
	},
	{
		name: "Studio node",
		url: `${proofOrigin}/destination`,
		token: "destination-token",
	},
];

function Story() {
	const [dialogOpen, setDialogOpen] = useState(true);
	const [completed, setCompleted] = useState<{
		node: Node;
		result: RnpResumeResultV0;
		workspace?: RnpWorkspaceResumeResultV0;
	} | null>(null);

	return (
		<main className="min-h-screen bg-background px-8 py-10 text-foreground">
			<div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-5xl items-center justify-center">
				<section className="w-full max-w-xl rounded-3xl border bg-card p-7 shadow-2xl">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Ryu node continuity
					</p>
					<h1 className="mt-3 font-semibold text-2xl tracking-tight">
						Research handoff
					</h1>
					<p className="mt-2 text-muted-foreground text-sm">
						Move the visible conversation from Laptop to Studio node without
						moving credentials, files, or hidden agent state.
					</p>

					{completed ? (
						<div
							className="mt-6 rounded-2xl border border-success/30 bg-success/10 p-5"
							data-testid="handoff-complete"
						>
							<p className="font-medium text-sm text-success">
								Conversation continued on {completed.node.name}
							</p>
							<p className="mt-2 text-muted-foreground text-sm">
								{completed.result.imported.messages} messages and{" "}
								{completed.result.imported.contextItems} context note imported.
							</p>
							{completed.workspace ? (
								<p
									className="mt-2 text-muted-foreground text-sm"
									data-testid="handoff-workspace"
								>
									Working tree on {completed.workspace.branch}
								</p>
							) : null}
						</div>
					) : null}

					<button
						className="mt-6 rounded-xl bg-primary px-4 py-2 font-medium text-primary-foreground text-sm"
						data-testid="open-handoff"
						onClick={() => setDialogOpen(true)}
						type="button"
					>
						Continue on another node
					</button>
				</section>
			</div>

			<ContinueOnNodeDialog
				conversationId="conversation-proof"
				conversationTitle="Research handoff"
				nodes={nodes}
				onCompleted={(node, result, workspace) =>
					setCompleted({ node, result, workspace })
				}
				onOpenChange={setDialogOpen}
				open={dialogOpen}
				sourceNode={nodes[0]}
				sourceUpdatedAt={1_777_000_000_000}
			/>
		</main>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("RNP proof root is missing");
}
createRoot(root).render(<Story />);
