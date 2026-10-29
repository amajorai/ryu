/* @jsxImportSource @opentui/react */
// NodePicker - the shell's node-switch overlay (ported from the legacy App). It
// replaces the old Ctrl+N picker; it is opened from the sidebar node selector and
// the command palette "Switch node" action. Presentational only - the shell owns
// its keyboard (↑/↓ move, Enter switch, Esc close) so overlay suppression stays
// centralized. It renders through the shared Modal (backdrop click closes).

import { useTheme } from "@/components/ui/theme-provider.tsx";
import type { Node } from "../core/nodes.ts";
import { Modal, modalRowId } from "../ui/Modal.tsx";

const PANEL_WIDTH = 72;

type ManagedNodeState = "loading" | "ready" | "error";

function NodeRow({
	id,
	node,
	selected,
	reachable,
	isActive,
}: {
	id: string;
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
	// The selected row takes the shared selection fill (as in the palette and
	// lists); its text switches to the selection foreground to stay legible.
	const foreground = selected
		? theme.colors.selectionForeground
		: theme.colors.foreground;
	const muted = selected
		? theme.colors.selectionForeground
		: theme.colors.mutedForeground;
	return (
		<box
			backgroundColor={selected ? theme.colors.selection : undefined}
			flexDirection="row"
			gap={1}
			id={id}
		>
			<text fg={muted}>{selected ? "›" : " "}</text>
			<text fg={dotColor}>{dot}</text>
			<text fg={foreground}>{selected ? <b>{node.name}</b> : node.name}</text>
			{node.managed ? <text fg={theme.colors.accent}>[managed]</text> : null}
			<text fg={muted}>{node.url}</text>
			{node.token && !node.managed ? <text fg={muted}>[token]</text> : null}
			{isActive ? <text fg={theme.colors.success}>{"<active>"}</text> : null}
		</box>
	);
}

export function NodePicker({
	nodes,
	index,
	health,
	currentUrl,
	managedState,
	onClose,
}: {
	currentUrl: string;
	health: Record<string, boolean>;
	index: number;
	managedState: ManagedNodeState;
	nodes: Node[];
	/** Backdrop click; the shell still owns Esc. */
	onClose: () => void;
}) {
	const theme = useTheme();
	return (
		<Modal
			activeRowId={modalRowId(index)}
			footer="↑↓ move · Enter switch · Esc close · managed nodes are session-only"
			hint=""
			onClose={onClose}
			title="Switch node"
			width={PANEL_WIDTH}
			zIndex={45}
		>
			{nodes.length === 0 ? (
				<text fg={theme.colors.mutedForeground}>No nodes configured</text>
			) : (
				nodes.map((node, i) => (
					<NodeRow
						id={modalRowId(i)}
						isActive={node.url === currentUrl}
						key={node.name}
						node={node}
						reachable={health[node.name]}
						selected={i === index}
					/>
				))
			)}
			{managedState === "loading" ? (
				<text fg={theme.colors.mutedForeground}>Loading managed nodes…</text>
			) : managedState === "error" ? (
				<text fg={theme.colors.error}>
					Cloud nodes unavailable · local nodes are still usable
				</text>
			) : null}
		</Modal>
	);
}
