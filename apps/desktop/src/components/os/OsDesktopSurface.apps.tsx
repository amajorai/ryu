import {
	type Chord,
	chordTokens,
	isMac,
	normalizeChord,
} from "@ryu/hotkeys/chord";
import AppIcon from "@ryu/marketplace/catalog/chrome/app-icon";
import { iconCacheKey } from "@ryu/marketplace/catalog/icon-cache";
import type { CardDither } from "@ryu/marketplace/catalog/types";
import type { AppIconPresentation } from "@ryu/ui/components/app-icon-artwork.tsx";
import type { ReactNode } from "react";

export type OsAppAction = "app-launcher" | "open-window";

export const APP_LAUNCHER_ID = "app-launcher";

export const APP_LAUNCHER_LABEL = "App Launcher";

/**
 * Ryu OS mounts no separate command palette (Layout leaves it out in OS mode),
 * so the App Launcher is the OS's search-everything surface and owns the
 * registry's palette action. Binding through @ryu/hotkeys keeps one dispatcher
 * and one owner per chord, and follows a rebind or clear in Keyboard Shortcuts.
 */
export const APP_LAUNCHER_HOTKEY_ID = "command-palette.toggle";

/** The launcher chord as the platform writes it (`⌘K`, `Ctrl+K`). */
export function launcherShortcutLabel(chord: Chord): string {
	const mac = isMac();
	return chordTokens(chord, mac).join(mac ? "" : "+");
}

/** The launcher chord in `aria-keyshortcuts` form, both platforms for `Mod`. */
export function launcherAriaKeyShortcuts(chord: Chord): string {
	const tokens = normalizeChord(chord).split("+");
	const spell = (mod: string) =>
		tokens
			.map((token) => {
				if (token === "Mod") {
					return mod;
				}
				return token === "Ctrl" ? "Control" : token;
			})
			.join("+");
	return tokens.includes("Mod")
		? `${spell("Control")} ${spell("Meta")}`
		: spell("Control");
}

export interface OsApp {
	action?: OsAppAction;
	cacheKey?: string | null;
	/** Launcher tab this app is filed under. */
	category?: string | null;
	description: string;
	iconBackground?: string | null;
	iconDither?: CardDither | null;
	iconId?: string | null;
	iconPadding?: string | null;
	iconUrl?: string | null;
	id: string;
	label: string;
	manifestId?: string;
	path: string;
}

export interface OsAppRecord {
	category?: string | null;
	companion?: { icon: string | null } | null;
	icon: string | null;
	iconBackground: string | null;
	iconDither: CardDither | null;
	iconPadding: string | null;
	iconUrl: string | null;
	id: string;
	installed: boolean;
	installedVersion: string | null;
	version: string;
}

export interface OsWindow {
	content: ReactNode;
	id: string;
	path: string;
	title: string;
}

export interface OsDesktopSurfaceProps {
	activeWindowId: string;
	appRecords?: readonly OsAppRecord[];
	canSwitchToConsole?: boolean;
	/** Enabled app companions from the live contributions feed. Shell-owned pages
	 * remain in {@link OS_APPS}; these entries keep the launcher current as apps add
	 * their own full-page surfaces. */
	contributedApps?: readonly OsApp[];
	/** Account, availability, notifications, and downloads in the OS menu bar. */
	menubarActions?: ReactNode;
	onActivateWindow: (id: string) => void;
	onCloseWindow: (id: string) => void;
	onOpenApp: (app: OsApp) => void;
	windows: OsWindow[];
}

/** The first-party surfaces that make the OS dock useful on first launch. */
export const OS_APPS: readonly OsApp[] = [
	{
		action: "app-launcher",
		description: "Browse current Apps or jump between live workspace windows.",
		iconId: "dashboard-square-01",
		id: APP_LAUNCHER_ID,
		label: APP_LAUNCHER_LABEL,
		path: "/app-launcher",
	},
	{
		description: "Review what every chat did, and what is still open.",
		iconId: "radar-01",
		category: "Agents",
		id: "mission-control",
		label: "Mission Control",
		manifestId: "@ryu/mission-control",
		path: "/mission-control",
	},
	{
		description: "Ask an agent and keep the conversation live.",
		iconId: "chat-01",
		category: "Agents",
		id: "chat",
		label: "Chat",
		path: "/chat",
	},
	{
		description: "Organize knowledge, files, and working context.",
		iconId: "delivery-secure-01",
		category: "Knowledge",
		id: "spaces",
		label: "Spaces",
		manifestId: "@ryu/spaces",
		path: "/library/space",
	},
	{
		description: "Browse and test the tools Ryu can call.",
		iconId: "wrench-01",
		category: "Build",
		id: "tools",
		label: "Tools",
		path: "/tools",
	},
	{
		description: "Keep reusable agent instructions close at hand.",
		iconId: "potion",
		category: "Knowledge",
		id: "skills",
		label: "Skills",
		manifestId: "@ryu/skills",
		path: "/skills",
	},
	{
		description: "Install and manage Ryu Apps and capabilities.",
		iconId: "package-01",
		category: "Build",
		id: "apps",
		label: "Apps",
		path: "/store/apps",
	},
	{
		description: "Review outcomes and decide what happens next.",
		iconId: "pie-chart",
		category: "Agents",
		id: "review",
		label: "Review",
		path: "/review",
	},
];

export function resolveOsApp(
	app: OsApp,
	appRecords: readonly OsAppRecord[]
): OsApp {
	if (!app.manifestId) {
		return app;
	}
	const record = appRecords.find(
		(candidate) => candidate.id === app.manifestId
	);
	if (!record) {
		return app;
	}
	return {
		...app,
		category: app.category ?? record.category,
		cacheKey: record.installed
			? iconCacheKey(record.id, record.installedVersion ?? record.version)
			: null,
		iconBackground: record.iconBackground,
		iconDither: record.iconDither,
		iconId: record.icon ?? record.companion?.icon ?? app.iconId,
		iconPadding: record.iconPadding,
		iconUrl: record.iconUrl,
	};
}

export function appForWindow(
	path: string,
	apps: readonly OsApp[]
): OsApp | undefined {
	return apps.find((app) => path === app.path);
}

export function OsAppIcon({
	app,
	className,
	presentation = "os-default",
	size = 18,
}: {
	app: OsApp;
	className?: string;
	presentation?: AppIconPresentation;
	size?: number;
}) {
	return (
		<AppIcon
			cacheKey={app.cacheKey}
			className={className}
			dither={app.iconDither}
			iconBackground={app.iconBackground}
			iconId={app.iconId}
			iconPadding={app.iconPadding}
			iconUrl={app.iconUrl}
			name={app.label}
			presentation={presentation}
			seedId={app.manifestId ?? app.id}
			seedPlate
			size={size}
		/>
	);
}

export const OTHER_CATEGORY = "Apps";

export const ALL_CATEGORIES = "All";

export function titleCase(value: string): string {
	return value
		.split(/[\s_-]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

/** The launcher tab an app is filed under; uncategorized apps land in "Apps". */
export function osAppCategory(app: OsApp): string {
	const category = app.category?.trim();
	return category ? titleCase(category) : OTHER_CATEGORY;
}

/** Category tabs in first-seen order, so the shell's own groups lead. */
export function osAppCategories(apps: readonly OsApp[]): string[] {
	return [...new Set(apps.map(osAppCategory))];
}
