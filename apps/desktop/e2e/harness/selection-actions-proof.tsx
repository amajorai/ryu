import {
	messageSelectableProps,
	SelectionQuoteToolbar,
} from "@ryu/blocks/desktop/agent-elements/quote.tsx";
import type {
	ContributedSelectionAction,
	SelectionActionContext,
} from "@ryu/blocks/desktop/agent-elements/types.ts";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const SIDE_CHAT_ACTIONS: ContributedSelectionAction[] = [
	{
		args: { dispatch: "side-chat.selection", intent: "ask" },
		id: "side-chats.ask-selection",
		kind: "button",
		label: "Ask in side chat",
		order: 100,
		plugin: "@ryu/side-chats",
	},
	{
		args: { dispatch: "side-chat.selection", intent: "explain" },
		id: "side-chats.explain-selection",
		kind: "button",
		label: "Explain",
		order: 110,
		plugin: "@ryu/side-chats",
	},
];

function SelectionActionsProof() {
	const transcriptRef = useRef<HTMLElement>(null);
	const [quote, setQuote] = useState("");
	const [selectionEvent, setSelectionEvent] = useState<{
		action: string;
		note?: string;
		text: string;
	} | null>(null);

	const handleSelectionAction = (
		action: ContributedSelectionAction,
		context: SelectionActionContext
	) => {
		setSelectionEvent({
			action: action.label,
			note: context.note,
			text: context.text,
		});
	};

	return (
		<main className="dark min-h-screen bg-background px-8 py-10 text-foreground">
			<div className="mx-auto max-w-3xl">
				<header className="mb-8 flex items-end justify-between gap-6">
					<div>
						<p className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							Ryu · selection bridge proof
						</p>
						<h1 className="font-semibold text-3xl tracking-tight">
							Ask from the conversation you’re reading
						</h1>
						<p className="mt-3 max-w-2xl text-muted-foreground leading-relaxed">
							Select the highlighted sentence. The shared quote toolbar keeps
							its built-in action and renders Side Chat’s contributed actions
							beside it.
						</p>
					</div>
					<span className="rounded-full border border-success/30 bg-success/10 px-3 py-1.5 font-medium text-success text-xs">
						Plugin contribution · enabled
					</span>
				</header>

				<section
					className="overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
					data-testid="selection-actions-proof"
				>
					<div className="border-border border-b px-6 py-4">
						<div className="flex items-center justify-between">
							<div>
								<p className="font-medium text-sm">Main chat</p>
								<p className="mt-1 text-muted-foreground text-xs">
									Active model · same context handoff
								</p>
							</div>
							<span className="type-caption rounded-md bg-muted px-2 py-1 font-mono text-muted-foreground">
								gpt-5 · ready
							</span>
						</div>
					</div>
					<article className="space-y-4 px-6 py-8" ref={transcriptRef}>
						<div className="flex gap-4">
							<div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground text-xs">
								You
							</div>
							<div className="max-w-xl rounded-2xl rounded-tl-sm bg-muted/60 px-4 py-3 text-sm leading-relaxed">
								We should keep this as a side question so the main thread stays
								focused.
							</div>
						</div>
						<div className="flex gap-4">
							<div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 font-medium text-primary text-xs">
								R
							</div>
							<div className="max-w-2xl text-sm leading-7">
								<p
									{...messageSelectableProps}
									className="rounded-md px-1 py-0.5 outline-none selection:bg-primary/30"
									data-testid="selection-copy"
								>
									A side chat uses the active main model and the visible
									conversation as context, while keeping tools and new turns out
									of the main chat.
								</p>
								<p className="mt-4 text-muted-foreground text-xs">
									Select a phrase to reveal the contributed actions.
								</p>
							</div>
						</div>
					</article>
				</section>

				<section className="mt-5 grid gap-3 sm:grid-cols-2">
					<div className="rounded-xl border border-border bg-card/60 p-4">
						<p className="font-medium text-sm">Selection payload</p>
						<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
							The host receives the plain selected text and routes it to the
							plugin or native Side Chat handler.
						</p>
						<code
							className="type-caption mt-3 block min-h-10 whitespace-pre-wrap rounded-md bg-muted/60 p-2 font-mono leading-relaxed"
							data-testid="selection-event"
						>
							{selectionEvent
								? [
										selectionEvent.action,
										selectionEvent.text,
										selectionEvent.note,
									]
										.filter(Boolean)
										.join("\n")
								: "No action yet"}
						</code>
					</div>
					<div className="rounded-xl border border-border bg-card/60 p-4">
						<p className="font-medium text-sm">Built-in quote handoff</p>
						<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
							The original Quote action remains available in the same segmented
							toolbar.
						</p>
						<code
							className="type-caption mt-3 block min-h-10 whitespace-pre-wrap rounded-md bg-muted/60 p-2 font-mono leading-relaxed"
							data-testid="quote-event"
						>
							{quote || "No quote yet"}
						</code>
					</div>
				</section>
			</div>
			<SelectionQuoteToolbar
				containerRef={transcriptRef}
				onContributedAction={handleSelectionAction}
				onQuote={(text, note) => setQuote(note ? `${text}\n${note}` : text)}
				selectionActions={SIDE_CHAT_ACTIONS}
			/>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<SelectionActionsProof />);
