import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import "../../src/index.css";

const STORAGE_KEY = "ryu.tabs.layout.proof";

const TAB_DEFINITIONS = [
	{ label: "Overview", value: "overview" },
	{ label: "Activity", value: "activity" },
	{ label: "Analytics", value: "analytics" },
	{ label: "Team", value: "team" },
	{ label: "Billing", value: "billing" },
	{ label: "Integrations", value: "integrations" },
	{ label: "Reports", value: "reports" },
] as const;

const OVERFLOW_TAB_DEFINITIONS = [
	{ label: "Overview", value: "overflow-overview" },
	{ label: "Activity", value: "overflow-activity" },
	{ label: "Analytics", value: "overflow-analytics" },
	{ label: "Team", value: "overflow-team" },
	{ label: "Billing", value: "overflow-billing" },
	{ label: "Integrations", value: "overflow-integrations" },
	{ label: "Reports", value: "overflow-reports" },
] as const;

interface LayoutSnapshot {
	activeKey: string | null;
	contextMenuOpen: boolean;
	dragIndicator: boolean;
	hidden: string[];
	menuOpen: boolean;
	moreVisible: boolean;
	order: string[];
	promotedActive: boolean;
	visibleCount: number;
}

function isVisible(element: HTMLElement | null) {
	if (!element) {
		return false;
	}
	const style = getComputedStyle(element);
	return style.display !== "none" && style.visibility !== "hidden";
}

function readPersistedLayout() {
	try {
		const value = localStorage.getItem(STORAGE_KEY);
		if (!value) {
			return { hidden: [], order: [] };
		}
		const parsed = z
			.object({
				hidden: z.array(z.json()).catch([]),
				order: z.array(z.json()).catch([]),
			})
			.parse(JSON.parse(value));
		return {
			hidden: Array.isArray(parsed.hidden)
				? parsed.hidden.filter((key): key is string => isNativeText(key))
				: [],
			order: Array.isArray(parsed.order)
				? parsed.order.filter((key): key is string => isNativeText(key))
				: [],
		};
	} catch {
		return { hidden: [], order: [] };
	}
}

function readSnapshot(): LayoutSnapshot {
	const moreTrigger = document.querySelector<HTMLElement>(
		"[data-tabs-more-trigger]"
	);
	const activeTrigger = document.querySelector<HTMLElement>(
		'[data-tabs-managed-trigger][aria-selected="true"]'
	);
	const persisted = readPersistedLayout();
	return {
		activeKey: activeTrigger?.dataset.tabsManagedKey ?? null,
		contextMenuOpen: isVisible(
			document.querySelector<HTMLElement>('[data-slot="context-menu-content"]')
		),
		dragIndicator:
			document.querySelector("[data-tabs-drop-indicator]") !== null,
		hidden: persisted.hidden,
		menuOpen: isVisible(
			document.querySelector<HTMLElement>('[data-slot="command-input"]')
		),
		moreVisible: moreTrigger?.dataset.tabsMoreVisible === "true",
		order: persisted.order,
		promotedActive: activeTrigger?.dataset.tabsPromoted === "true",
		visibleCount: document.querySelectorAll("[data-tabs-managed-trigger]")
			.length,
	};
}

function useLayoutSnapshot() {
	const [snapshot, setSnapshot] = useState<LayoutSnapshot>(() =>
		readSnapshot()
	);

	useEffect(() => {
		const update = () => setSnapshot(readSnapshot());
		const observer = new MutationObserver(update);
		observer.observe(document.body, { childList: true, subtree: true });
		const timer = window.setInterval(update, 150);
		return () => {
			observer.disconnect();
			window.clearInterval(timer);
		};
	}, []);

	return snapshot;
}

