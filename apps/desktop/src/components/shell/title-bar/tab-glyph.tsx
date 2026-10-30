import {
	Activity01Icon,
	AudioWave01Icon,
	Calendar04Icon,
	Chat01Icon,
	CheckmarkBadge02Icon,
	CpuIcon,
	DeliverySecure01Icon,
	Download01Icon,
	FingerPrintIcon,
	GitBranchIcon,
	InboxIcon,
	LibraryIcon,
	Message01Icon,
	PackageIcon,
	PieChartIcon,
	PotionIcon,
	Pulse01Icon,
	Settings01Icon,
	Share01Icon,
	ShieldKeyIcon,
	Target01Icon,
	Tv01Icon,
	WorkflowCircle06Icon,
	ZzzIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedString } from "@ryu/i18n/react";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { Logo as RyuLogo } from "@ryu/ui/components/logo.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useSyncExternalStore } from "react";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import type { ShellRoute, Tab } from "@/src/contexts/TabsContext.tsx";
import { shellRoute } from "@/src/contexts/TabsContext.tsx";
import {
	resolveTabIcon,
	subscribeTabIcons,
} from "@/src/contributions/tab-icon-registry.ts";

// Tab icons for the routes that are their own page — the glyph half of
// `PATH_TITLES` in TabsContext. The two multi-section shells (the Library and
// the Customize store) do NOT take their glyph from here: every route in a
// shell is one page, so `pathIcon` answers all of them from `SHELL_ICONS` below
// before this map is consulted. A per-section key added back would be dead for
// that route and would re-state the mistake it encodes — the shell's one name
// under a section's icon, the "keeps the sidebar entry's icon" half of the bug
// this seam closes.
//
// Some keys below are bare routes that are THEMSELVES shell routes. They are
// unreachable for their own path (the family branch answers first) and stay
// only for their DETAIL subpaths — separate pages that reach a glyph through
// `pathIcon`'s leading-segment fallback, so deleting the alias would silently
// drop every one of them to the chat icon. Exactly six such subpath families
// exist (`/agents/:id/edit`, `/channels/:id`, `/identities/profile/:id`,
// `/skills/:id/edit`, `/spaces/:id` + its doc/db/wb/app variants,
// `/workflows/:id`), so exactly six aliases are kept. The rest — `/apps`,
// `/engines`, `/extensions`, `/fleet`, `/models`, `/tools` — have no subpath
// route in `builtins.ts` and were deleted rather than left as rows nothing can
// read; re-add one only together with the route that reaches it.
// Each glyph mirrors the matching sidebar entry (AppSidebar's SECTION_ICONS +
// the NavTabButton chrome) so a page's tab and its sidebar row read as the same
// thing.
export const PATH_ICONS = new Map<string, IconSvgElement>([
	// No Home/dashboard entry: that page's path is declared by `@ryu/dashboards`
	// (`contributes.sidebar_buttons[].target`), and its tab icon comes from the same
	// contribution via `usePluginContributionTabIcons` — which `resolveTabIcon`
	// consults before this map. A path key here would go stale the moment the app
	// moved itself.
	["/chat", Chat01Icon],
	["/compute", CpuIcon],
	// Bare `/agents` is a Library route now (TabsContext's `LIBRARY_ALIAS_PATHS`),
	// so this row is read only for the agent routes UNDER it: the explicit
	// agent-edit branch in `pathIcon`, plus any other `/agents/*` deep link that
	// lands on the leading-segment fallback.
	["/agents", Target01Icon],
	["/channels", Tv01Icon],
	["/identities", FingerPrintIcon],
	["/identities/new", FingerPrintIcon],
	["/skills", PotionIcon],
	["/spaces", DeliverySecure01Icon],
	["/meetings", AudioWave01Icon],
	["/workflows", WorkflowCircle06Icon],
	["/workflows/build", WorkflowCircle06Icon],
	["/quests", CheckmarkBadge02Icon],
	["/timeline", Activity01Icon],
	["/review", PieChartIcon],
	["/activity", Pulse01Icon],
	["/calendar", Calendar04Icon],
	["/inbox", InboxIcon],
	["/approvals", InboxIcon],
	["/downloads", Download01Icon],
	["/project", GitBranchIcon],
	["/settings", Settings01Icon],
	["/share", Share01Icon],
	["/vault", ShieldKeyIcon],
]);

/** One glyph per multi-section shell, the exact counterpart of the one title
    `shellRoute` hands back. The Library book is the sidebar's own Library
    chrome; `PackageIcon` is the `store` NavTabButton's Customize glyph. Keyed
    off the SHELL, never the section, because a tab that names the page must not
    change its icon when the user switches section inside it. */
export const SHELL_ICONS = {
	library: LibraryIcon,
	store: PackageIcon,
} satisfies Record<ShellRoute["family"], IconSvgElement>;

export const AGENT_EDIT_PATH_RE = /^\/agents\/.+\/edit$/;

