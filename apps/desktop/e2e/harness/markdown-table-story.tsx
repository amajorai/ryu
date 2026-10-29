// Standalone browser story for the REAL shared Markdown renderer. The table is
// intentionally wider than the chat column so the inline overflow and the
// hover-to-expand affordance are both visible in a real layout.

import { ChatDisplayPrefsProvider } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import { createRoot } from "react-dom/client";
import { Markdown } from "../../components/agent-elements/markdown.tsx";
import "../../src/index.css";

const CONTENT = `## Release readiness

The compact view keeps the chat readable. A soft edge fade shows when more columns are available; hover the table and open it when you need the full-width view.

| Workstream | Owner | Status | Q1 | Q2 | Q3 | Q4 | Notes |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Core | Platform | Ready | 98% | 99% | 99% | 100% | Stable across local and remote nodes |
| Desktop | J. Wei | In review | 84% | 91% | 96% | 98% | Context menus and dense chat surfaces |
| Gateway | Security | Ready | 76% | 88% | 94% | 97% | Protective defaults remain human-controlled |
| Marketplace | Apps | Shipping | 65% | 79% | 89% | 95% | App-owned surfaces use shared contracts |
| Docs | Fumadocs | Updating | 72% | 86% | 93% | 99% | Public pages mirror user-facing behavior |
| Quality | QA | In progress | 61% | 77% | 90% | 96% | Browser proofs cover the interaction seams |`;

function Story() {
	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto max-w-3xl space-y-4">
				<div>
					<p className="font-medium text-muted-foreground text-sm uppercase tracking-wide">
						Chat proof
					</p>
					<h1 className="mt-1 font-semibold text-2xl">
						Markdown table expansion
					</h1>
				</div>
				<div className="max-w-[560px] rounded-2xl border border-border/60 bg-card/50 p-5 shadow-sm">
					<ChatDisplayPrefsProvider value={{}}>
						<Markdown content={CONTENT} />
					</ChatDisplayPrefsProvider>
				</div>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
