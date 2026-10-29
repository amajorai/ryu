import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

interface ProofCase {
	action: string;
	description: string;
	icon: string;
	id: string;
	title: string;
}

const cases: ProofCase[] = [
	{
		action: "Clear search",
		description: "Try a different search term.",
		icon: "⌕",
		id: "search",
		title: "No results found",
	},
	{
		action: "Try again",
		description: "The catalog could not be loaded.",
		icon: "↻",
		id: "retry",
		title: "Couldn’t load the catalog",
	},
	{
		action: "Browse the Store",
		description: "Plugins and agents you install will appear here.",
		icon: "◇",
		id: "browse",
		title: "Nothing installed yet",
	},
	{
		action: "Write the first review",
		description: "Share what worked for you.",
		icon: "☆",
		id: "review",
		title: "No reviews yet",
	},
];

function ProofCard({
	caseItem,
	completed,
	onAction,
}: {
	caseItem: ProofCase;
	completed: boolean;
	onAction: (item: ProofCase) => void;
}) {
	return (
		<section
			className="rounded-xl border bg-card p-2 shadow-sm"
			data-testid={`empty-state-${caseItem.id}`}
		>
			<Empty className="min-h-64">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<span aria-hidden="true" className="text-xl">
							{caseItem.icon}
						</span>
					</EmptyMedia>
					<EmptyTitle>{caseItem.title}</EmptyTitle>
					<EmptyDescription>{caseItem.description}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button
						data-testid={`empty-state-cta-${caseItem.id}`}
						onClick={() => onAction(caseItem)}
						size="sm"
						variant={completed ? "secondary" : "default"}
					>
						{completed ? "Done" : caseItem.action}
					</Button>
				</EmptyContent>
			</Empty>
		</section>
	);
}

function EmptyStateCtaProof() {
	const [completed, setCompleted] = useState<Set<string>>(() => new Set());
	const [lastAction, setLastAction] = useState(
		"Click every CTA to complete the proof."
	);
	const allComplete = completed.size === cases.length;

	const handleAction = (item: ProofCase) => {
		setCompleted((previous) => new Set(previous).add(item.id));
		setLastAction(`${item.action} action fired for “${item.title}”.`);
	};

	return (
		<main className="min-h-screen bg-background px-6 py-8 text-foreground">
			<div className="mx-auto max-w-5xl">
				<div className="mb-6 flex flex-wrap items-end justify-between gap-4">
					<div>
						<p className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-widest">
							Ryu UI proof artifact
						</p>
						<h1 className="font-semibold text-2xl tracking-tight">
							Empty states have a next step
						</h1>
						<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
							Representative no-results, load-failure, first-use, and review
							states all expose an action through the shared Empty primitives.
						</p>
					</div>
					<output
						className="rounded-full border px-3 py-1.5 font-medium text-sm"
						data-proof-status={allComplete ? "pass" : "pending"}
						data-testid="empty-state-cta-proof-status"
					>
						{allComplete
							? "PASS · 4/4 actions fired"
							: `${completed.size}/4 actions fired`}
					</output>
				</div>

				<div className="grid gap-4 md:grid-cols-2">
					{cases.map((caseItem) => (
						<ProofCard
							caseItem={caseItem}
							completed={completed.has(caseItem.id)}
							key={caseItem.id}
							onAction={handleAction}
						/>
					))}
				</div>

				<p
					aria-live="polite"
					className="mt-5 text-muted-foreground text-sm"
					data-testid="empty-state-cta-last-action"
				>
					{lastAction}
				</p>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	const proofWindow =
		/* SAFETY: This private optional __emptyStateCtaProofRoot holder is authored only by this module, which stores the complete native createRoot result and reuses it on later evaluation. The view preserves the browser Window and does not describe an external payload. */ window as Window & {
			__emptyStateCtaProofRoot?: ReturnType<typeof createRoot>;
		};
	const appRoot = proofWindow.__emptyStateCtaProofRoot ?? createRoot(root);
	proofWindow.__emptyStateCtaProofRoot = appRoot;
	appRoot.render(<EmptyStateCtaProof />);
}
