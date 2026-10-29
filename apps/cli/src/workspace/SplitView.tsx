/* @jsxImportSource @opentui/react */
// SplitView - the center content region. Renders one pane full-width, or two
// panes side by side after splitActive(). Split panes use one quiet divider
// instead of individual frames; the tab strip marks the pane with keyboard focus.
//
// Layout contract: the row and each pane clip (minHeight 0 + overflow hidden) so
// a tall surface such as the chat composer can never push the shell taller than
// the terminal. The divider is a left-border box that stretches with the row, so
// it follows the flex height on resize instead of reading renderer.height.

import { Fragment } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { tf } from "../i18n/translate.ts";
import { resolveSurface } from "./router.ts";
import { type Pane, useWorkspace } from "./WorkspaceContext.tsx";

export function SplitView() {
	const theme = useTheme();
	const { focusedPaneId, panes } = useWorkspace();
	return (
		<box
			flexDirection="row"
			flexGrow={1}
			flexShrink={1}
			minHeight={0}
			overflow="hidden"
		>
			{panes.map((pane, index) => (
				<Fragment key={pane.id}>
					{index > 0 ? (
						<box
							border={["left"]}
							borderColor={
								pane.id === focusedPaneId
									? theme.colors.focusRing
									: theme.colors.border
							}
							flexShrink={0}
							marginRight={1}
							width={1}
						/>
					) : null}
					<PaneView pane={pane} />
				</Fragment>
			))}
		</box>
	);
}

function PaneView({ pane }: { pane: Pane }) {
	const theme = useTheme();
	const { tabs } = useWorkspace();
	const activeTab = tabs.find((tab) => tab.id === pane.activeTabId);
	const surface = activeTab ? resolveSurface(activeTab.path) : undefined;

	return (
		<box
			flexDirection="column"
			flexGrow={1}
			flexShrink={1}
			minHeight={0}
			overflow="hidden"
		>
			{surface && activeTab ? (
				<surface.Component active={true} paneId={pane.id} />
			) : (
				<box flexGrow={1} paddingLeft={1} paddingTop={1}>
					<text fg={theme.colors.mutedForeground}>
						{activeTab
							? tf("No surface registered for {path}", { path: activeTab.path })
							: "No open tab"}
					</text>
				</box>
			)}
		</box>
	);
}
