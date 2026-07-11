/* @jsxImportSource @opentui/react */
// Sidebar - the desktop AppSidebar analog, three zones:
//   (a) HEADER  - a node selector (folds src/core/nodes.ts, replacing the old
//       Ctrl+N picker, with a health dot) + a nav-button cluster: Home, New chat,
//       Search (Ctrl+K), Library, Customize, Tasks, Timeline.
//   (b) CONTENT - collapsible live-data sections in desktop order (agents, teams,
//       spaces, meetings, workflows, pinned, projects, chats, archived), each with
//       a "+" create action. Data is loaded in the foundation via useSidebarData.
//   (c) FOOTER  - NavUser: account row + Inbox, Downloads, Settings gear.
//
// Activation is by mouse (OpenTUI onMouseDown): a nav button or section item
// calls openTab(path); Search opens the palette; Settings opens the overlay. The
// active tab's path is highlighted. Sections manage their own collapsed state.
//
// biome-ignore-all lint/a11y/noStaticElementInteractions: OpenTUI renders to a
// terminal, not the DOM - its box/text elements have no ARIA roles, so mouse
// handlers on them are the only interaction primitive available.
// biome-ignore-all lint/a11y/useKeyWithClickEvents: keyboard navigation is owned
// centrally by the shell/surfaces (see App.tsx), not per sidebar element.

