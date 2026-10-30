import {
	ArrowRight01Icon,
	BrainIcon,
	Chat01Icon,
	CpuIcon,
	DeliverySecure01Icon,
	LayerIcon,
	PotionIcon,
	Share01Icon,
	Target01Icon,
	WorkflowCircle06Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { CommandPaletteTab } from "@ryu/command/types";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { useTheme } from "next-themes";
import type { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import type { useCommandSearchSections } from "@/src/hooks/useCommandSearchSections.ts";
import type { useContributedSectionItems } from "@/src/hooks/useContributedCommands.ts";
import type { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import type { MessageSearchHit } from "@/src/lib/api/conversation-search.ts";
import type { MarketplaceCard } from "@/src/lib/api/marketplace.ts";
import type { PluginDocument } from "@/src/lib/api/plugin-wire-values.ts";
import type { ShadowSearchResult } from "@/src/lib/api/shadow.ts";
import type { SpaceLexicalHit } from "@/src/lib/api/spaces.ts";
import type { useOptionalDesktopWorkbench } from "@/src/workbench/DesktopWorkbenchContext.tsx";
import type { useWorkbenchToolsContext } from "@/src/workbench/workbench-chrome.tsx";

/** Safely read a string field off an opaque plugin-contribution record. */
export function contribString(
	record: PluginDocument,
	key: string
): string | undefined {
	const value = record[key];
	return isNativeText(value) ? value : undefined;
}

export type SettingsSection =
	| "appearance"
	| "profile"
	| "account"
	| "connections"
	| "sessions"
	| "authorized-apps"
	| "billing"
	| "credits"
	| "usage"
	| "hardware"
	| "memory";

/**
 * The SHELL's own pages — the ones this desktop client compiles in and owns. A
 * Ryu App is deliberately NOT in this list: an app reaches the palette through
 * the contributions feed instead (its `companion` surface, its `sidebar_buttons`,
 * or its `sidebar_sections`' live items), exactly like it reaches the sidebar.
 *
 * Calendar / Timeline / Monitors / Tasks / Meetings / Learning used to sit here.
 * Each is an apps-store app (`com.ryu.{calendar,timeline,monitors,quests,
 * meetings,learning}`) that declares a `companion`, so it was already being
 * listed by the data-driven sidebar-section index — the hardcoded row was a second, dumber
 * copy that rendered whether or not the app was installed (all six are
 * not pre-installed) and pointed at a shell alias route rather than the seam route the
 * companion mints. Same reasoning, and the same fix, as the sidebar's
 * `CHROME_ORDER`: the App declares itself; the shell does not enumerate Apps.
 *
 * Inbox and Memory were the last two survivors of that rule. Approvals remains
 * opt-in, while Memory is pre-installed so its authenticated Library route is
 * reachable on a fresh install. Neither needs a row here: an enabled approvals
 * app is listed by the data-driven sidebar-section index, and the enabled Memory
 * app contributes a `sidebar_buttons` entry targeting `/library/memory` that the
 * contributed-button loop lists. Note the dedupe below reads `navTargets` — while a target sat in
 * NAV_ITEMS the shell's dumb copy actively SUPPRESSED the app's own declaration.
 */
export const NAV_ITEMS = [
	{ to: "/chat", label: "Chat", icon: Chat01Icon },
	{ to: "/compute", label: "Compute", icon: CpuIcon },
	{ to: "/share", label: "Share", icon: Share01Icon },
	{ to: "/library/agent", label: "Agents", icon: Target01Icon },
	{ to: "/engines", label: "Engines", icon: LayerIcon },
	{ to: "/models", label: "Models", icon: BrainIcon },
	{ to: "/skills", label: "Skills", icon: PotionIcon },
	{ to: "/library/space", label: "Spaces", icon: DeliverySecure01Icon },
	{ to: "/tools", label: "Tools", icon: Wrench01Icon },
	{ to: "/library/workflow", label: "Workflows", icon: WorkflowCircle06Icon },
	{ to: "/review", label: "Weekly review", icon: ArrowRight01Icon },
] as const;

/** Navigation targets held behind the `ui.compute_share` rollout flag. */
export const COMPUTE_SHARE_NAV_TARGETS: ReadonlySet<string> = new Set([
	"/compute",
	"/share",
]);

export const NAV_RESULT_TYPES = new Map<
	(typeof NAV_ITEMS)[number]["to"],
	string
>([
	["/chat", "chats"],
	["/engines", "engines"],
	["/library/agent", "agents"],
	["/library/space", "spaces"],
	["/library/workflow", "workflows"],
	["/skills", "skills"],
	["/tools", "tools"],
]);

export const MAX_CHAT_RESULTS = 30;

/** Turn a snake_case capture kind (e.g. "clipboard_copy") into plain words. */
export const SNAKE_CASE = /_/g;

/**
 * Human-readable label for a captured item when it has no title/snippet/app —
 * turns a raw `event_type` like "clipboard_copy" into "Clipboard copy" so a
 * first-time user never sees developer jargon in a result row.
 */
export const humanizeCaptureKind = (eventType: string): string => {
	const words = eventType.replace(SNAKE_CASE, " ").trim();
	if (!words) {
		return "Captured item";
	}
	return words.charAt(0).toUpperCase() + words.slice(1);
};

export type OpenTab = Parameters<
	Parameters<typeof useTabSelector>[0]
>[0]["openTab"];

export type PluginContributions = ReturnType<typeof usePluginContributions>;

/** Everything the palette's action builders read from `CommandPalette`. */
export interface CommandActionContext {
	close: () => void;
	commandSearchSections: ReturnType<
		typeof useCommandSearchSections
	>["sections"];
	computeShareEnabled: boolean;
	contributedButtons: PluginContributions["sidebar_buttons"];
	contributedSectionItems: ReturnType<typeof useContributedSectionItems>;
	formatAgeAgo: (timestamp?: number) => string | undefined;
	handleImportSetup: () => void;
	handleImportThread: () => void;
	handleNavigate: (to: string, title?: string) => void;
	handleNewChat: () => void;
	handleOpenCapture: (ts: number) => void;
	handleOpenSettings: (section: SettingsSection) => void;
	handleRunPluginCommand: (commandId: string, label: string) => void;
	handleSelectChat: (id: string, messageId?: string) => void;
	handleSelectMarketplace: (card: MarketplaceCard, queryText: string) => void;
	handleSelectPage: (hit: SpaceLexicalHit) => void;
	handleSignOutAction: () => void;
	handleToggleFullscreen: () => void;
	isSigningOut: boolean;
	marketplaceResults: MarketplaceCard[];
	messageResults: MessageSearchHit[];
	modKey: string;
	pluginCommands: PluginContributions["slash_commands"];
	query: string;
	requestRemember: () => void;
	resultMeta: (
		subtitle: string | null | undefined,
		timestamp?: number
	) => string | undefined;
	searchTabs: CommandPaletteTab[];
	setTheme: ReturnType<typeof useTheme>["setTheme"];
	shadowResults: ShadowSearchResult[];
	spaceResults: SpaceLexicalHit[];
	theme: ReturnType<typeof useTheme>["theme"];
	workbench: ReturnType<typeof useOptionalDesktopWorkbench>;
	workbenchTools: ReturnType<typeof useWorkbenchToolsContext>;
}
