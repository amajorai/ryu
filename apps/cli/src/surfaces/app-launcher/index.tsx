/* @jsxImportSource @opentui/react */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { type AppInfo, fetchApps } from "@ryuhq/core-client/plugins";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useContributions } from "../../core/ContributionsContext.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import {
	type ContributedView,
	pluginViewPath,
} from "../../core/contributions.ts";
import {
	useSetInputFocused,
	useShellKeyboardCaptured,
} from "../../core/InputFocusContext.tsx";
import { tf, tr } from "../../i18n/translate.ts";
import { useOverlay } from "../../overlays/OverlayHost.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";

interface LauncherAction {
	description: string;
	id: string;
	label: string;
	path: string;
	source: "app" | "surface";
}

interface BuiltInShortcut {
	description: string;
	label: string;
	path: string;
}

const BUILT_IN_SHORTCUTS: readonly BuiltInShortcut[] = [
	{ description: "Core and Gateway status", label: "Home", path: "/home" },
	{ description: "Managed and local agent chat", label: "Chat", path: "/chat" },
	{ description: "Agents and agent setup", label: "Agents", path: "/agents" },
	{
		description: "Browse and manage Plugins and Sidecars.",
		label: "Plugins & Sidecars",
		path: "/store",
	},
	{ description: "Models and engines", label: "Models", path: "/models" },
	{ description: "Ryu Spaces", label: "Spaces", path: "/spaces" },
	{ description: "Skills and tools", label: "Tools", path: "/tools" },
	{
		description: "Workflows and schedules",
		label: "Workflows",
		path: "/workflows",
	},
	{ description: "Tasks and calendar", label: "Tasks", path: "/tasks" },
	{ description: "Meetings and inbox", label: "Meetings", path: "/meetings" },
];

interface AppLauncherActions {
	actions: LauncherAction[];
	desktopOnlyApps: string[];
}

interface AppLauncherWindow<T> {
	items: T[];
	selectedIndex: number;
	start: number;
}

export function buildAppLauncherActions(
	apps: readonly AppInfo[],
	views: readonly ContributedView[]
): AppLauncherActions {
	const appById = new Map(
		apps
			.filter((app) => app.installed && app.enabled)
			.map((app) => [app.id, app])
	);
	const actions: LauncherAction[] = BUILT_IN_SHORTCUTS.map((surface) => ({
		...surface,
		id: `surface:${surface.path}`,
		source: "surface",
	}));
	const openableApps = new Set<string>();
	for (const view of views) {
		const app = appById.get(view.plugin);
		if (!(app && view.id && view.plugin)) {
			continue;
		}
		openableApps.add(app.id);
		actions.push({
			description:
				view.title ?? tf("{appName} contributed view", { appName: app.name }),
			id: `app:${app.id}:${view.id}`,
			label: view.title ?? app.companion?.label ?? app.name,
			path: pluginViewPath(app.id, view.id),
			source: "app",
		});
	}
	const desktopOnlyApps = [...appById.values()]
		.filter((app) => !openableApps.has(app.id))
		.map((app) => app.companion?.label ?? app.name)
		.sort((left, right) => left.localeCompare(right));
	return {
		actions: actions.sort((left, right) => {
			if (left.source !== right.source) {
				return left.source === "surface" ? -1 : 1;
			}
			return left.label.localeCompare(right.label);
		}),
		desktopOnlyApps,
	};
}

export function appLauncherVisibleWindow<T>(
	items: readonly T[],
	index: number,
	limit = 12
): AppLauncherWindow<T> {
	if (items.length === 0 || limit <= 0) {
		return { items: [], start: 0, selectedIndex: 0 };
	}
	const selectedIndex = Math.min(Math.max(0, index), items.length - 1);
	const start = Math.min(
		Math.max(0, selectedIndex - limit + 1),
		Math.max(0, items.length - limit)
	);
	return {
		items: items.slice(start, start + limit),
		start,
		selectedIndex,
	};
}

