import { Chat01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TabDropdown } from "../../src/components/layout/tab-dropdown.tsx";
import type { TabSearchTab } from "../../src/components/layout/tab-search-dialog.tsx";
import {
	DEFAULT_TAB_DROPDOWN,
	TAB_DROPDOWN_KEY,
	useTabDropdown,
} from "../../src/hooks/useTabDropdown.ts";
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

const PROOF_RESET_KEY = "ryu:tab-dropdown-proof-reset";
if (sessionStorage.getItem(PROOF_RESET_KEY) !== "true") {
	localStorage.removeItem(TAB_DROPDOWN_KEY);
	sessionStorage.setItem(PROOF_RESET_KEY, "true");
}

function ProofStory() {
	const [activeTabId, setActiveTabId] = useState("research");
	const [tabs, setTabs] = useState(INITIAL_TABS);
	const [tabDropdown, setTabDropdown] = useTabDropdown();
	const [activated, setActivated] = useState(false);
	const [closed, setClosed] = useState(false);
	const activeTab = tabs.find((tab) => tab.id === activeTabId);
	const proofPassed =
		DEFAULT_TAB_DROPDOWN &&
		tabDropdown &&
		activated &&
		closed &&
		tabs.length === 3;

	const activateTab = (id: string) => {
		setActiveTabId(id);
		setActivated(true);
	};
	const closeTab = (id: string) => {
		setTabs((current) => current.filter((tab) => tab.id !== id));
		setClosed(true);
	};

	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto flex max-w-4xl flex-col gap-6">
				<header className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							Desktop UI verification artifact
						</p>
						<h1 className="mt-2 font-semibold text-3xl tracking-tight">
							Dropdown tab switcher
						</h1>
						<p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-6">
							A default-on, searchable replacement for the title-bar tab strip.
							The trigger is borderless and transparent until hover, then the
							dropdown searches every open workspace tab.
						</p>
					</div>
					<div
						className={
							proofPassed
								? "rounded-full border border-success/30 bg-success/10 px-3 py-1.5 font-medium text-success text-xs"
								: "rounded-full border border-warning/30 bg-warning/10 px-3 py-1.5 font-medium text-warning text-xs"
						}
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
							<p className="font-semibold text-sm">
								Settings → Appearance → Interface
							</p>
							<p className="mt-1 text-muted-foreground text-xs">
								Show tabs as a dropdown is on by default.
							</p>
						</div>
						<button
							aria-checked={tabDropdown}
							className="flex items-center gap-3 rounded-full border border-border px-3 py-2 font-medium text-sm transition-colors hover:bg-muted"
							data-testid="tab-dropdown-setting"
							onClick={() => setTabDropdown(!tabDropdown)}
							role="switch"
							type="button"
						>
							<span
								aria-hidden
								className={`relative h-5 w-9 rounded-full p-0.5 transition-colors ${tabDropdown ? "bg-primary" : "bg-muted-foreground/40"}`}
							>
								<span
									className={`block size-4 rounded-full bg-background shadow-sm transition-transform ${tabDropdown ? "translate-x-4" : "translate-x-0"}`}
								/>
							</span>
							Show tabs as a dropdown {tabDropdown ? "On" : "Off"}
						</button>
					</div>
				</section>

				<section className="rounded-2xl border bg-card p-5 shadow-sm">
					<div className="mb-4 flex items-center justify-between gap-4">
						<div>
							<p className="font-semibold text-sm">Title-bar tab control</p>
							<p className="mt-1 text-muted-foreground text-xs">
								Search, switch, and close open tabs from one compact dropdown.
							</p>
						</div>
						<code className="rounded-md bg-muted px-2 py-1 text-muted-foreground text-xs">
							{tabDropdown ? "dropdown" : "full strip"}
						</code>
					</div>
					<div className="flex min-h-14 items-center gap-2 rounded-xl border bg-muted/40 px-3">
						{tabDropdown ? (
							<TabDropdown
								activateTab={activateTab}
								activeIcon={
									<HugeiconsIcon className="size-4" icon={Folder01Icon} />
								}
								activeTabId={activeTabId}
								closeTab={closeTab}
								tabs={tabs}
							/>
						) : (
							<div
								className="flex h-8 items-center gap-2 rounded-full bg-muted px-3 font-medium text-xs"
								data-testid="full-tab-strip-fallback"
							>
								<HugeiconsIcon className="size-3.5" icon={Chat01Icon} />
								Full tab strip
							</div>
						)}
					</div>
				</section>

				<section className="grid gap-4 rounded-2xl border bg-card p-5 sm:grid-cols-2">
					<div>
						<p className="text-muted-foreground text-xs uppercase tracking-wide">
							Active tab
						</p>
						<p className="mt-2 font-semibold text-lg" data-testid="active-tab">
							{activeTab?.title ?? "No open tab"}
						</p>
					</div>
					<div>
						<p className="text-muted-foreground text-xs uppercase tracking-wide">
							Control state
						</p>
						<p className="mt-2 text-sm" data-testid="control-state">
							{tabDropdown ? "Dropdown mode enabled" : "Full strip shown"} ·{" "}
							{tabs.length} tabs
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
