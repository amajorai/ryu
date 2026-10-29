import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconComponent } from "@ryu/ui/components/tabs-subtle.tsx";
import { z } from "zod";
import {
	type BuiltinSectionKey,
	SECTION_ICONS,
	type SectionKey,
	SURFACE_PLUGIN_OWNER,
} from "./sidebar-sections.ts";

// The unread/pinned/archived keys moved to `useConversationFlagsStore` with the
// state they persist — the tab context menus toggle the same flags, and a second
// copy of the keys is the same live desync as a second copy of the state.
// The section order key + its reconciliation live in `sidebar-sections.ts`
// (loadSectionOrder/saveSectionOrder), next to the section vocabulary they
// reconcile against; read/write it through those rather than by key here.
export const SECTION_COLLAPSED_KEY = "ryu:sidebar-collapsed-sections";
// The hidden-sections set is owned by `lib/features.ts` (the single source of
// truth shared with onboarding + Settings → Features); read/write it via
// loadHiddenSections/persistHiddenSections rather than the local id-set helpers.
export const SECTION_PAGE_SIZE_KEY = "ryu:sidebar-section-page-sizes";
export const SECTION_SORT_KEY = "ryu:sidebar-section-sorts";
export const CHAT_SECTION_VIEWS_KEY = "ryu:sidebar-chat-section-views";
const CHROME_ORDER_KEY = "ryu:sidebar-chrome-order";

// Sidebar sections whose backing routes are gated by a Core App (`require_app_enabled`
// / the ext-proxy mount, both of which refuse while the owning app is off). When that
// App is disabled or absent the routes fail, so we hide the section rather than leave
// a nav entry that leads to a dead page. Ids mirror
// `apps/core/src/plugins/builtins.rs`.
export const SECTION_PLUGIN_OWNER = {
	// meetings/canvas/whiteboard are NOT here anymore — each is a fully app-registered
	// `sidebar_sections` contribution (com.ryu.{meetings,canvas,whiteboard}), so its
	// visibility follows the contributions feed (served only when the app is enabled),
	// not a hardcoded owner gate.
	//
	// The ids come from `SURFACE_PLUGIN_OWNER` (sidebar-sections.ts) — the ONE table
	// naming which app owns each compiled-in surface. This map only says which
	// sidebar KEY maps onto which of those surfaces; the Library states the same
	// thing for its own keys against the same table.
	spaces: SURFACE_PLUGIN_OWNER.spaces,
} satisfies Partial<Record<SectionKey, string>>;

// Pin/archive/unread state is local-first: persisted in localStorage rather than
// Core (no schema for it server-side yet). This means it does not sync across
// devices — when cross-device sync is wanted, the home for these flags is Core.
export function loadIdSet(key: string): Set<string> {
	try {
		const stored = localStorage.getItem(key);
		return stored ? new Set(JSON.parse(stored)) : new Set();
	} catch {
		return new Set();
	}
}

export function saveIdSet(key: string, ids: Set<string>) {
	try {
		localStorage.setItem(key, JSON.stringify([...ids]));
	} catch {
		// best-effort
	}
}

const PATH_SEP_RE = /[\\/]/;
/** Trailing `/` or `\` runs, stripped before taking a path's leaf. */
const TRAILING_SEPARATORS_RE = /[\\/]+$/;

/** Leaf folder name from a workspace path, used as a project's default label.
 *
 *  Trailing separators are dropped first. A path only reaches the sidebar as the
 *  spelling its producer used — the picker, Core, or an imported thread's cwd —
 *  and `"/x/y/".split(sep).pop()` is the empty string, which renders as a project
 *  with no name at all. Comparison is `folderKey`'s job; this is the display half
 *  of the same problem. */
export function projectFolderLeaf(path: string): string {
	const trimmed = path.replace(TRAILING_SEPARATORS_RE, "");
	return trimmed.split(PATH_SEP_RE).pop() || trimmed || path;
}