function ProofStory() {
	const [activeTab, setActiveTab] = useState<string>(TAB_DEFINITIONS[0].value);
	const snapshot = useLayoutSnapshot();
	const statuses = [
		{
			label: "Responsive overflow",
			pass: snapshot.moreVisible,
			detail: snapshot.moreVisible
				? "More trigger is visible"
				: "Waiting for fit check",
		},
		{
			label: "Searchable all-tabs menu",
			pass: snapshot.menuOpen,
			detail: snapshot.menuOpen
				? "Command search is open"
				: "Open More to inspect",
		},
		{
			label: "Context-menu reuse",
			pass: snapshot.contextMenuOpen,
			detail: snapshot.contextMenuOpen
				? "Same menu is open on a tab"
				: "Right-click a tab",
		},
		{
			label: "Inline drop indicator",
			pass: snapshot.dragIndicator,
			detail: snapshot.dragIndicator
				? "Drop position is marked"
				: "Drag a visible tab",
		},
		{
			label: "Active hidden-tab promotion",
			pass: snapshot.promotedActive,
			detail: snapshot.promotedActive
				? "Active hidden tab is occupying the last slot"
				: "Select a hidden tab from More",
		},
	];

	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto flex max-w-4xl flex-col gap-6">
				<header className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
							React verification artifact
						</p>
						<h1 className="font-semibold text-2xl">Managed tab layout</h1>
						<p className="mt-1 max-w-xl text-muted-foreground text-sm">
							Resize the shell, open More, search every tab, drag a visible tab,
							right-click a tab, and use the eye controls. Preferences persist
							in localStorage under the component-level storage key.
						</p>
					</div>
					<div className="rounded-full border px-3 py-1 font-medium text-xs">
						{snapshot.visibleCount} visible / {TAB_DEFINITIONS.length} total
					</div>
				</header>

				<section className="rounded-xl border bg-card p-5 shadow-sm">
					<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
						<div>
							<h2 className="font-semibold">Constrained workspace strip</h2>
							<p className="text-muted-foreground text-xs">
								The 520px shell forces overflow without allowing a second line.
							</p>
						</div>
						<code className="rounded-md bg-muted px-2 py-1 text-muted-foreground text-xs">
							{activeTab}
						</code>
					</div>

					<div className="w-[520px] max-w-full" data-testid="tab-shell">
						<Tabs
							className="w-full"
							onValueChange={(value) => setActiveTab(String(value))}
							value={activeTab}
						>
							<TabsList
								aria-label="Workspace sections"
								className="w-full justify-start"
								storageKey={STORAGE_KEY}
								variant="pills"
							>
								{TAB_DEFINITIONS.map((tab) => (
									<TabsTrigger key={tab.value} value={tab.value}>
										{tab.label}
									</TabsTrigger>
								))}
							</TabsList>
							{TAB_DEFINITIONS.map((tab) => (
								<TabsContent
									appearance="layout-proof"
									className="mt-4"
									key={tab.value}
									value={tab.value}
								>
									<strong>{tab.label}</strong> content is active.
								</TabsContent>
							))}
						</Tabs>
					</div>
				</section>

				<section
					className="rounded-xl border bg-card p-5 shadow-sm"
					data-testid="overflow-controls-proof"
				>
					<div className="mb-4">
						<h2 className="font-semibold">Component-level overflow strip</h2>
						<p className="mt-1 text-muted-foreground text-xs">
							With layout management disabled, the shared list keeps every tab
							in a one-line scroll strip with edge fades and directional paging
							arrows.
						</p>
					</div>

					<div className="w-[360px] max-w-full">
						<Tabs defaultValue={OVERFLOW_TAB_DEFINITIONS[0].value}>
							<TabsList
								aria-label="Overflow sections"
								className="w-full justify-start"
								data-testid="overflow-tabs-list"
								manageLayout={false}
								variant="pills"
							>
								{OVERFLOW_TAB_DEFINITIONS.map((tab) => (
									<TabsTrigger key={tab.value} value={tab.value}>
										{tab.label}
									</TabsTrigger>
								))}
							</TabsList>
							<TabsContent
								appearance="layout-proof"
								className="mt-4"
								value={OVERFLOW_TAB_DEFINITIONS[0].value}
							>
								<strong>Overview</strong> content is active.
							</TabsContent>
						</Tabs>
					</div>
				</section>

				<section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{statuses.map((status) => (
						<article
							className="rounded-xl border bg-card p-4"
							data-status={status.pass ? "pass" : "pending"}
							key={status.label}
						>
							<div className="flex items-center justify-between gap-2">
								<h2 className="font-medium text-sm">{status.label}</h2>
								<span className="font-semibold text-xs">
									{status.pass ? "PASS" : "PENDING"}
								</span>
							</div>
							<p className="mt-2 text-muted-foreground text-xs">
								{status.detail}
							</p>
						</article>
					))}
				</section>

				<dl className="grid gap-2 rounded-xl border bg-card p-4 text-sm sm:grid-cols-3">
					<div>
						<dt className="text-muted-foreground">Active key</dt>
						<dd data-testid="active-key">{snapshot.activeKey ?? "none"}</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">Hidden keys</dt>
						<dd data-testid="hidden-keys">
							{snapshot.hidden.length > 0 ? snapshot.hidden.join(", ") : "none"}
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">Stored order</dt>
						<dd className="truncate" data-testid="stored-order">
							{snapshot.order.length > 0 ? snapshot.order.join(" → ") : "none"}
						</dd>
					</div>
				</dl>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<ProofStory />);
}
