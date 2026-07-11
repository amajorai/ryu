/* @jsxImportSource @opentui/react */
// CommandPalette - the Ctrl+K fuzzy jump-to palette (the desktop CommandPalette
// analog). Destinations mirror the desktop NAV_ITEMS (openTab), plus overlay
// entries (Gateway/Settings, reached by Channels/Identities/Credits aliases) and
// global actions (New chat, Switch node, Quit). Navigation destinations are
// merged with any surface registered in the router, and extra actions can be
// contributed via registerPaletteAction (the registration hook downstream code
// uses without editing this file).
//
// The shell owns the open/closed state (it binds Ctrl+K) and passes it in; the
// palette owns its query + selection and its keyboard (gated on `open`).

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useMemo, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useOverlay } from "../overlays/OverlayHost.tsx";
import { listSurfaces } from "../workspace/router.ts";
import { useWorkspace } from "../workspace/WorkspaceContext.tsx";

export interface PaletteAction {
	id: string;
	label: string;
	run: () => void;
}

// Module-level registry for extra palette actions (parity with router.ts). A
// downstream module calls registerPaletteAction(...) once at import time; the
// palette folds these in after the built-ins.
const extraActions: PaletteAction[] = [];

/** Contribute an extra action to the palette. Idempotent by id. */
export function registerPaletteAction(action: PaletteAction): void {
	if (!extraActions.some((existing) => existing.id === action.id)) {
		extraActions.push(action);
	}
}

const MAX_VISIBLE = 10;

// Desktop NAV_ITEMS: label -> path (openTab destinations).
const NAV_DESTINATIONS: { label: string; path: string }[] = [
	{ label: "Chat", path: "/chat" },
	{ label: "Agents", path: "/agents" },
	{ label: "Engines", path: "/engines" },
	{ label: "Models", path: "/models" },
	{ label: "Skills", path: "/skills" },
	{ label: "Spaces", path: "/spaces" },
	{ label: "Tools", path: "/tools" },
	{ label: "Workflows", path: "/workflows" },
	{ label: "Calendar", path: "/calendar" },
	{ label: "Timeline", path: "/timeline" },
	{ label: "Monitors", path: "/monitors" },
	{ label: "Tasks", path: "/tasks" },
	{ label: "Inbox", path: "/inbox" },
	{ label: "Meetings", path: "/meetings" },
];

export function CommandPalette({
	open,
	onClose,
	onSwitchNode,
	onQuit,
}: {
	onClose: () => void;
	onQuit: () => void;
	onSwitchNode: () => void;
	open: boolean;
}) {
	const theme = useTheme();
	const { openTab } = useWorkspace();
	const { openOverlay } = useOverlay();

	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);

	const entries = useMemo<PaletteAction[]>(() => {
		const close = onClose;
		const nav: PaletteAction[] = buildNavDestinations().map((dest) => ({
			id: `nav:${dest.path}`,
			label: `Go to ${dest.label}`,
			run: () => {
				openTab(dest.path);
				close();
			},
		}));
		const actions: PaletteAction[] = [
			{
				id: "action:new-chat",
				label: "New chat",
				run: () => {
					openTab("/chat", { forceNew: true });
					close();
				},
			},
			{
				id: "action:gateway",
				label: "Open Gateway (Channels, Identities)",
				run: () => {
					openOverlay("gateway");
					close();
				},
			},
			{
				id: "action:settings",
				label: "Open Settings (Credits)",
				run: () => {
					openOverlay("settings");
					close();
				},
			},
			{
				id: "action:node",
				label: "Switch node",
				run: () => {
					close();
					onSwitchNode();
				},
			},
			{
				id: "action:quit",
				label: "Quit",
				run: () => {
					close();
					onQuit();
				},
			},
			...extraActions.map((action) => ({
				...action,
				run: () => {
					close();
					action.run();
				},
			})),
		];
		const all = [...nav, ...actions];
		const q = query.trim().toLowerCase();
		if (q.length === 0) {
			return all;
		}
		return all.filter((entry) => entry.label.toLowerCase().includes(q));
	}, [query, openTab, openOverlay, onClose, onSwitchNode, onQuit]);

	const handleKey = (key: KeyEvent) => {
		if (key.name === "escape" || (key.ctrl && key.name === "k")) {
			onClose();
		} else if (key.name === "up") {
			setIndex((i) => Math.max(0, i - 1));
		} else if (key.name === "down") {
			setIndex((i) => Math.min(Math.max(0, entries.length - 1), i + 1));
		} else if (key.name === "return") {
			entries[index]?.run();
		} else if (key.name === "backspace") {
			setQuery((q) => q.slice(0, -1));
			setIndex(0);
		} else if (key.name.length === 1 && !(key.ctrl || key.meta)) {
			setQuery((q) => q + key.name);
			setIndex(0);
		}
	};

	useKeyboard((key) => {
		if (open) {
			handleKey(key);
		}
	});

	if (!open) {
		return null;
	}
	return (
		<box
			alignItems="center"
			height="100%"
			justifyContent="center"
			position="absolute"
			width="100%"
		>
			<box
				backgroundColor={theme.colors.background}
				borderColor={theme.colors.focusRing}
				borderStyle="rounded"
				flexDirection="column"
				minWidth={48}
				padding={1}
			>
				<box flexDirection="row" gap={1} paddingBottom={1}>
					<text fg={theme.colors.primary}>{"›"}</text>
					<text
						fg={query ? theme.colors.foreground : theme.colors.mutedForeground}
					>
						{query || "Jump to…"}
					</text>
				</box>
				{entries.slice(0, MAX_VISIBLE).map((entry, i) => (
					<box flexDirection="row" gap={1} key={entry.id}>
						<text fg={i === index ? theme.colors.primary : theme.colors.muted}>
							{i === index ? "›" : " "}
						</text>
						<text
							fg={i === index ? theme.colors.primary : theme.colors.foreground}
						>
							{entry.label}
						</text>
					</box>
				))}
				{entries.length === 0 ? (
					<text fg={theme.colors.mutedForeground}>No matches</text>
				) : null}
			</box>
		</box>
	);
}

// Merge the static NAV_DESTINATIONS with any registered surface path that is not
// already listed, so newly registered surfaces are reachable from the palette
// without editing this file.
function buildNavDestinations(): { label: string; path: string }[] {
	const known = new Set(NAV_DESTINATIONS.map((dest) => dest.path));
	const extra: { label: string; path: string }[] = [];
	for (const surface of listSurfaces()) {
		const path = `/${surface.id}`;
		// Only fold in a surface whose id-path is one it actually owns; deep-link
		// aliases (e.g. store-models owns /models, not /store-models) are already
		// covered by the static NAV_DESTINATIONS and would otherwise 404.
		if (!known.has(path) && surface.match(path)) {
			extra.push({ label: surface.title, path });
		}
	}
	return [...NAV_DESTINATIONS, ...extra];
}
