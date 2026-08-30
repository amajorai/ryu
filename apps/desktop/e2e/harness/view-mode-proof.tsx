import { Target01Icon, WorkflowCircle06Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	LibraryCard,
	LibraryGrid,
	type LibraryViewMode,
} from "@ryu/blocks/desktop/library";
import { type ViewMode, ViewToggle } from "@ryu/blocks/desktop/view-toggle";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import {
	StoreCardGrid,
	StoreViewModeProvider,
} from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { Badge } from "@ryu/ui/components/badge";
import { BookCard } from "@ryu/ui/components/book-card";
import { ProjectFolder } from "@ryu/ui/components/project-folder";
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentBadgeCard } from "../../src/components/agents/AgentBadgeCard";
import { useStoreViewMode } from "../../src/hooks/useStoreViewMode";
import { useTabViewMode } from "../../src/hooks/useTabViewMode";
import "../../src/index.css";

const LIBRARY_TABS = [
	{ label: "Agents", value: "agents" },
	{ label: "Spaces", value: "spaces" },
	{ label: "Skills", value: "skills" },
	{ label: "Workflows", value: "workflows" },
] as const;

const STORE_TABS = [
	{ label: "Agents", value: "agents" },
	{ label: "Skills", value: "skills" },
	{ label: "Plugins", value: "plugins" },
] as const;

const LIBRARY_VIEW_MODES: readonly LibraryViewMode[] = [
	"grid",
	"list",
	"showcase",
	"graph",
];

const SAMPLE_AGENTS = [
	{ id: "atlas", name: "Atlas", role: "Research partner" },
	{ id: "mira", name: "Mira", role: "Writing partner" },
];

const SAMPLE_LISTINGS = [
	{ description: "A focused research assistant.", id: "atlas", name: "Atlas" },
	{ description: "A writing assistant for teams.", id: "mira", name: "Mira" },
];

