import { GitCommitIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { FadeOverflowText } from "@ryu/ui/components/fade-overflow-text.tsx";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { modelMenuItem } from "../../components/agent-elements/input/model-router.ts";
import { ProviderCommandDialog } from "../../components/agent-elements/input/provider-command-dialog.tsx";
import {
	type ProviderEntry,
	UniversalPickerBody,
	type UniversalPickerData,
} from "../../components/agent-elements/input/universal-picker-body.tsx";
import { InfiniteMenuItems } from "../../src/components/layout/infinite-menu-items.tsx";
import { CoworkContextPanel } from "../../src/components/panels/CoworkContextPanel.tsx";
import type { BouncyAccordionItem } from "../../src/components/ui/bouncy-accordion.tsx";
import type { PickerRef } from "../../src/lib/picker-favorites.ts";
import "../../src/index.css";

const queryClient = new QueryClient();
const LONG_LABEL =
	"A commit or branch label that keeps crawling on hover instead of hiding the useful text";

const PROVIDER_MODELS = [
	modelMenuItem("openrouter/auto"),
	modelMenuItem("openrouter/pareto-code"),
	{ id: "model-alpha", name: "Alpha Long Context" },
	{ id: "model-beta", name: "Beta Reasoning" },
	{ id: "model-gamma", name: "Gamma Fast" },
	{ id: "model-delta", name: "Delta Vision" },
	{ id: "model-epsilon", name: "Epsilon Tool Use" },
	{ id: "model-zeta", name: "Zeta Structured Output" },
	{ id: "model-eta", name: "Eta Long Context" },
];

function makeProvider(
	id: string,
	label: string,
	engineKey: string
): ProviderEntry {
	return {
		accounts: [],
		authKind: "api-key",
		configured: true,
		currentModel: PROVIDER_MODELS[0].id,
		currentThinking: "high",
		engineKey,
		id,
		isActive: false,
		label,
		managed: false,
		models: [...PROVIDER_MODELS],
		supportsDiscovery: false,
		upsell: false,
	};
}

const PROVIDERS = [
	makeProvider("anthropic", "Anthropic", "anthropic"),
	makeProvider("openai", "OpenAI", "openai"),
	makeProvider("google", "Google", "gemini"),
	makeProvider("openrouter", "OpenRouter", "openrouter"),
];

const INITIAL_RECENTS: PickerRef[] = [
	{
		effort: "high",
		kind: "model",
		modelId: "model-alpha",
		providerId: "anthropic",
	},
	{
		effort: "medium",
		kind: "model",
		modelId: "model-beta",
		providerId: "openai",
	},
	{
		effort: "low",
		kind: "model",
		modelId: "model-alpha",
		providerId: "google",
	},
	{
		effort: "high",
		kind: "model",
		modelId: "model-beta",
		providerId: "anthropic",
	},
	{
		effort: "medium",
		kind: "model",
		modelId: "model-alpha",
		providerId: "openai",
	},
];

function samePickerRef(left: PickerRef, right: PickerRef): boolean {
	if (left.kind !== right.kind) {
		return false;
	}
	if (left.kind === "agent" && right.kind === "agent") {
		return left.agentId === right.agentId;
	}
	if (left.kind !== "model" || right.kind !== "model") {
		return false;
	}
	return (
		left.providerId === right.providerId &&
		left.modelId === right.modelId &&
		left.effort === right.effort
	);
}

function DropdownProof() {
	return (
		<section className="flex min-w-0 flex-col gap-3 rounded-2xl border bg-card p-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<p className="font-medium text-sm">Shared dropdown contract</p>
					<p className="text-muted-foreground text-xs">
						The real menu primitive owns the cap, fade, and hover crawl; the
						list window grows as its sentinel reaches the viewport.
					</p>
				</div>
				<span className="rounded-full border px-2 py-1 font-medium text-[11px]">
					data-driven
				</span>
			</div>
			<div className="flex min-h-0 justify-center rounded-xl border border-dashed p-3">
				<DropdownMenu>
					<DropdownMenuTrigger
						className="rounded-lg border px-3 py-2 text-sm"
						data-testid="dropdown-proof-trigger"
					>
						Open 65 commits
					</DropdownMenuTrigger>
					<DropdownMenuContent
						className="min-w-[420px]"
						data-testid="dropdown-proof-menu"
						side="bottom"
					>
						<InfiniteMenuItems
							items={Array.from({ length: 65 }, (_, index) => index)}
							pageSize={10}
							renderItem={(index) => (
								<DropdownMenuItem
									data-testid={`dropdown-proof-row-${index}`}
									key={index}
								>
									<span className="shrink-0 font-mono text-muted-foreground text-xs">
										{String(index + 1).padStart(2, "0")}
									</span>
									<FadeOverflowText
										className="min-w-0 flex-1"
										data-slot="dropdown-proof-label"
									>
										{LONG_LABEL} #{index + 1}
									</FadeOverflowText>
								</DropdownMenuItem>
							)}
						/>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<div className="flex min-h-0 justify-center rounded-xl border border-dashed p-3">
				<DropdownMenu>
					<DropdownMenuTrigger
						className="rounded-lg border px-3 py-2 text-sm"
						data-testid="dropdown-short-trigger"
					>
						Open short menu
					</DropdownMenuTrigger>
					<DropdownMenuContent data-testid="dropdown-short-menu" side="bottom">
						<DropdownMenuItem>One item</DropdownMenuItem>
						<DropdownMenuItem>Two items</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<div className="grid gap-2 text-xs sm:grid-cols-3">
				<div className="rounded-lg bg-muted/50 p-2">
					<p className="text-muted-foreground">Overflow</p>
					<p data-testid="dropdown-proof-overflow">Scroll to inspect</p>
				</div>
				<div className="rounded-lg bg-muted/50 p-2">
					<p className="text-muted-foreground">Hover</p>
					<p data-testid="dropdown-proof-hover">Hover a row</p>
				</div>
				<div className="rounded-lg bg-muted/50 p-2">
					<p className="text-muted-foreground">Pagination</p>
					<p data-testid="dropdown-proof-pagination">10 rows first</p>
				</div>
			</div>
		</section>
	);
}

function TextTabsProof() {
	return (
		<section className="rounded-2xl border bg-card p-4">
			<p className="font-medium text-sm">Text tabs</p>
			<p className="mt-1 text-muted-foreground text-xs">
				The active label is foreground; the inactive label is muted; neither
				paints a background.
			</p>
			<Tabs className="mt-4" defaultValue="overview">
				<TabsList data-testid="text-tabs-proof" variant="text">
					<TabsTrigger data-testid="text-tab-active" value="overview">
						Overview
					</TabsTrigger>
					<TabsTrigger data-testid="text-tab-inactive" value="activity">
						Activity
					</TabsTrigger>
				</TabsList>
			</Tabs>
		</section>
	);
}

function PinnedSummaryProof() {
	const leadingItems = useMemo<BouncyAccordionItem[]>(
		() => [
			{
				description: (
					<div className="flex gap-2">
						<button
							className="rounded-lg px-2 py-1 text-xs"
							data-testid="pinned-summary-action"
							type="button"
						>
							Commit
						</button>
						<button
							className="rounded-lg px-2 py-1 text-xs"
							data-testid="pinned-summary-action-secondary"
							type="button"
						>
							Push
						</button>
					</div>
				),
				icon: <HugeiconsIcon icon={GitCommitIcon} size={16} />,
				id: "environment",
				title: "Environment",
			},
		],
		[]
	);

	return (
		<section className="rounded-2xl border bg-card p-4">
			<p className="font-medium text-sm">Pinned summary buttons</p>
			<p className="mt-1 text-muted-foreground text-xs">
				Hovering either action keeps the summary surface quiet instead of
				washing the button background.
			</p>
			<div className="mt-3 max-w-sm">
				<CoworkContextPanel
					leadingItems={leadingItems}
					messages={[]}
					runId={null}
					target={{ token: null, url: "http://localhost:65535" }}
					variant="summary"
				/>
			</div>
		</section>
	);
}

function ModelPickerProof() {
	const [recentRefs, setRecentRefs] = useState(INITIAL_RECENTS);
	const data: UniversalPickerData = {
		activeAgentId: "ryu",
		activeExtraSections: [],
		activeModelSection: null,
		agents: [],
		availableExternal: [],
		installedExternal: [],
		installPendingId: null,
		forceModelPicker: true,
		onConfigureCredentials: () => undefined,
		onInstallExternal: () => undefined,
		onRemoveAgentAccount: () => undefined,
		onRemoveProviderAccount: () => undefined,
		onRemoveRecent: (ref) =>
			setRecentRefs((current) =>
				current.filter((candidate) => !samePickerRef(candidate, ref))
			),
		onSelectAgent: () => undefined,
		onSelectProviderModel: () => undefined,
		onSelectProviderThinking: () => undefined,
		onSelectRecentModel: () => undefined,
		onSwitchAgentAccount: () => undefined,
		onSwitchProviderAccount: () => undefined,
		onUpgrade: () => undefined,
		onUseProvider: () => undefined,
		providers: PROVIDERS,
		recentRefs,
		ryuActive: true,
		ryuAgent: null,
		teams: [],
		thinkingLevels: ["low", "medium", "high"],
	};

	return (
		<section className="rounded-2xl border bg-card p-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<p className="font-medium text-sm">Model picker recents</p>
					<p className="mt-1 text-muted-foreground text-xs">
						Five provider/model/effort picks stay at the top; hover a row to
						reveal the remove affordance and hover the meter for the full effort
						name.
					</p>
				</div>
				<span
					className="rounded-full bg-muted px-2 py-1 text-[11px]"
					data-testid="recent-count"
				>
					{recentRefs.length} recent
				</span>
			</div>
			<div className="mt-3 rounded-xl border p-1">
				<ProviderCommandDialog
					renderBody={(close) => (
						<UniversalPickerBody close={close} data={data} mode="models" />
					)}
					title="Choose provider and model"
					trigger={
						<button
							className="rounded-lg border px-3 py-2 text-sm"
							data-testid="model-picker-trigger"
							type="button"
						>
							Open model picker
						</button>
					}
				/>
			</div>
		</section>
	);
}

function ProofPage() {
	useEffect(() => {
		document.body.dataset.harnessReady = "1";
	}, []);

	return (
		<main className="min-h-screen bg-background p-6 text-foreground sm:p-10">
			<div className="mx-auto flex max-w-6xl flex-col gap-6">
				<header className="flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-start sm:justify-between">
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.18em]">
							React verification artifact
						</p>
						<h1 className="mt-2 font-semibold text-3xl tracking-tight">
							Dropdowns, tabs, summary, and model recents
						</h1>
						<p className="mt-2 max-w-3xl text-muted-foreground text-sm leading-6">
							A focused browser surface mounting the shipping shared primitives
							and recent-picker body used by the desktop app.
						</p>
					</div>
					<span
						className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 font-medium text-emerald-700 text-xs dark:text-emerald-300"
						data-testid="proof-status"
					>
						LIVE COMPONENT PROOF
					</span>
				</header>

				<div className="grid gap-6 lg:grid-cols-2">
					<DropdownProof />
					<ModelPickerProof />
					<TextTabsProof />
					<PinnedSummaryProof />
				</div>

				<p className="text-muted-foreground text-xs">
					Open the shared dropdown to exercise its scroll window, hover a long
					row, and inspect the next page.
				</p>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<ProofPage />
		</QueryClientProvider>
	);
}