/** Sidebar/picker label: custom display name when set, otherwise the folder leaf. */
export function projectName(
	path: string,
	names?: Record<string, string> | null
): string {
	const custom = names?.[path]?.trim();
	if (custom) {
		return custom;
	}
	return projectFolderLeaf(path);
}

/** Adapt a hugeicons glyph into the lucide-shaped IconComponent the TabsSubtle
 *  tab item expects — it renders its icon by calling it with
 *  `size`/`strokeWidth`/`className`, which HugeiconsIcon takes as props. */
function hugeiconTabIcon(icon: IconSvgElement): IconComponent {
	return function TabIcon({
		size,
		strokeWidth,
		className,
	}: {
		size?: number;
		strokeWidth?: number;
		className?: string;
	}) {
		return (
			<HugeiconsIcon
				className={className}
				icon={icon}
				size={size}
				strokeWidth={strokeWidth}
			/>
		);
	};
}

/** The tabbed-mode section glyphs, pre-adapted once so the tab strip never
 *  builds a fresh component per render (which would remount every icon). */
// SAFETY: SECTION_ICONS covers every built-in section, and mapping each entry changes only its glyph value while preserving every key.
export const SECTION_TAB_ICONS: Record<BuiltinSectionKey, IconComponent> =
	Object.fromEntries(
		Object.entries(SECTION_ICONS).map(
			([key, icon]): [string, IconComponent] => [key, hugeiconTabIcon(icon)]
		)
	) as Record<BuiltinSectionKey, IconComponent>;

// The fixed sidebar "chrome" (header + footer) the user can hide, distinct from
// the reorderable content sections above. These don't reorder; they only hide.
type BuiltinChromeKey =
	| "logo"
	| "node-selector"
	| "home"
	| "new-chat"
	| "search"
	| "library"
	| "compute"
	| "share"
	| "memory"
	| "store"
	| "marketplace"
	| "apps"
	| "extensions"
	| "quests"
	| "timeline"
	| "activity"
	| "calendar"
	| "finetune"
	| "inbox"
	| "announcements"
	| "user"
	| "downloads"
	| "settings";

/** A dynamic, app-registered chrome-button key (`plugin:<pluginId>:<buttonId>`),
 *  minted from a `sidebar_buttons` contribution and rendered via DynamicSidebarButton. */
export type DynamicChromeKey = `plugin:${string}`;

export type ChromeKey = BuiltinChromeKey | DynamicChromeKey;

// Marketplace, Apps, and Extensions folded into the Customize (Store) shell as
// sections — they no longer get their own sidebar buttons. The keys stay in
// ChromeKey/CHROME_LABELS so any persisted user layout referencing them is
// filtered out gracefully rather than crashing. Fleet was retired entirely —
// its cross-node view lives in the node selector and the Store's Installed
// section — so its key is gone and any stale reference falls out via isChromeKey.
//
// Tasks/Timeline/Activity/Calendar left the same way, for a stronger reason: they
// are no longer built-in pages at all. Each is a Ryu App (com.ryu.{quests,timeline,
// activity,calendar}) whose route already mounts `PluginCompanionPage` (see
// `contributions/builtins.ts`), and `AppsSection` lists enabled Core-tier Apps
// from `GET /api/plugins` plus their contribution feed. A hardcoded button here
// was a second, dumber copy of that list — it rendered whether or not the App was
// installed, and an id prefix is not provenance because user plugins can claim it.
// The server-derived tier is the only shelf classifier.
export const CHROME_ORDER: ChromeKey[] = [
	"node-selector",
	// "home" is represented by the owning app's Apps-shelf tile.
	"new-chat",
	"search",
	"library",
	"compute",
	"share",
	// "memory" is represented by the owning app's Apps-shelf tile.
	"store",
	"inbox",
	"announcements",
	"user",
	"downloads",
	"settings",
];

