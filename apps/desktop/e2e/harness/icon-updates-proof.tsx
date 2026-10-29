import { UserMessage } from "@ryu/blocks/desktop/agent-elements/user-message.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PinnedSummaryToggleButton } from "../../src/components/panels/PinnedSummaryToggleButton.tsx";
import "../../src/index.css";

function Proof() {
	const [summaryOpen, setSummaryOpen] = useState(true);
	return (
		<TooltipProvider>
			<div className="flex h-screen flex-col bg-background text-foreground">
				<header className="flex items-center justify-between border-b px-6 py-3">
					<span className="font-medium text-sm">Ryu Assistant</span>
					<div className="flex items-center gap-1">
						<PinnedSummaryToggleButton
							onToggle={() => setSummaryOpen((current) => !current)}
							open={summaryOpen}
						/>
					</div>
				</header>
				<div className="mx-auto w-full max-w-4xl px-4 py-8">
					<UserMessage
						message={{
							id: "call-ended",
							role: "user",
							parts: [{ type: "text", text: "Call ended · 01:24" }],
						}}
					/>
				</div>
				{summaryOpen ? (
					<aside
						aria-label="Pinned summary"
						className="mr-6 ml-auto w-72 rounded-xl bg-muted p-4 text-sm"
					>
						<h2 className="font-medium">Pinned summary</h2>
						<p className="mt-2 text-muted-foreground">
							Call completed. Duration: 01:24.
						</p>
					</aside>
				) : null}
			</div>
		</TooltipProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
			<Proof />
		</ThemeProvider>
	);
}
