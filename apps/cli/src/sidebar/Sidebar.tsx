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
// Activation is by mouse release (useSelectionSafeActivate): a nav button or
// section item calls openTab(path); Search opens the palette; Settings opens the
// overlay. Sidebar text is not selectable, so a click over highlighted chat text
// only clears it, and a drag released over a row never navigates. The active
// tab's path is highlighted; a hovered row gets a hover background.
//
// Keyboard focus mode (F6 / Alt+0, owned by the shell in App.tsx): the shell
// passes `focused`, and this component walks the flat row list from
// buildSidebarRows (rows.ts) - ↑/↓ move, Enter activates (a section header
// folds instead), ←/→ fold and unfold the current section. Esc / F6 hand focus
// back through the shell. Section collapse state lives here, in one map, so the
// mouse and the keyboard fold the same sections. Labels are cut to the column
// with "…"; the node URL keeps its tail so the port stays readable.
//
// biome-ignore-all lint/a11y/noStaticElementInteractions: OpenTUI renders to a
// terminal, not the DOM - its box/text elements have no ARIA roles, so mouse
// handlers on them are the only interaction primitive available.
// biome-ignore-all lint/a11y/useKeyWithClickEvents: keyboard navigation runs
// through the sidebar's focus mode (one useKeyboard over the flat row list), not
// per sidebar element.

import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useContext, useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../core/CoreContext.tsx";
import { healthCheck } from "../core/nodes.ts";
import type { ProductMode } from "../core/productMode.ts";
import { useOverlay } from "../overlays/OverlayHost.tsx";
import { useSelectionSafeActivate } from "../ui/clipboard.ts";
import { useWorkspace } from "../workspace/WorkspaceContext.tsx";
import {
	buildSidebarRows,
	type CollapsedSections,
	LEADING_SECTIONS,
	navEntries,
	resolveCollapsed,
	type SectionKey,
	SIDEBAR_CONTENT_WIDTH,
	SIDEBAR_WIDTH,
	type SidebarRow,
	type SidebarRowActions,
	sidebarRowId,
	TRAILING_SECTIONS,
	truncateLabel,
	truncateStart,
} from "./rows.ts";
import { RowBox, SidebarFocusContext } from "./sidebar-row.tsx";
import { ProjectsSection, SidebarSection } from "./sidebar-sections.tsx";
import { useSidebarData } from "./useSidebarData.ts";

const PROTOCOL_RE = /^https?:\/\//;
/** Marker column plus its gap in front of nav labels ("› Home"). */
const MARKER_COLUMNS = 2;

/** The renderer id of the sidebar's root box, so the shell can tell a click
 * inside the sidebar from one in the pane. */
export const SIDEBAR_ROOT_ID = "sidebar";