function AppLauncherSurface({ active, paneId }: SurfaceProps) {
	const { target, url, token } = useCore();
	const theme = useTheme();
	const { focusedPaneId, openTab } = useWorkspace();
	const { views } = useContributions();
	const shellKeyboardCaptured = useShellKeyboardCaptured();
	const { openId: overlayOpenId } = useOverlay();
	const targetKey = JSON.stringify([
		url,
		token ?? null,
		target.userJwt ?? null,
	]);
	const [catalog, setCatalog] = useState<{
		apps: AppInfo[];
		targetKey: string;
	}>({ apps: [], targetKey: "" });
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);
	const reqRef = useRef(0);
	const targetKeyRef = useRef(targetKey);
	// Fence the render and old completions before the new target's effect runs.
	// Advancing the request identity also prevents an A → B → A response race.
	if (targetKeyRef.current !== targetKey) {
		targetKeyRef.current = targetKey;
		reqRef.current += 1;
	}
	const apps =
		catalog.targetKey === targetKey && !loading && !error ? catalog.apps : [];
	const focused = active && focusedPaneId === paneId;

	const reload = useCallback(() => {
		const requestId = ++reqRef.current;
		setLoading(true);
		setError(null);
		setCatalog({ apps: [], targetKey });
		const currentRequest = () =>
			reqRef.current === requestId && targetKeyRef.current === targetKey;
		fetchApps(target)
			.then((next) => {
				if (!currentRequest()) {
					return;
				}
				setCatalog({ apps: next, targetKey });
				setIndex(0);
			})
			.catch((cause) => {
				if (currentRequest()) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			})
			.finally(() => {
				if (currentRequest()) {
					setLoading(false);
				}
			});
	}, [target, targetKey]);

	// Type-to-filter owns plain characters while focused, so the shell's bare
	// "?" shortcuts key stays quiet here.
	const setInputFocused = useSetInputFocused();
	useEffect(() => {
		setInputFocused(focused && !shellKeyboardCaptured && !overlayOpenId);
		return () => setInputFocused(false);
	}, [focused, overlayOpenId, setInputFocused, shellKeyboardCaptured]);

	useEffect(() => {
		if (active) {
			reload();
		}
		return () => {
			reqRef.current += 1;
		};
	}, [active, reload, url, token]);

	const { actions, desktopOnlyApps } = useMemo(
		() => buildAppLauncherActions(apps, views),
		[apps, views]
	);
	const visible = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return needle
			? actions.filter(
					(action) =>
						action.label.toLowerCase().includes(needle) ||
						action.description.toLowerCase().includes(needle)
				)
			: actions;
	}, [actions, query]);
	const windowed = useMemo(
		() => appLauncherVisibleWindow(visible, index),
		[index, visible]
	);

	useKeyboard((key: KeyEvent) => {
		if (!focused || shellKeyboardCaptured || overlayOpenId) {
			return;
		}
		if (key.name === "r") {
			reload();
		} else if (key.name === "up" || key.name === "k") {
			setIndex((current) => Math.max(0, current - 1));
		} else if (key.name === "down" || key.name === "j") {
			setIndex((current) =>
				Math.min(Math.max(0, visible.length - 1), current + 1)
			);
		} else if (key.name === "return") {
			const action = visible[windowed.selectedIndex];
			if (action) {
				openTab(action.path);
			}
		} else if (key.name === "backspace") {
			setQuery((current) => current.slice(0, -1));
			setIndex(0);
		} else if (key.name.length === 1 && !(key.ctrl || key.meta)) {
			setQuery((current) => current + key.name);
			setIndex(0);
		}
	});

	return (
		<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
			<text fg={theme.colors.primary}>
				<b>App Launcher</b>
			</text>
			<text fg={theme.colors.mutedForeground}>
				Current CLI surfaces and enabled Apps with terminal-renderable views.
			</text>
			<text fg={query ? theme.colors.foreground : theme.colors.mutedForeground}>
				{tf("Search: {query}", { query: query || tr("type to filter") })}
			</text>
			{loading ? (
				<text fg={theme.colors.mutedForeground}>Loading Apps…</text>
			) : null}
			{error ? (
				<text fg={theme.colors.error}>Core Apps unavailable · r retries</text>
			) : null}
			<box flexDirection="column" paddingTop={1}>
				{windowed.items.map((action, actionIndex) => {
					const selected =
						windowed.start + actionIndex === windowed.selectedIndex;
					return (
						<box flexDirection="row" gap={1} key={action.id}>
							<text
								fg={
									selected ? theme.colors.primary : theme.colors.mutedForeground
								}
							>
								{selected ? "›" : " "}
							</text>
							<text
								fg={selected ? theme.colors.primary : theme.colors.foreground}
							>
								{action.label}
							</text>
							<Badge
								bordered={false}
								variant={action.source === "app" ? "success" : "secondary"}
							>
								{action.source === "app" ? "App" : "CLI"}
							</Badge>
							<text fg={theme.colors.mutedForeground}>
								{action.description}
							</text>
						</box>
					);
				})}
				{visible.length === 0 ? (
					<text fg={theme.colors.mutedForeground}>
						No launchable views match.
					</text>
				) : null}
			</box>
			{desktopOnlyApps.length > 0 ? (
				<text fg={theme.colors.mutedForeground}>
					{tf("Desktop-only Apps: {apps}", {
						apps: desktopOnlyApps.join(", "),
					})}
				</text>
			) : null}
			<text fg={theme.colors.mutedForeground}>
				↑/↓ move · Enter open · r refresh · Desktop Dock and window controls are
				host-only.
			</text>
		</box>
	);
}

export const appLauncherSurface: SurfaceModule = {
	Component: AppLauncherSurface,
	id: "app-launcher",
	match: (path) => path === "/app-launcher",
	title: "App Launcher",
};