export function pathIcon(path: string): IconSvgElement {
	const base = path.split("?")[0];
	// Agent edit paths (/agents/:id/edit) share the agents icon.
	if (AGENT_EDIT_PATH_RE.test(base)) {
		return PATH_ICONS.get("/agents") ?? Target01Icon;
	}
	// A shell route takes its family's glyph, before any per-path lookup: every
	// section of the Library / the Customize store is the same page under the
	// same name, so it must also be the same icon. Keying the glyph on the
	// section instead is what let one tab read "Library" under a wrench, and —
	// since the tab now switches its own path as the user moves through the
	// family — made a single tab's glyph mutate while its name stood still.
	const shell = shellRoute(base);
	if (shell) {
		return SHELL_ICONS[shell.family];
	}
	// Exact route wins; otherwise fall back to the leading path segment so
	// detail subpaths (e.g. /spaces/:id, /workflows/:id) keep their page icon
	// instead of silently dropping to the chat fallback.
	const exact = PATH_ICONS.get(base);
	if (exact) {
		return exact;
	}
	const root = base.split("/").filter(Boolean)[0];
	return (root ? PATH_ICONS.get(`/${root}`) : undefined) ?? Message01Icon;
}

// The agent editor uses the static Ryu ghost logo instead of a HugeIcons glyph;
// every other tab keeps its path icon. Unloaded tabs always show Zzz regardless.
//
// Bare `/agents` is NOT one of them any more: it mounts the same LibraryPage
// section as `/library/agent`, so it is a Library route (TabsContext's
// `LIBRARY_ALIAS_PATHS`) and one tab now carries the whole family. Painting the
// ghost on it would make that single tab flicker logo↔book as the user switched
// section, under a name ("Library") that never changed.
export function isAgentsTab(path: string): boolean {
	return AGENT_EDIT_PATH_RE.test(path.split("?")[0]);
}

// Renders a tab's leading glyph: spinner while busy; an entity GlyphValue when
// set (chat / space / page / agent / meeting / plugin — same as the sidebar);
// else an app-registered Iconify/Hugeicons id from the tab-icon registry
// (manifest contributions + `shell.registerTabIcon`), UNLESS the tab sits on a
// shell route; else the static Ryu logo for the agent editor; else the path's
// Hugeicons icon (or Zzz when unloaded).
export function TabGlyph({
	path,
	icon,
	unloaded,
	busy,
	busySpeed,
	className,
	logoSize,
	presentation = "default",
}: {
	path: string;
	icon?: GlyphValue;
	unloaded?: boolean;
	busy?: boolean;
	busySpeed?: "slow" | "normal" | "fast";
	className?: string;
	logoSize: string;
	presentation?: "default" | "sidebar-tab";
}) {
	const inProgressLabel = useLocalizedString("In progress");
	// Re-render when apps register/unregister default path icons.
	useSyncExternalStore(
		subscribeTabIcons,
		() => resolveTabIcon(path) ?? "",
		() => ""
	);
	// A registered rule may NOT repaint a shell route: `resolveTabIcon` matches by
	// path PREFIX, and Core's own `builtin:spaces` rule (`pathPrefix: "/spaces"`)
	// therefore covers bare `/spaces` — a Library alias. Without this guard the
	// one Library tab would still swap its glyph book↔vault as the user moved
	// between the Spaces section and any other, under a name that never changes:
	// the section-keyed icon this seam removes, re-entering through the registry.
	// Only the exact shell routes are exempt; the DETAIL pages underneath
	// (`/spaces/:id`, a companion's own path) are separate pages and keep theirs.
	const registeredIcon = shellRoute(path) ? undefined : resolveTabIcon(path);

	if (busy && !unloaded) {
		return (
			<Spinner
				aria-label={inProgressLabel}
				className={className}
				presentation={presentation}
				speed={busySpeed}
			/>
		);
	}
	const glyphClassName = cn(
		className,
		presentation === "sidebar-tab" &&
			"transition-[opacity,scale] duration-150 group-hover/row:scale-50 group-hover/row:opacity-0 motion-reduce:transition-opacity"
	);
	if (!unloaded && icon) {
		const parsed = Number.parseInt(logoSize, 10);
		const px = Number.isNaN(parsed) ? 14 : parsed;
		return (
			<span
				className={cn(
					"inline-flex shrink-0 items-center justify-center",
					glyphClassName
				)}
			>
				<GlyphDisplay fallback={null} size={px} value={icon} />
			</span>
		);
	}
	if (!unloaded && registeredIcon) {
		const parsed = Number.parseInt(logoSize, 10);
		const px = Number.isNaN(parsed) ? 14 : parsed;
		return (
			<span
				className={cn(
					"inline-flex shrink-0 items-center justify-center",
					glyphClassName
				)}
			>
				<Icon className="size-full" icon={registeredIcon} size={px} />
			</span>
		);
	}
	if (!unloaded && isAgentsTab(path)) {
		return (
			<RyuLogo
				className={className}
				presentation={presentation}
				size={logoSize}
				variant="outline-static"
			/>
		);
	}
	return (
		<HugeiconsIcon
			className={glyphClassName}
			icon={unloaded ? ZzzIcon : pathIcon(path)}
		/>
	);
}

/** True when a chat tab should show the in-progress spinner/shimmer. */
export function useTabBusy(tab: Tab): boolean {
	const { getConversation } = useChatHistoryContext();
	if (tab.busy) {
		return true;
	}
	if (!(tab.path === "/chat" && tab.conversationId)) {
		return false;
	}
	return getConversation(tab.conversationId)?.runStatus === "running";
}
