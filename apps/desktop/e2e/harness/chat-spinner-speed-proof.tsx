import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { getChatTabBusySpeed } from "../../src/lib/chat-tab-busy-speed.ts";
import "../../src/index.css";

interface ProofCase {
	description: string;
	id: string;
	modeId: string | null;
	optionValues: Record<string, string>;
	phase: "submitted" | "streaming";
	title: string;
}

const PROOF_CASES: ProofCase[] = [
	{
		description: "Fast mode is selected while the reply is still thinking.",
		id: "fast-thinking",
		modeId: "fast",
		optionValues: {},
		phase: "submitted",
		title: "Fast mode · Thinking",
	},
	{
		description: "Without fast mode, thinking keeps the calm slow cadence.",
		id: "normal-thinking",
		modeId: null,
		optionValues: {},
		phase: "submitted",
		title: "Normal mode · Thinking",
	},
	{
		description: "Once content is streaming, working always returns to normal.",
		id: "fast-working",
		modeId: "fast",
		optionValues: {},
		phase: "streaming",
		title: "Fast mode · Working",
	},
];

function ProofRow({ proof }: { proof: ProofCase }) {
	const speed = useMemo(
		() => getChatTabBusySpeed(proof.phase, proof.modeId, proof.optionValues),
		[proof]
	);

	return (
		<li
			className="flex items-center gap-3 border-border/70 border-b px-4 py-3 last:border-b-0"
			data-phase={proof.phase}
			data-speed={speed}
			data-testid={proof.id}
		>
			<span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
				<Spinner
					aria-label={`${proof.title} spinner`}
					className="size-4"
					speed={speed}
				/>
			</span>
			<span className="min-w-0 flex-1">
				<span className="block font-medium text-foreground text-sm">
					{proof.title}
				</span>
				<span className="block truncate text-muted-foreground text-xs">
					{proof.description}
				</span>
			</span>
			<code className="rounded-md bg-muted px-2 py-1 font-mono text-foreground text-xs">
				{speed}
			</code>
		</li>
	);
}

function Story() {
	return (
		<main className="min-h-screen bg-background px-6 py-10 text-foreground">
			<div className="mx-auto grid max-w-4xl gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
				<section
					aria-label="Sidebar chat preview"
					className="overflow-hidden rounded-2xl border bg-card shadow-sm"
				>
					<div className="border-border/70 border-b px-4 py-4">
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							Sidebar chats
						</p>
						<h1 className="mt-1 font-semibold text-xl tracking-tight">
							Spinner speed proof
						</h1>
					</div>
					<ul aria-label="Spinner states">
						{PROOF_CASES.map((proof) => (
							<ProofRow key={proof.id} proof={proof} />
						))}
					</ul>
				</section>

				<section
					aria-label="Verified behavior"
					className="rounded-2xl border bg-card p-6 shadow-sm"
					data-testid="spinner-speed-proof"
				>
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Completed task proof
					</p>
					<h2 className="mt-1 font-semibold text-xl tracking-tight">
						Thinking reflects mode; working stays calm
					</h2>
					<p className="mt-3 text-muted-foreground text-sm leading-6">
						The sidebar uses the fast spinner only for fast-mode thinking. As
						soon as the response is working/streaming, it returns to the normal
						cadence.
					</p>
					<div className="mt-6 grid gap-3 sm:grid-cols-3">
						{PROOF_CASES.map((proof) => (
							<div
								className="rounded-xl border bg-background p-3"
								key={`${proof.id}-summary`}
							>
								<p className="font-medium text-muted-foreground text-xs">
									{proof.phase === "submitted" ? "Thinking" : "Working"}
								</p>
								<p className="mt-1 font-semibold text-lg">{getLabel(proof)}</p>
							</div>
						))}
					</div>
				</section>
			</div>
		</main>
	);
}

function getLabel(proof: ProofCase): string {
	return getChatTabBusySpeed(proof.phase, proof.modeId, proof.optionValues);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