export function Sidebar({
	modeLabel = "Agent",
	productMode = "console",
	onSwitchMode = () => undefined,
	onSwitchNode,
	onOpenPalette,
	focused = false,
	onReleaseFocus = () => undefined,
}: {
	/** Keyboard focus mode: the shell routes ↑/↓/Enter/←/→ here. */
	focused?: boolean;
	modeLabel?: string;
	onOpenPalette: () => void;
	/** Hands keyboard focus back to the workspace after a row activates. */
	onReleaseFocus?: () => void;
	onSwitchMode?: () => void;
	onSwitchNode: () => void;
	productMode?: ProductMode;
}) {
	const { data } = useSidebarData();
	const { openTab } = useWorkspace();
	const { openOverlay } = useOverlay();
	const [overrides, setOverrides] = useState<CollapsedSections>({});
	const [cursor, setCursor] = useState<string | null>(null);
	const scrollRef = useRef<ScrollBoxRenderable | null>(null);

	const collapsed = resolveCollapsed(data, overrides);
	const setSectionCollapsed = (section: SectionKey, value: boolean) =>
		setOverrides((previous) => ({ ...previous, [section]: value }));
	const actions: SidebarRowActions = {
		openPalette: onOpenPalette,
		openSettings: () => openOverlay("settings"),
		openTab: (path, options) => {
			openTab(path, options);
		},
		switchMode: onSwitchMode,
		switchNode: onSwitchNode,
		toggleSection: (section) =>
			setSectionCollapsed(section, !collapsed[section]),
	};
	const rows = buildSidebarRows(data, collapsed, productMode, actions);
	const focusIndex = Math.max(
		0,
		rows.findIndex((row) => row.key === cursor)
	);
	const focusKey = focused ? (rows[focusIndex]?.key ?? null) : null;
	const focusContext = { focusKey, release: onReleaseFocus };

	useEffect(() => {
		if (focusKey) {
			scrollRef.current?.scrollChildIntoView(sidebarRowId(focusKey));
		}
	}, [focusKey]);

	const activate = (row: SidebarRow) => {
		row.onSelect();
		if (!row.header) {
			onReleaseFocus();
		}
	};

	const handleKey = (key: KeyEvent) => {
		const row = rows[focusIndex];
		if (!row) {
			return;
		}
		const count = rows.length;
		if (key.name === "up" || key.name === "k") {
			setCursor(rows[(focusIndex - 1 + count) % count]?.key ?? null);
		} else if (key.name === "down" || key.name === "j") {
			setCursor(rows[(focusIndex + 1) % count]?.key ?? null);
		} else if (key.name === "return" || key.name === "space") {
			activate(row);
		} else if ((key.name === "left" || key.name === "h") && row.section) {
			setSectionCollapsed(row.section, true);
			setCursor(`section:${row.section}`);
		} else if (
			(key.name === "right" || key.name === "l") &&
			row.header &&
			row.section
		) {
			setSectionCollapsed(row.section, false);
		}
	};

	useKeyboard((key) => {
		if (focused && !(key.ctrl || key.meta || key.option)) {
			handleKey(key);
		}
	});

	if (productMode === "bot") {
		return (
			<SidebarFocusContext.Provider value={focusContext}>
				<box
					flexDirection="column"
					id={SIDEBAR_ROOT_ID}
					minHeight={0}
					overflow="hidden"
					paddingLeft={1}
					paddingRight={1}
					paddingTop={1}
					width={SIDEBAR_WIDTH}
				>
					<ModeSelector label={modeLabel} onSelect={onSwitchMode} />
					<BotNavCluster actions={actions} />
					<BotNavUser />
				</box>
			</SidebarFocusContext.Provider>
		);
	}

	return (
		<SidebarFocusContext.Provider value={focusContext}>
			<box
				flexDirection="column"
				id={SIDEBAR_ROOT_ID}
				minHeight={0}
				overflow="hidden"
				paddingLeft={1}
				paddingRight={1}
				paddingTop={1}
				width={SIDEBAR_WIDTH}
			>
				<NodeSelector onSwitchNode={onSwitchNode} />
				<ModeSelector label={modeLabel} onSelect={onSwitchMode} />
				<scrollbox
					flexGrow={1}
					flexShrink={1}
					horizontalScrollbarOptions={{ visible: false }}
					minHeight={0}
					ref={scrollRef}
					verticalScrollbarOptions={{ visible: false }}
				>
					{/* The only shrinking zone of the sidebar: it holds the nav cluster
					    and the sections, so the node selector and NavUser footer keep
					    their rows and, on a short terminal, every focusable row is still
					    reachable. It scrolls with the wheel and follows keyboard focus; a
					    drawn bar would only add thumb glyphs in the narrow column. */}
					<NavCluster actions={actions} />
					{LEADING_SECTIONS.map((section) => (
						<SidebarSection
							collapsed={collapsed[section.key]}
							items={data[section.key]}
							key={section.key}
							onToggle={actions.toggleSection}
							section={section}
						/>
					))}
					<ProjectsSection
						collapsed={collapsed.projects}
						onToggle={actions.toggleSection}
						projects={data.projects}
					/>
					{TRAILING_SECTIONS.map((section) => (
						<SidebarSection
							collapsed={collapsed[section.key]}
							items={data[section.key]}
							key={section.key}
							onToggle={actions.toggleSection}
							section={section}
						/>
					))}
				</scrollbox>
				<NavUser />
			</box>
		</SidebarFocusContext.Provider>
	);
}

function BotNavCluster({ actions }: { actions: SidebarRowActions }) {
	const entries = navEntries(actions).filter(
		(entry) => entry.key === "nav:new-chat" || entry.key === "nav:search"
	);
	return (
		<box flexDirection="column" flexShrink={0} paddingTop={1}>
			{entries.map((entry, index) => (
				<RowBox key={entry.key} onSelect={entry.onSelect} rowKey={entry.key}>
					{(tone) => (
						<>
							<text fg={tone()} selectable={false}>
								{index === 0 ? "›" : " "}
							</text>
							<text fg={tone()} selectable={false}>
								{entry.label}
							</text>
						</>
					)}
				</RowBox>
			))}
		</box>
	);
}

