/* @jsxImportSource @opentui/react */
// NodePicker - the shell's node-switch overlay (ported from the legacy App). It
// replaces the old Ctrl+N picker; it is opened from the sidebar node selector and
// the command palette "Switch node" action. Presentational only - the shell owns
// its keyboard (↑/↓ move, Enter switch, Esc close) so overlay suppression stays
// centralized.

import { useTheme } from "@/components/ui/theme-provider.tsx";
import type { Node } from "../core/nodes.ts";

function NodeRow({
	node,
	selected,
	reachable,
	isActive,
}: {
	isActive: boolean;
	node: Node;
	reachable: boolean | undefined;
	selected: boolean;
}) {
	const theme = useTheme();
	let dot = "·";
	let dotColor = theme.colors.mutedForeground;
	if (reachable === true) {
		dot = "●";
		dotColor = theme.colors.success;
	} else if (reachable === false) {
		dot = "○";
		dotColor = theme.colors.error;
	}
	return (
		<box flexDirection="row" gap={1}>
			<text fg={selected ? theme.colors.primary : theme.colors.muted}>
				{selected ? "›" : " "}
			</text>
			<text fg={dotColor}>{dot}</text>
			<text fg={selected ? theme.colors.primary : theme.colors.foreground}>
				{node.name}
			</text>
			<text fg={theme.colors.mutedForeground}>{node.url}</text>
			{node.token ? (
				<text fg={theme.colors.mutedForeground}>[token]</text>
			) : null}
			{isActive ? <text fg={theme.colors.success}>{"<active>"}</text> : null}
		</box>
	);
}

export function NodePicker({
	nodes,
	index,
	health,
	currentUrl,
}: {
	currentUrl: string;
	health: Record<string, boolean>;
	index: number;
	nodes: Node[];
}) {
	const theme = useTheme();
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
				minWidth={40}
				padding={1}
			>
				<box paddingBottom={1}>
					<text fg={theme.colors.primary}>
						<b>Switch node</b>
					</text>
				</box>
				{nodes.length === 0 ? (
					<text fg={theme.colors.mutedForeground}>No nodes configured</text>
				) : (
					nodes.map((node, i) => (
						<NodeRow
							isActive={node.url === currentUrl}
							key={node.name}
							node={node}
							reachable={health[node.name]}
							selected={i === index}
						/>
					))
				)}
				<box paddingTop={1}>
					<text fg={theme.colors.mutedForeground}>
						↑/↓ move · Enter switch · Esc close
					</text>
				</box>
			</box>
		</box>
	);
}
