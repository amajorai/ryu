// The shell's node picker: local and managed nodes, health probes, and the
// picker's keys. Split out of App.tsx.

import type { KeyEvent } from "@opentui/core";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { useEffect, useRef, useState } from "react";
import { useSetNodePickerOpen } from "./core/InputFocusContext.tsx";
import { fetchManagedNodes } from "./core/managedNodes.ts";
import {
	healthCheck,
	loadNodes,
	type Node,
	nodeToTarget,
	resolveActive,
	setActive,
} from "./core/nodes.ts";
import { tf } from "./i18n/translate.ts";
import type { useToast } from "./ui/toast.tsx";

export interface NodePickerState {
	health: Record<string, boolean>;
	index: number;
	managedState: "loading" | "ready" | "error";
	nodes: Node[];
	open: boolean;
}

export const CLOSED_NODE_PICKER: NodePickerState = {
	managedState: "ready",
	open: false,
	nodes: [],
	index: 0,
	health: {},
};

export function useShellNodePicker({
	authSourceTarget,
	notify,
	setManagedNode,
	setTarget,
	url,
}: {
	authSourceTarget: ApiTarget;
	notify: ReturnType<typeof useToast>["notify"];
	setManagedNode: (node: Node | null) => void;
	setTarget: (next: ApiTarget) => void;
	url: string;
}) {
	const setNodePickerCapture = useSetNodePickerOpen();
	const [nodePicker, setNodePicker] =
		useState<NodePickerState>(CLOSED_NODE_PICKER);
	useEffect(() => {
		setNodePickerCapture(nodePicker.open);
		return () => setNodePickerCapture(false);
	}, [nodePicker.open, setNodePickerCapture]);
	const managedNodesRequest = useRef(0);

	// Load local nodes immediately, then add control-plane managed nodes for this
	// session. Their short-lived userJwt is never written to the local node file.
	const openNodePicker = () => {
		const config = loadNodes();
		const requestId = ++managedNodesRequest.current;
		const activeName = resolveActive(config).name;
		const byUrl = config.nodes.findIndex((node) => node.url === url);
		const byName = config.nodes.findIndex((node) => node.name === activeName);
		setNodePicker({
			open: true,
			nodes: config.nodes,
			index: byUrl >= 0 ? byUrl : Math.max(0, byName),
			managedState: "loading",
			health: {},
		});
		for (const node of config.nodes) {
			healthCheck(nodeToTarget(node))
				.then((ok) =>
					setNodePicker((prev) => ({
						...prev,
						health: { ...prev.health, [node.name]: ok },
					}))
				)
				.catch(() => undefined);
		}
		fetchManagedNodes(authSourceTarget)
			.then((managedNodes) => {
				if (requestId !== managedNodesRequest.current) {
					return;
				}
				const nodes = [...config.nodes, ...(managedNodes ?? [])];
				const byActiveUrl = nodes.findIndex((node) => node.url === url);
				setNodePicker((previous) => {
					if (!previous.open || requestId !== managedNodesRequest.current) {
						return previous;
					}
					return {
						...previous,
						nodes,
						index: byActiveUrl >= 0 ? byActiveUrl : previous.index,
						managedState: managedNodes === null ? "error" : "ready",
					};
				});
				for (const node of managedNodes ?? []) {
					healthCheck(nodeToTarget(node))
						.then((ok) =>
							setNodePicker((previous) => ({
								...previous,
								health: { ...previous.health, [node.name]: ok },
							}))
						)
						.catch(() => undefined);
				}
			})
			.catch(() => {
				if (requestId === managedNodesRequest.current) {
					setNodePicker((previous) =>
						previous.open ? { ...previous, managedState: "error" } : previous
					);
				}
			});
	};

	// Node picker is open: ↑/↓ move, Enter switches (and persists), Esc closes.
	const handleNodesKey = (key: KeyEvent) => {
		const count = nodePicker.nodes.length;
		if (key.name === "escape") {
			setNodePicker(CLOSED_NODE_PICKER);
			return;
		}
		if (count === 0) {
			return;
		}
		if (key.name === "up" || key.name === "k") {
			setNodePicker((prev) => ({
				...prev,
				index: (prev.index - 1 + count) % count,
			}));
		} else if (key.name === "down" || key.name === "j") {
			setNodePicker((prev) => ({ ...prev, index: (prev.index + 1) % count }));
		} else if (key.name === "return") {
			const chosen = nodePicker.nodes[nodePicker.index];
			setNodePicker(CLOSED_NODE_PICKER);
			if (chosen) {
				setTarget(nodeToTarget(chosen));
				setManagedNode(chosen.managed ? chosen : null);
				if (!chosen.managed) {
					setActive(chosen.name);
				}
				notify(tf("Switched to {name}", { name: chosen.name }), "info");
			}
		}
	};

	return { handleNodesKey, nodePicker, openNodePicker, setNodePicker };
}