import { useEffect, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../core/CoreContext.tsx";
import { healthCheck } from "../core/nodes.ts";
import { useOverlay } from "../overlays/OverlayHost.tsx";
import { useWorkspace } from "../workspace/WorkspaceContext.tsx";
import type { ProjectGroup, SidebarData, SidebarItem } from "./data.ts";
import { useSidebarData } from "./useSidebarData.ts";

const SIDEBAR_WIDTH = 24;
const PROTOCOL_RE = /^https?:\/\//;

interface NavEntry {
	key: string;
	label: string;
	onSelect: () => void;
	path?: string;
}

interface SectionSpec {
	createPath: string;
	items: SidebarItem[];
	key: string;
	title: string;
}

export function Sidebar({
	onSwitchNode,
	onOpenPalette,
}: {
	onOpenPalette: () => void;
	onSwitchNode: () => void;
}) {
	const theme = useTheme();
	const { data } = useSidebarData();

	return (
		<box
			backgroundColor={theme.colors.muted}
			flexDirection="column"
			paddingLeft={1}
			paddingRight={1}
			width={SIDEBAR_WIDTH}
		>
			<NodeSelector onSwitchNode={onSwitchNode} />
			<NavCluster onOpenPalette={onOpenPalette} />
			<SectionList data={data} />
			<NavUser />
		</box>
	);
}

function NodeSelector({ onSwitchNode }: { onSwitchNode: () => void }) {
	const theme = useTheme();
	const { target, url } = useCore();
	const [reachable, setReachable] = useState<boolean | undefined>(undefined);

	useEffect(() => {
		let cancelled = false;
		healthCheck(target)
			.then((ok) => {
				if (!cancelled) {
					setReachable(ok);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [target]);

	let dot = "·";
	let dotColor = theme.colors.mutedForeground;
	if (reachable === true) {
		dot = "●";
		dotColor = theme.colors.success;
	} else if (reachable === false) {
		dot = "○";
		dotColor = theme.colors.error;
	}
	const label = url.replace(PROTOCOL_RE, "");

	return (
		<box
			borderColor={theme.colors.border}
			borderStyle="rounded"
			flexDirection="row"
			flexShrink={0}
			gap={1}
			onMouseDown={onSwitchNode}
			paddingLeft={1}
			paddingRight={1}
		>
			<text fg={dotColor}>{dot}</text>
			<text fg={theme.colors.foreground}>{label}</text>
		</box>
	);
}

function NavCluster({ onOpenPalette }: { onOpenPalette: () => void }) {
	const { openTab } = useWorkspace();
	const entries: NavEntry[] = [
		{
			key: "home",
			label: "Home",
			path: "/home",
			onSelect: () => openTab("/home"),
		},
		{
			key: "new-chat",
			label: "New chat",
			path: "/chat",
			onSelect: () => openTab("/chat", { forceNew: true }),
		},
		{
			key: "search",
			label: "Search (Ctrl+K)",
			onSelect: onOpenPalette,
		},
		{
			key: "library",
			label: "Library",
			path: "/library",
			onSelect: () => openTab("/library"),
		},
		{
			key: "store",
			label: "Customize",
			path: "/store",
			onSelect: () => openTab("/store"),
		},
		{
			key: "tasks",
			label: "Tasks",
			path: "/tasks",
			onSelect: () => openTab("/tasks"),
		},
		{
			key: "timeline",
			label: "Timeline",
			path: "/timeline",
			onSelect: () => openTab("/timeline"),
		},
	];
	return (
		<box flexDirection="column" flexShrink={0} paddingTop={1}>
			{entries.map((entry) => (
				<NavButton entry={entry} key={entry.key} />
			))}
		</box>
	);
}

function NavButton({ entry }: { entry: NavEntry }) {
	const theme = useTheme();
	const { tabs, panes, focusedPaneId } = useWorkspace();
	const focusedPane = panes.find((pane) => pane.id === focusedPaneId);
	const activePath = tabs.find(
		(tab) => tab.id === focusedPane?.activeTabId
	)?.path;
	const active = entry.path !== undefined && entry.path === activePath;
	return (
		<box flexDirection="row" gap={1} onMouseDown={entry.onSelect}>
			<text fg={active ? theme.colors.primary : theme.colors.mutedForeground}>
				{active ? "›" : " "}
			</text>
			<text fg={active ? theme.colors.primary : theme.colors.foreground}>
				{entry.label}
			</text>
		</box>
	);
}

function SectionList({ data }: { data: SidebarData }) {
	const sections: SectionSpec[] = [
		{
			key: "agents",
			title: "Agents",
			createPath: "/agents",
			items: data.agents,
		},
		{ key: "teams", title: "Teams", createPath: "/teams", items: data.teams },
		{
			key: "spaces",
			title: "Spaces",
			createPath: "/spaces",
			items: data.spaces,
		},
		{
			key: "meetings",
			title: "Meetings",
			createPath: "/meetings",
			items: data.meetings,
		},
		{
			key: "workflows",
			title: "Workflows",
			createPath: "/workflows",
			items: data.workflows,
		},
		{ key: "pinned", title: "Pinned", createPath: "/chat", items: data.pinned },
	];
	return (
		<scrollbox flexGrow={1} paddingTop={1}>
			{sections.map((section) => (
				<SidebarSection key={section.key} section={section} />
			))}
			<ProjectsSection projects={data.projects} />
			<SidebarSection
				section={{
					key: "chats",
					title: "Chats",
					createPath: "/chat",
					items: data.chats,
				}}
			/>
			<SidebarSection
				section={{
					key: "archived",
					title: "Archived",
					createPath: "/chat",
					items: data.archived,
				}}
			/>
		</scrollbox>
	);
}

function SidebarSection({ section }: { section: SectionSpec }) {
	const theme = useTheme();
	const { openTab } = useWorkspace();
	const [collapsed, setCollapsed] = useState(false);
	return (
		<box flexDirection="column" paddingTop={1}>
			<box flexDirection="row" gap={1} justifyContent="space-between">
				<box
					flexDirection="row"
					gap={1}
					onMouseDown={() => setCollapsed((value) => !value)}
				>
					<text fg={theme.colors.mutedForeground}>{collapsed ? "▸" : "▾"}</text>
					<text fg={theme.colors.mutedForeground}>
						{section.title.toUpperCase()}
					</text>
					<text fg={theme.colors.muted}>{section.items.length}</text>
				</box>
				<text
					fg={theme.colors.mutedForeground}
					onMouseDown={() => openTab(section.createPath)}
				>
					+
				</text>
			</box>
			{collapsed ? null : <SectionItems items={section.items} />}
		</box>
	);
}

function SectionItems({ items }: { items: SidebarItem[] }) {
	const theme = useTheme();
	const { openTab } = useWorkspace();
	if (items.length === 0) {
		return <text fg={theme.colors.muted}>empty</text>;
	}
	return (
		<box flexDirection="column">
			{items.slice(0, 8).map((item) => (
				<box
					flexDirection="row"
					gap={1}
					key={item.id}
					onMouseDown={() => openTab(item.path)}
				>
					<text fg={theme.colors.foreground}>{item.label}</text>
					{item.badge ? (
						<text fg={theme.colors.muted}>{item.badge}</text>
					) : null}
				</box>
			))}
		</box>
	);
}

function ProjectsSection({ projects }: { projects: ProjectGroup[] }) {
	const theme = useTheme();
	const { openTab } = useWorkspace();
	const [collapsed, setCollapsed] = useState(false);
	return (
		<box flexDirection="column" paddingTop={1}>
			<box
				flexDirection="row"
				gap={1}
				onMouseDown={() => setCollapsed((value) => !value)}
			>
				<text fg={theme.colors.mutedForeground}>{collapsed ? "▸" : "▾"}</text>
				<text fg={theme.colors.mutedForeground}>PROJECTS</text>
				<text fg={theme.colors.muted}>{projects.length}</text>
			</box>
			{collapsed ? null : (
				<box flexDirection="column">
					{projects.length === 0 ? (
						<text fg={theme.colors.muted}>empty</text>
					) : (
						projects.map((project) => (
							<box flexDirection="column" key={project.id} paddingLeft={1}>
								<text fg={theme.colors.accent}>{project.name}</text>
								{project.chats.slice(0, 5).map((chat) => (
									<box
										flexDirection="row"
										key={chat.id}
										onMouseDown={() => openTab(chat.path)}
										paddingLeft={1}
									>
										<text fg={theme.colors.foreground}>{chat.label}</text>
									</box>
								))}
							</box>
						))
					)}
				</box>
			)}
		</box>
	);
}

function NavUser() {
	const theme = useTheme();
	const { openTab } = useWorkspace();
	const { openOverlay } = useOverlay();
	return (
		<box
			borderColor={theme.colors.border}
			borderStyle="single"
			flexDirection="column"
			flexShrink={0}
			paddingLeft={1}
			paddingRight={1}
		>
			<box
				flexDirection="row"
				gap={1}
				onMouseDown={() => openOverlay("settings")}
			>
				<text fg={theme.colors.accent}>◆</text>
				<text fg={theme.colors.foreground}>Account</text>
			</box>
			<box flexDirection="row" gap={2}>
				<text
					fg={theme.colors.mutedForeground}
					onMouseDown={() => openTab("/inbox")}
				>
					Inbox
				</text>
				<text
					fg={theme.colors.mutedForeground}
					onMouseDown={() => openTab("/downloads")}
				>
					Downloads
				</text>
				<text
					fg={theme.colors.mutedForeground}
					onMouseDown={() => openOverlay("settings")}
				>
					⚙
				</text>
			</box>
		</box>
	);
}