export const CHROME_LABELS = {
	logo: "Logo",
	"node-selector": "Node selector",
	home: "Home",
	"new-chat": "New chat",
	search: "Search",
	library: "Library",
	compute: "Compute",
	share: "Share",
	memory: "Memory",
	store: "Customize",
	marketplace: "Marketplace",
	apps: "Apps",
	extensions: "Extensions",
	quests: "Tasks",
	timeline: "Timeline",
	activity: "Activity",
	calendar: "Calendar",
	finetune: "Fine-tune",
	inbox: "Inbox",
	announcements: "Announcements",
	user: "Account",
	downloads: "Downloads",
	settings: "Settings",
} satisfies Record<BuiltinChromeKey, string>;

export function isChromeKey(value: string): value is ChromeKey {
	return isDynamicChromeKey(value) || Object.hasOwn(CHROME_LABELS, value);
}
// The chrome that lives in the sidebar footer (NavUser), below the content
// sections. Everything else in CHROME_ORDER is header chrome, above the sections.
// The customize dialog uses this split to list rows top-to-bottom like the sidebar.
export const FOOTER_CHROME: ReadonlySet<ChromeKey> = new Set([
	"inbox",
	"announcements",
	"user",
	"downloads",
	"settings",
]);

// The header chrome rendered as a vertical stack of nav buttons, below the
// logo + node-selector row. These reorder *among themselves* (drag, the
// per-button menu, or the customize dialog) — never into the content sections
// below, since they ride a separate drag state. The logo + node-selector row
// stays fixed (it is a horizontal row, not a stacked button).
export const HEADER_BUTTON_CHROME: ChromeKey[] = [
	// "home" is represented by the owning app's Apps-shelf tile.
	"new-chat",
	"compute",
	"share",
	"store",
	"library",
	// "memory" is represented by the owning app's Apps-shelf tile.
];

// Header buttons held behind the `ui.compute_share` rollout flag.
export const COMPUTE_SHARE_CHROME: ReadonlySet<ChromeKey> = new Set([
	"compute",
	"share",
]);

// Distinct drag-data format for reordering header buttons, so a button drag is
// never confused with the section-reorder drag ("text/plain") or the agent drag.
export const CHROME_DND_FORMAT = "application/x-ryu-chrome";

/** A dynamic app-registered chrome-button key (`plugin:<pluginId>:<buttonId>`). */
export function isDynamicChromeKey(value: string): value is DynamicChromeKey {
	return value.startsWith("plugin:");
}

export function isHeaderButtonChrome(value: string): value is ChromeKey {
	// Accept dynamic `plugin:` keys too, so a persisted order keeps an app's button
	// in place across reloads (it renders nothing when that app is disabled/absent).
	return (
		isDynamicChromeKey(value) ||
		HEADER_BUTTON_CHROME.some((key) => key === value)
	);
}

// Reconcile a stored header-button order against the code, mirroring
// loadSectionOrder: keep known keys in their stored order, drop unknown ones,
// and splice any never-seen button back beside its default neighbour.
export function loadChromeOrder(): ChromeKey[] {
	try {
		const stored = localStorage.getItem(CHROME_ORDER_KEY);
		if (!stored) {
			return [...HEADER_BUTTON_CHROME];
		}
		const parsed = z.array(z.string()).parse(JSON.parse(stored));
		const order = [...new Set(parsed.filter(isHeaderButtonChrome))];
		const missing = HEADER_BUTTON_CHROME.filter((k) => !order.includes(k));
		for (const key of missing) {
			const defaultIdx = HEADER_BUTTON_CHROME.indexOf(key);
			let insertAt = 0;
			for (let i = defaultIdx - 1; i >= 0; i--) {
				const idx = order.indexOf(HEADER_BUTTON_CHROME[i]);
				if (idx !== -1) {
					insertAt = idx + 1;
					break;
				}
			}
			order.splice(insertAt, 0, key);
		}
		return order;
	} catch {
		return [...HEADER_BUTTON_CHROME];
	}
}

export function saveChromeOrder(order: ChromeKey[]) {
	try {
		localStorage.setItem(CHROME_ORDER_KEY, JSON.stringify(order));
	} catch {
		// best-effort
	}
}
