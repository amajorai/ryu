import {
	Add01Icon,
	CpuIcon,
	LibraryIcon,
	PackageIcon,
	PackageOpenIcon,
	Share01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useI18n } from "@ryu/i18n/react";
import {
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
} from "@ryu/ui/components/sidebar.tsx";
import type { ReactNode } from "react";
import { NodeSelector } from "@/src/components/shell/NodeSelector.tsx";
import type { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import type { useConsoleAccess } from "@/src/hooks/useConsoleAccess.ts";
import type { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { isRyuBot } from "@/src/lib/product.ts";
import { BotConnectionBadge } from "../bot/BotConnectionBadge.tsx";
import { BotProfileCard } from "../bot/BotProfileCard.tsx";
import { TabbedSectionNav } from "./AppSidebar-tabbed-nav.tsx";
import { SidebarBrandBadge } from "./SidebarBrandBadge.tsx";
import {
	ChromeButtonShell,
	type ChromeDnd,
	ChromeHideMenu,
	type ChromeMenu,
	DynamicSidebarButton,
	NavTabButton,
} from "./sidebar-chrome-buttons.tsx";
import type { SidebarModeDescriptor } from "./sidebar-modes.ts";
import { type ChromeKey, isDynamicChromeKey } from "./sidebar-panel-state.tsx";
import type { SectionKey } from "./sidebar-sections.ts";

type ContributedButtons = ReturnType<
	typeof usePluginContributions
>["sidebar_buttons"];

interface HeaderButtonContext {
	chromeMenu: ChromeMenu;
	contributedButtons: ContributedButtons;
	handleNewConversation: () => void;
	t: ReturnType<typeof useI18n>["t"];
}

// One reorderable header button, by key. Returns the button's inner content;
// ChromeButtonShell (below) supplies the draggable SidebarMenuItem wrapper.
export function renderSidebarHeaderButton(
	key: ChromeKey,
	{
		chromeMenu,
		contributedButtons,
		handleNewConversation,
		t,
	}: HeaderButtonContext
): ReactNode {
	switch (key) {
		case "new-chat":
			return (
				<ChromeHideMenu chromeKey="new-chat" label="New chat" menu={chromeMenu}>
					<SidebarMenuButton
						corners="rounded"
						onClick={handleNewConversation}
						size="compact"
					>
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						<span>{t("sidebar.chrome.new-chat", {}, "New chat")}</span>
					</SidebarMenuButton>
				</ChromeHideMenu>
			);
		// "search" now renders as an icon next to the node selector (see the
		// SidebarHeader row below), not as a header button.
		// "home" is represented by the owning app's Apps-shelf tile; no hardcoded
		// case. The key stays in BuiltinChromeKey/CHROME_LABELS for graceful
		// filtering of any stale persisted layout.
		case "library":
			return (
				<NavTabButton
					chromeKey="library"
					icon={LibraryIcon}
					label={t("sidebar.chrome.library", {}, "Library")}
					menu={chromeMenu}
					path="/library"
				/>
			);
		case "compute":
			return (
				<NavTabButton
					chromeKey="compute"
					icon={CpuIcon}
					label="Compute"
					menu={chromeMenu}
					path="/compute"
				/>
			);
		case "share":
			return (
				<NavTabButton
					chromeKey="share"
					icon={Share01Icon}
					label="Share"
					menu={chromeMenu}
					path="/share"
				/>
			);
		// "memory" is represented by the owning app's Apps-shelf tile. The key stays
		// in BuiltinChromeKey/CHROME_LABELS so a stale persisted layout is filtered
		// out gracefully rather than crashing.
		case "store":
			return (
				<NavTabButton
					activeIcon={PackageOpenIcon}
					chromeKey="store"
					icon={PackageIcon}
					label={t("sidebar.chrome.customize", {}, "Customize")}
					menu={chromeMenu}
					path="/store"
				/>
			);
		// "marketplace"/"apps"/"extensions" deliberately have NO case here, for the
		// reason given above CHROME_ORDER: all three folded into the Customize
		// (Store) shell as sections and no longer get their own sidebar button.
		// They kept unreachable cases for a while, which was worse than nothing —
		// `CHROME_ORDER` excludes the keys, so the cases could never run, and the
		// dead "marketplace" branch still rendered a storefront glyph while the
		// live Store button renders `PackageIcon`. A glyph that only exists on a
		// nothing reaches is a glyph nobody keeps in sync. The keys themselves stay
		// in BuiltinChromeKey/CHROME_LABELS so a stale persisted layout is filtered
		// gracefully; `default` returns null for them.
		// Tasks/Timeline/Activity/Calendar have no case here either: they are
		// Ryu Apps, listed by `AppsSection` from the enabled-companion feed. See
		// the note above CHROME_ORDER.
		default: {
			// Plugin-registered header button (`plugin:<pluginId>:<buttonId>`): resolve
			// the contribution from the feed and render it generically.
			if (isDynamicChromeKey(key)) {
				const button = contributedButtons.find(
					(b) => `plugin:${b.plugin}:${b.id}` === key
				);
				return button ? (
					<DynamicSidebarButton button={button} menu={chromeMenu} />
				) : null;
			}
			return null;
		}
	}
}

/** The panel header: node selector or bot badge, brand, the reorderable
 *  header buttons, and (in strip modes) the tabbed section selector. */
export function SidebarPanelHeader({
	activeMode,
	activeTabbedKey,
	botProduct,
	canSwitchToConsole,
	chromeDnd,
	chromeMenu,
	contributedButtons,
	conversations,
	handleNewConversation,
	hiddenChrome,
	renderChromeOrder,
	sectionLabels,
	setActiveTabbedSection,
	tabbedKeys,
}: {
	activeMode: SidebarModeDescriptor;
	activeTabbedKey: SectionKey | null;
	botProduct: boolean;
	canSwitchToConsole: ReturnType<typeof useConsoleAccess>["canSwitchToConsole"];
	chromeDnd: ChromeDnd;
	chromeMenu: ChromeMenu;
	contributedButtons: ContributedButtons;
	conversations: ReturnType<typeof useChatHistoryContext>["conversations"];
	handleNewConversation: () => void;
	hiddenChrome: Set<string>;
	renderChromeOrder: ChromeKey[];
	sectionLabels: Record<string, string>;
	setActiveTabbedSection: (key: SectionKey) => void;
	tabbedKeys: SectionKey[];
}) {
	const { t } = useI18n();
	const renderHeaderButton = (key: ChromeKey) =>
		renderSidebarHeaderButton(key, {
			chromeMenu,
			contributedButtons,
			handleNewConversation,
			t,
		});
	return (
		<SidebarHeader spacing="flush">
			{botProduct ? (
				<BotConnectionBadge />
			) : (
				!hiddenChrome.has("node-selector") && (
					<div
						// pt-2 drops this row onto the top row's shared centerline (see
						// Layout): sidebar top pad 2 + pt-2 + h-8 centers the selector at
						// 30.72px — the tab strip's natural line (SidebarInset m-2 +
						// h-12/2), matched by the nav cluster and macOS traffic lights.
						className="flex items-center gap-2 px-2 pt-2 pb-1"
						data-tauri-drag-region
					>
						{/* Back/forward/sidebar-toggle/search live pinned at the window's
							    top-left (in Layout). The node selector is right-aligned here so
							    it never collides with that cluster. */}
						<div
							className="ml-auto flex items-center gap-0.5"
							data-tauri-drag-region={false}
						>
							<NodeSelector mode="compact-dropdown" />
						</div>
					</div>
				)
			)}
			{!hiddenChrome.has("logo") && (
				<SidebarBrandBadge
					canSwitchToConsole={canSwitchToConsole}
					canSwitchToOs={!isRyuBot()}
					className={hiddenChrome.has("node-selector") ? "pt-2" : ""}
				/>
			)}
			{botProduct ? <BotProfileCard conversations={conversations} /> : null}
			<div
				className="scroll-fade max-h-[min(50vh,28rem)] min-h-0 overflow-y-auto overscroll-contain"
				data-testid="sidebar-header-actions"
			>
				<SidebarMenu>
					{renderChromeOrder.map((key) => (
						<ChromeButtonShell chromeKey={key} dnd={chromeDnd} key={key}>
							{renderHeaderButton(key)}
						</ChromeButtonShell>
					))}
				</SidebarMenu>
			</div>
			{/* Every mode but the stacked one puts the section selectors below the
				    header button stack as a horizontal tab strip (not menu rows); the
				    chosen section's list shows in the scrollable content below. Which
				    sections are on the strip is the mode's business — see
				    `layout/sidebar-modes.ts`. */}
			{activeMode.layout === "strip" && (
				<TabbedSectionNav
					activeKey={activeTabbedKey}
					keys={tabbedKeys}
					labels={sectionLabels}
					onSelect={setActiveTabbedSection}
				/>
			)}
		</SidebarHeader>
	);
}