function BotNavUser() {
	const theme = useTheme();
	const { openOverlay } = useOverlay();
	return (
		<box flexDirection="column" flexShrink={0} paddingTop={1}>
			<RowBox onSelect={() => openOverlay("settings")} rowKey="footer:account">
				{(tone) => (
					<text fg={tone(theme.colors.accent)} selectable={false}>
						Account & Settings
					</text>
				)}
			</RowBox>
		</box>
	);
}

function ModeSelector({
	label,
	onSelect,
}: {
	label: string;
	onSelect: () => void;
}) {
	const theme = useTheme();
	return (
		<RowBox onSelect={onSelect} rowKey="mode">
			{(tone) => (
				<>
					<text fg={tone(theme.colors.accent)} selectable={false}>
						Ryu
					</text>
					<text fg={tone(theme.colors.mutedForeground)} selectable={false}>
						·
					</text>
					<text fg={tone(theme.colors.foreground)} selectable={false}>
						{label}
					</text>
					<text fg={tone(theme.colors.mutedForeground)} selectable={false}>
						⌄
					</text>
				</>
			)}
		</RowBox>
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
	// Dot, the chevron and their gaps take four columns; cut the host from the
	// front so the port stays visible.
	const label = truncateStart(
		url.replace(PROTOCOL_RE, ""),
		SIDEBAR_CONTENT_WIDTH - 4
	);

	return (
		<RowBox onSelect={onSwitchNode} rowKey="node">
			{(tone) => (
				<>
					<text fg={tone(dotColor)} selectable={false}>
						{dot}
					</text>
					<text fg={tone(theme.colors.foreground)} selectable={false}>
						{label}
					</text>
					<text fg={tone(theme.colors.mutedForeground)} selectable={false}>
						⌄
					</text>
				</>
			)}
		</RowBox>
	);
}

function NavCluster({ actions }: { actions: SidebarRowActions }) {
	return (
		<box flexDirection="column" flexShrink={0} paddingTop={1}>
			{navEntries(actions).map((entry) => (
				<NavButton entry={entry} key={entry.key} />
			))}
		</box>
	);
}

function NavButton({ entry }: { entry: SidebarRow & { path?: string } }) {
	const theme = useTheme();
	const { tabs, panes, focusedPaneId } = useWorkspace();
	const focusedPane = panes.find((pane) => pane.id === focusedPaneId);
	const activePath = tabs.find(
		(tab) => tab.id === focusedPane?.activeTabId
	)?.path;
	const active = entry.path !== undefined && entry.path === activePath;
	return (
		<RowBox onSelect={entry.onSelect} rowKey={entry.key}>
			{(tone, focused) => (
				<>
					<text
						fg={tone(
							active ? theme.colors.primary : theme.colors.mutedForeground
						)}
						selectable={false}
					>
						{active || focused ? "›" : " "}
					</text>
					<text
						fg={tone(active ? theme.colors.primary : theme.colors.foreground)}
						selectable={false}
					>
						{truncateLabel(entry.label, SIDEBAR_CONTENT_WIDTH - MARKER_COLUMNS)}
					</text>
				</>
			)}
		</RowBox>
	);
}

function NavUser() {
	const activate = useSelectionSafeActivate();
	const theme = useTheme();
	const { openTab } = useWorkspace();
	const { openOverlay } = useOverlay();
	const { release } = useContext(SidebarFocusContext);
	return (
		<box flexDirection="column" flexShrink={0} paddingTop={1}>
			<RowBox onSelect={() => openOverlay("settings")} rowKey="footer:account">
				{(tone) => (
					<>
						<text fg={tone(theme.colors.accent)} selectable={false}>
							◆
						</text>
						<text fg={tone(theme.colors.foreground)} selectable={false}>
							Account
						</text>
					</>
				)}
			</RowBox>
			<box flexDirection="row" gap={2}>
				<RowBox
					gap={0}
					onSelect={() => openTab("/inbox")}
					rowKey="footer:inbox"
				>
					{(tone) => (
						<text fg={tone(theme.colors.mutedForeground)} selectable={false}>
							Inbox
						</text>
					)}
				</RowBox>
				<RowBox
					gap={0}
					onSelect={() => openTab("/downloads")}
					rowKey="footer:downloads"
				>
					{(tone) => (
						<text fg={tone(theme.colors.mutedForeground)} selectable={false}>
							Downloads
						</text>
					)}
				</RowBox>
				<text
					fg={theme.colors.mutedForeground}
					{...activate(() => {
						openOverlay("settings");
						release();
					})}
					selectable={false}
				>
					⚙
				</text>
			</box>
		</box>
	);
}
