/* @jsxImportSource @opentui/react */
// TabStrip - the top titlebar strip of open tabs (the desktop TitleBar analog).
// Renders each pane's tabs left to right; pinned tabs lead as compact glyph
// chips, the active tab of each pane is highlighted, and when a split is open the
// two panes are separated by a bracket so the grouping is visible. Pure
// presentation over the workspace model - no keyboard of its own.

import { useTheme } from "@/components/ui/theme-provider.tsx";
import { type Pane, type Tab, useWorkspace } from "./WorkspaceContext.tsx";

const PIN_GLYPH = "*";

export function TabStrip() {
	const theme = useTheme();
	const { panes } = useWorkspace();
	return (
		<box
			backgroundColor={theme.colors.muted}
			flexDirection="row"
			gap={1}
			paddingLeft={1}
			paddingRight={1}
		>
			<text fg={theme.colors.primary}>
				<b>Ryu</b>
			</text>
			{panes.map((pane, i) => (
				<PaneTabs first={i === 0} key={pane.id} pane={pane} />
			))}
		</box>
	);
}

function PaneTabs({ pane, first }: { pane: Pane; first: boolean }) {
	const theme = useTheme();
	const { tabs, focusedPaneId } = useWorkspace();
	const paneFocused = pane.id === focusedPaneId;
	const paneTabs = pane.tabIds
		.map((id) => tabs.find((tab) => tab.id === id))
		.filter((tab): tab is Tab => tab !== undefined);

	return (
		<box flexDirection="row" gap={1}>
			{first ? null : <text fg={theme.colors.border}>{"⟦"}</text>}
			{paneTabs.map((tab) => (
				<TabChip
					active={tab.id === pane.activeTabId}
					key={tab.id}
					paneFocused={paneFocused}
					tab={tab}
				/>
			))}
			{first ? null : <text fg={theme.colors.border}>{"⟧"}</text>}
		</box>
	);
}

function TabChip({
	tab,
	active,
	paneFocused,
}: {
	active: boolean;
	paneFocused: boolean;
	tab: Tab;
}) {
	const theme = useTheme();
	const highlighted = active && paneFocused;
	let color = theme.colors.mutedForeground;
	if (highlighted) {
		color = theme.colors.primary;
	} else if (active) {
		color = theme.colors.foreground;
	}
	return (
		<box flexDirection="row" gap={0}>
			{tab.pinned ? <text fg={theme.colors.accent}>{PIN_GLYPH}</text> : null}
			<text fg={color}>{highlighted ? <b>{tab.title}</b> : tab.title}</text>
		</box>
	);
}
