import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	TabSearchDialog,
	type TabSearchTab,
} from "../../src/components/layout/tab-search-dialog.tsx";
import "../../src/index.css";

const INITIAL_TABS: TabSearchTab[] = [
	{ id: "home", path: "/chat", title: "Project kickoff" },
	{
		id: "research",
		path: "/spaces/research",
		title: "Research notes",
	},
	{
		id: "operations",
		path: "/workflows/operations",
		title: "Operations board",
	},
	{
		id: "long-running",
		path: "/agents/long-running/edit",
		title: "Long-running customer research plan",
	},
];

function ProofStory() {
	const [activeTabId, setActiveTabId] = useState("research");
	const [tabs, setTabs] = useState(INITIAL_TABS);
	const [buttonVisible, setButtonVisible] = useState(true);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [activated, setActivated] = useState(false);
	const [closed, setClosed] = useState(false);
	const [hidden, setHidden] = useState(false);
	const [restored, setRestored] = useState(false);

	const activateTab = (id: string) => {
		setActiveTabId(id);
		setActivated(true);
	};
	const closeTab = (id: string) => {
		setTabs((current) => current.filter((tab) => tab.id !== id));
		setClosed(true);
	};
	const hideButton = () => {
		setButtonVisible(false);
		setHidden(true);
	};
	const proofPassed = activated && closed && hidden && restored;

	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<header className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							React verification artifact
						</p>
						<h1 className="mt-2 font-semibold text-3xl tracking-tight">
							Search open tabs
						</h1>
						<p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-6">
							The Chrome-style chevron opens every workspace tab, filters by
							title or route, switches on selection, and closes from the row
							action.
						</p>
					</div>
					<div
						className="rounded-full border border-success/30 bg-success/10 px-3 py-1.5 font-medium text-success text-xs"
						data-proof-status={proofPassed ? "pass" : "pending"}
						data-testid="proof-status"
					>
						{proofPassed
							? "PASS · full interaction"
							: "PENDING · use the control"}
					</div>
				</header>

				<section className="rounded-2xl border bg-card p-5 shadow-sm">
					<div className="flex flex-wrap items-center justify-between gap-4">
						<div>
							<p className="font-semibold text-sm">Desktop tab strip</p>
							<p className="mt-1 text-muted-foreground text-xs">
								The chevron sits beside +. Right-click it to hide, then restore
								it from Appearance settings.
							</p>
						</div>
						<div className="flex items-center gap-1 rounded-xl border bg-muted/40 p-1">
							<div className="flex h-8 items-center gap-1 rounded-full bg-muted px-3 font-medium text-xs">
								<span aria-hidden className="size-2 rounded-full bg-primary" />
								Current tab
							</div>
							<div className="flex h-8 items-center justify-center rounded-full border border-dashed px-2 text-muted-foreground text-xs">
								+
							</div>
							{buttonVisible ? (
								<TabSearchDialog
									activateTab={activateTab}
									activeTabId={activeTabId}
									closeTab={closeTab}
									floatingTabs
									onHide={hideButton}
									onOpenChange={setDialogOpen}
									tabs={tabs}
								/>
							) : (
								<button
									className="rounded-full bg-primary/10 px-3 py-1.5 font-medium text-primary text-xs"
									data-testid="restore-tab-search"
									onClick={() => {
										setButtonVisible(true);
										setRestored(true);
									}}
									type="button"
								>
									Restore chevron
								</button>
							)}
						</div>
					</div>
				</section>

				<section className="grid gap-4 rounded-2xl border bg-card p-5 sm:grid-cols-2">
					<div>
						<p className="text-muted-foreground text-xs uppercase tracking-wide">
							Active tab
						</p>
						<p className="mt-2 font-semibold text-lg" data-testid="active-tab">
							{tabs.find((tab) => tab.id === activeTabId)?.title ??
								"No open tab"}
						</p>
					</div>
					<div>
						<p className="text-muted-foreground text-xs uppercase tracking-wide">
							Control state
						</p>
						<p className="mt-2 text-sm" data-testid="control-state">
							{dialogOpen ? "Dialog open" : "Dialog closed"} · {tabs.length}{" "}
							tabs
						</p>
					</div>
				</section>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<ProofStory />);
}
