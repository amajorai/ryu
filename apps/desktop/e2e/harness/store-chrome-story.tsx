import type {} from "./proof-css-custom-properties.d.ts";
import proofStyles from "./store-chrome-story.module.css";
// Standalone browser story for the REAL Store/Library page chrome:
// `StoreSectionTabs` (the pill section strip, scrolled through the shared
// `TabsList`) and `StoreGlobalSearch` (the large muted search pill), both
// exported from `packages/blocks/src/desktop/store.tsx`.
//
// Both are prop-driven presentational components, so they mount without Core,
// Tauri or seed data. The third panel mirrors StorePage's structural shell —
// search over tabs over a scrolling column — because the ORDER is the claim: the
// control that searches everything sits above the tabs that scope a search to one
// realm, not below them.

import {
	BrainIcon,
	Chat01Icon,
	Clock01Icon,
	ColorsIcon,
	Cursor02Icon,
	CursorMagicSelection04Icon,
	Download01Icon,
	FileExportIcon,
	Home01Icon,
	LayerIcon,
	PlugSocketIcon,
	StarIcon,
	Target01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	StoreGlobalSearch,
	type StoreSectionTab,
	StoreSectionTabs,
} from "@ryu/blocks/desktop/store.tsx";
import MarketplaceHelpDialog from "@ryu/marketplace/catalog/chrome/marketplace-help-dialog";
import { REALM_ICONS } from "@ryu/marketplace/catalog/realm-icons";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { type CSSProperties, useState } from "react";
import { createRoot } from "react-dom/client";
import { SECTION_ICONS } from "../../src/components/layout/sidebar-sections.ts";
import "../../src/index.css";

const MANY: StoreSectionTab[] = [
	{ group: "discover", icon: Home01Icon, label: "Home", value: "home" },
	{
		count: 12,
		group: "discover",
		icon: SECTION_ICONS.companions,
		label: "Apps",
		value: "apps",
	},
	{
		count: 48,
		group: "discover",
		icon: SECTION_ICONS.plugins,
		label: "Plugins",
		value: "plugins",
	},
	{
		count: 7,
		group: "discover",
		icon: REALM_ICONS.agents,
		label: "Agents",
		value: "agents",
	},
	{
		count: 4,
		group: "build",
		icon: SECTION_ICONS.workflows,
		label: "Workflows",
		value: "workflows",
	},
	{
		count: 1_234_567,
		group: "build",
		icon: REALM_ICONS.models,
		label: "Models",
		value: "models",
	},
	{
		count: 6,
		group: "build",
		icon: SECTION_ICONS.engines,
		label: "Engines",
		value: "engines",
	},
	{
		count: 3,
		group: "manage",
		icon: SECTION_ICONS.teams,
		label: "Groups",
		value: "teams",
	},
	{
		count: 9,
		group: "manage",
		icon: Download01Icon,
		label: "Installed",
		value: "installed",
	},
	{
		count: 2,
		group: "account",
		icon: FileExportIcon,
		label: "Output Styles",
		value: "output-styles",
	},
	{
		count: 8,
		group: "manage",
		icon: ColorsIcon,
		label: "Themes",
		value: "themes",
	},
	{
		count: 2,
		group: "account",
		icon: PlugSocketIcon,
		label: "Connections",
		value: "connections",
	},
];

const FEW: StoreSectionTab[] = MANY.slice(0, 2);

const LIBRARY: StoreSectionTab[] = [
	{
		count: 1234,
		group: "library",
		icon: Clock01Icon,
		label: "Recents",
		value: "recents",
	},
	{
		count: 6,
		group: "library",
		icon: StarIcon,
		label: "Favorites",
		value: "favorites",
	},
	{
		count: 24,
		group: "library",
		icon: SECTION_ICONS.chats,
		label: "Chats",
		value: "chat",
	},
	{
		count: 7,
		group: "library",
		icon: SECTION_ICONS.agents,
		label: "Agents",
		value: "agent",
	},
	{
		count: 3,
		group: "library",
		icon: SECTION_ICONS.channels,
		label: "Channels",
		value: "channel",
	},
	{
		count: 4,
		group: "library",
		icon: SECTION_ICONS.companions,
		label: "Apps",
		value: "companions",
	},
	{
		count: 11,
		group: "library",
		icon: SECTION_ICONS.engines,
		label: "Engines",
		value: "engines",
	},
	{
		count: 14,
		group: "apps",
		icon: "workflow-circle-06",
		label: "Meeting notes",
		value: "plugin:com.ryu.meetings:notes",
	},
];