function TabButtons({
	active,
	onSelect,
	tabs,
}: {
	active: string;
	onSelect: (value: string) => void;
	tabs: readonly { label: string; value: string }[];
}) {
	return (
		<div className="flex flex-wrap gap-1" role="tablist">
			{tabs.map((tab) => (
				<button
					aria-selected={active === tab.value}
					className={`rounded-md px-2.5 py-1.5 font-medium text-xs transition-colors ${active === tab.value ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
					data-testid={`tab-${tab.value}`}
					key={tab.value}
					onClick={() => onSelect(tab.value)}
					role="tab"
					type="button"
				>
					{tab.label}
				</button>
			))}
		</div>
	);
}

function ShowcaseAgent({ id, name, role }: (typeof SAMPLE_AGENTS)[number]) {
	return (
		<AgentBadgeCard
			action={<Badge variant="outline">Installed</Badge>}
			employeeId={id}
			logo={
				<span className="flex size-20 items-center justify-center rounded-full bg-background/70 font-semibold text-foreground text-xl">
					{name.slice(0, 1)}
				</span>
			}
			name={name}
			onOpen={() => undefined}
			role={role}
		/>
	);
}

function LibraryContent({ tab, view }: { tab: string; view: LibraryViewMode }) {
	if (view === "showcase" && tab === "agents") {
		return (
			<div
				className="grid grid-cols-1 gap-3 sm:grid-cols-2"
				data-testid="library-showcase"
			>
				{SAMPLE_AGENTS.map((agent) => (
					<ShowcaseAgent {...agent} key={agent.id} />
				))}
			</div>
		);
	}
	if (view === "showcase" && tab === "spaces") {
		return (
			<div data-testid="library-showcase">
				<ProjectFolder
					count={3}
					description="A small collection of project notes."
					itemLabel="document"
					previews={[
						{
							content: <div className="h-20 bg-sky-100 dark:bg-sky-950" />,
							id: "brief",
						},
						{
							content: <div className="h-20 bg-amber-100 dark:bg-amber-950" />,
							id: "notes",
						},
					]}
					title="Product notes"
				/>
			</div>
		);
	}
	if (view === "showcase" && tab === "skills") {
		return (
			<div className="flex flex-wrap gap-6" data-testid="library-showcase">
				{["Research", "Writing"].map((title) => (
					<BookCard
						coverArt={
							<div className="flex h-full items-center justify-center bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
								<HugeiconsIcon
									className="size-10"
									icon={WorkflowCircle06Icon}
								/>
							</div>
						}
						footer="Installed skill"
						key={title}
						title={title}
					/>
				))}
			</div>
		);
	}

	const standardView: ViewMode = view === "list" ? "list" : "grid";
	return (
		<LibraryGrid columns={2} view={standardView}>
			{SAMPLE_AGENTS.map((agent) => (
				<LibraryCard
					item={{
						favorited: false,
						icon: Target01Icon,
						key: agent.id,
						name: agent.name,
						subtitle: agent.role,
					}}
					key={agent.id}
					onOpen={() => undefined}
					onToggleFavorite={() => undefined}
					view={standardView}
				/>
			))}
		</LibraryGrid>
	);
}

function LibraryPanel() {
	const [tab, setTab] = useState("agents");
	const [view, setView] = useTabViewMode({
		defaultMode:
			tab === "agents" ||
			tab === "spaces" ||
			tab === "skills" ||
			tab === "workflows"
				? "showcase"
				: "grid",
		storageKey: "ryu:library-view",
		tabKey: tab,
		validModes: LIBRARY_VIEW_MODES,
	});
	const showcaseSupported = [
		"agents",
		"spaces",
		"skills",
		"workflows",
	].includes(tab);
	const handleViewChange = useCallback(
		(next: LibraryViewMode) => setView(next),
		[setView]
	);

	return (
		<section
			className="flex min-h-[30rem] min-w-0 flex-1 flex-col rounded-2xl border bg-card p-5 shadow-sm"
			data-testid="library-panel"
		>
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<p className="font-semibold text-lg">Library</p>
					<p className="mt-1 text-muted-foreground text-sm">
						Per-tab collection views
					</p>
				</div>
				<div data-testid="library-view-control">
					<ViewToggle
						onChange={handleViewChange}
						showShowcase={showcaseSupported}
						value={view === "graph" ? "grid" : view}
					/>
				</div>
			</div>
			<div className="mt-5 border-b pb-3">
				<TabButtons active={tab} onSelect={setTab} tabs={LIBRARY_TABS} />
			</div>
			<div className="min-h-0 flex-1 overflow-auto pt-5">
				<LibraryContent tab={tab} view={view} />
			</div>
		</section>
	);
}

function StoreContent({ view }: { view: ViewMode }) {
	if (view === "showcase") {
		return (
			<StoreCardGrid>
				{SAMPLE_AGENTS.map((agent) => (
					<ShowcaseAgent {...agent} key={agent.id} />
				))}
			</StoreCardGrid>
		);
	}
	return (
		<StoreCardGrid>
			{SAMPLE_LISTINGS.map((listing) => (
				<StoreCatalogCard
					description={listing.description}
					key={listing.id}
					name={listing.name}
					onClick={() => undefined}
					seedId={listing.id}
				/>
			))}
		</StoreCardGrid>
	);
}

function StorePanel() {
	const [tab, setTab] = useState("agents");
	const [storedView, setView] = useStoreViewMode(
		tab,
		tab === "agents" ? "showcase" : "grid"
	);
	const view =
		tab === "agents"
			? storedView
			: storedView === "showcase"
				? "grid"
				: storedView;

	return (
		<StoreViewModeProvider mode={view}>
			<section
				className="flex min-h-[30rem] min-w-0 flex-1 flex-col rounded-2xl border bg-card p-5 shadow-sm"
				data-testid="store-panel"
			>
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<p className="font-semibold text-lg">Marketplace</p>
						<p className="mt-1 text-muted-foreground text-sm">
							Per-tab catalog views
						</p>
					</div>
					<div data-testid="store-view-control">
						<ViewToggle
							onChange={setView}
							showShowcase={tab === "agents"}
							value={view}
						/>
					</div>
				</div>
				<div className="mt-5 border-b pb-3">
					<TabButtons active={tab} onSelect={setTab} tabs={STORE_TABS} />
				</div>
				<div className="min-h-0 flex-1 overflow-auto pt-5">
					<StoreContent view={view} />
				</div>
			</section>
		</StoreViewModeProvider>
	);
}

function Story() {
	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<header className="mx-auto mb-8 max-w-6xl">
				<p className="font-medium text-muted-foreground text-sm uppercase tracking-widest">
					View mode proof
				</p>
				<h1 className="mt-2 font-semibold text-3xl tracking-tight">
					Special views stay optional
				</h1>
				<p className="mt-2 max-w-2xl text-muted-foreground">
					Showcase keeps the visual cards. Grid and List use the compact
					collection cards, and each shell remembers its choice per tab.
				</p>
			</header>
			<div className="mx-auto flex max-w-6xl flex-col gap-6 lg:flex-row">
				<LibraryPanel />
				<StorePanel />
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