const COUNT_FORMAT_PROOF: StoreSectionTab[] = [
	{
		count: 1234,
		group: "social",
		icon: Download01Icon,
		label: "Downloads",
		value: "downloads",
	},
	{
		count: 4200,
		group: "social",
		icon: StarIcon,
		label: "Likes",
		value: "likes",
	},
	{
		count: 1_234_567,
		group: "owned",
		icon: SECTION_ICONS.companions,
		label: "Library",
		value: "library",
	},
];

const ICON_PROOF = [
	{ icon: SECTION_ICONS.companions, label: "Apps", name: "Package01Icon" },
	{ icon: SECTION_ICONS.plugins, label: "Plugins", name: "PlugSocketIcon" },
	{ icon: SECTION_ICONS.skills, label: "Skills", name: "PotionIcon" },
	{
		icon: SECTION_ICONS.workflows,
		label: "Workflows",
		name: "WorkflowCircle06Icon",
	},
	{ icon: Chat01Icon, label: "Chats", name: "Chat01Icon" },
	{ icon: SECTION_ICONS.teams, label: "Groups", name: "UserMultiple02Icon" },
	{ icon: SECTION_ICONS.channels, label: "Channels", name: "Tv01Icon" },
	{
		icon: SECTION_ICONS.identities,
		label: "Identities",
		name: "FingerPrintIcon",
	},
	{ icon: StarIcon, label: "Favorites", name: "StarIcon" },
	{ icon: LayerIcon, label: "Engines", name: "LayerIcon" },
	{ icon: BrainIcon, label: "Models", name: "BrainIcon" },
	{ icon: Download01Icon, label: "Installed", name: "Download01Icon" },
	{ icon: FileExportIcon, label: "Output Styles", name: "FileExportIcon" },
	{ icon: ColorsIcon, label: "Themes", name: "ColorsIcon" },
	{ icon: Target01Icon, label: "Agents", name: "Target01Icon" },
];

/**
 * StorePage's shell in miniature: the global search over the section tabs over a
 * scrolling content column, all in the page flow.
 *
 * Nothing is positioned out of flow any more. The search used to be an
 * `absolute` bar pinned to the bottom, which is why this story also carried a
 * stand-in for the shell's split-pane badge (the one thing that shared that
 * corner, and that a z-index on the bar erased). With the field in the flow at
 * the top, neither the overlap nor the padding dance it needed exists.
 */
function PageShell({ testid, width }: { testid: string; width: number }) {
	const [query, setQuery] = useState("");
	return (
		<section
			className="relative flex h-80 w-(--proof-width) flex-col overflow-hidden rounded-xl border border-border"
			data-testid={`${testid}-shell`}
			style={
				{ "--proof-width": `${width}px` } satisfies CSSProperties & {
					"--proof-width": string;
				}
			}
		>
			<div className="relative flex h-full flex-col overflow-hidden">
				<div className="shrink-0 px-4 pt-4">
					<StoreGlobalSearch
						onChange={setQuery}
						placeholder="Search the whole marketplace…"
						trailing={<MarketplaceHelpDialog />}
						value={query}
					/>
					<StoreSectionTabs
						active="home"
						inset="store-sections"
						sections={MANY}
					/>
				</div>
				<div className="min-h-0 flex-1 overflow-hidden">
					<div
						className="h-full overflow-auto p-4"
						data-testid={`${testid}-scroller`}
					>
						{Array.from({ length: 30 }, (_, i) => i).map((i) => (
							<div
								className="border-border/60 border-b py-2 text-sm"
								data-testid={i === 29 ? `${testid}-last-row` : "row"}
								key={i}
							>
								Row {i}
							</div>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}

function Story() {
	const [wideActive, setWideActive] = useState("home");
	const [narrowActive, setNarrowActive] = useState("home");

	return (
		// `bg-background` on the page itself: the bottom search bar is opaque and
		// takes the theme background, so a story on a bare white body would hide
		// whether it actually covers what scrolls under it in dark mode.
		<div className="flex min-h-screen flex-col gap-8 bg-background p-6 text-foreground">
			{/* Overflowing strip: 10 sections in a 420px column, so both the scroll
			    and the edge fade are exercised. */}
			<section className={proofStyles.fixture1} data-testid="narrow-panel">
				<p className="pb-2 font-semibold text-lg">Marketplace</p>
				<StoreSectionTabs
					active={narrowActive}
					inset="store-sections"
					onSelect={setNarrowActive}
					sections={MANY}
				/>
			</section>

			{/* Non-overflowing strip: two sections with room to spare, so the fade
			    must NOT engage. */}
			<section className={proofStyles.fixture2} data-testid="wide-panel">
				<p className="pb-2 font-semibold text-lg">Library</p>
				<StoreSectionTabs
					active={wideActive}
					inset="store-sections"
					onSelect={setWideActive}
					sections={FEW}
				/>
			</section>

			{/* A roomy pane, and a deliberately cramped one. The narrow shell is where
			    the bar has to hold up: 360px is about the narrowest a split pane gets
			    before the shell stops splitting, and it is also where the pane badge
			    and the input row overlap most. */}
			<PageShell testid="page" width={640} />
			<PageShell testid="cramped" width={360} />

			<section
				className={proofStyles.fixture3}
				data-testid="library-counts-panel"
			>
				<p className="pb-2 font-semibold text-lg">Library registry</p>
				<StoreSectionTabs
					active="recents"
					inset="store-sections"
					sections={LIBRARY}
				/>
				<p
					className="pt-3 text-muted-foreground text-xs"
					data-testid="library-registry-note"
				>
					Built-in sidebar collections and app-registered sections use the same
					Library tab contract.
				</p>
			</section>

			<section
				className="max-w-225 rounded-xl border border-border bg-card p-4"
				data-testid="count-format-proof"
			>
				<p className="pb-3 font-semibold text-lg">Count formatting</p>
				<StoreSectionTabs active="downloads" sections={COUNT_FORMAT_PROOF} />
				<p
					className="pt-3 text-muted-foreground text-sm tabular-nums"
					data-testid="line-count-proof"
				>
					+{formatCount(1_234_567) ?? "—"} lines · {formatCount(1234) ?? "—"}{" "}
					files · {formatCount(4200) ?? "—"} likes ·{" "}
					{formatCount(1_234_567) ?? "—"} library items
				</p>
			</section>

			<section
				className="max-w-225 rounded-xl border border-border bg-card p-4"
				data-testid="icon-parity-proof"
			>
				<p className="pb-3 font-semibold text-lg">Icon parity</p>
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
					{ICON_PROOF.map(({ icon, label, name }) => (
						<div
							className="flex items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-sm"
							data-icon-name={name}
							key={name}
						>
							<HugeiconsIcon className="size-4 shrink-0" icon={icon} />
							<span>{label}</span>
						</div>
					))}
					<div
						className="flex items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-sm"
						data-icon-name="Cursor02Icon"
					>
						<HugeiconsIcon className="size-4 shrink-0" icon={Cursor02Icon} />
						<span>Device use</span>
					</div>
					<div
						className="flex items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-sm"
						data-icon-name="CursorMagicSelection04Icon"
					>
						<HugeiconsIcon
							className="size-4 shrink-0"
							icon={CursorMagicSelection04Icon}
						/>
						<span>Device control</span>
					</div>
				</div>
			</section>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
