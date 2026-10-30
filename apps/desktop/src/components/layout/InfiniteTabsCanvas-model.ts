import type { Node } from "@xyflow/react";
import type {
	Split,
	Tab,
	TabGroup,
	TabGroupColor,
} from "@/src/contexts/TabsContext.tsx";
import type { useTabLayout } from "@/src/hooks/useTabLayout.ts";
import { pluginValueSchema } from "@/src/lib/api/plugin-wire-values.ts";
import type { CanvasRect } from "./tab-canvas-layout.ts";

export const TAB_CANVAS_STORAGE_KEY = "ryu:tab-canvas-layout:v1";
export const WRITE_DEBOUNCE_MS = 500;

export interface CanvasRegion {
	color: TabGroupColor;
	id: string;
	label: string;
	memberCount: number;
}

export interface TabCanvasNodeData extends Record<string, unknown> {
	focused: boolean;
	motionEnabled: boolean;
	onClose: () => void;
	onFocus: () => void;
	persist: () => void;
	tab: Tab;
	tabLayout: ReturnType<typeof useTabLayout>;
}

export interface RegionCanvasNodeData extends Record<string, unknown> {
	color: TabGroupColor;
	id: string;
	label: string;
	memberCount: number;
}

export type TabCanvasNode = Node<TabCanvasNodeData, "tab">;
export type RegionCanvasNode = Node<RegionCanvasNodeData, "region">;
export type CanvasNode = TabCanvasNode | RegionCanvasNode;

export function readStoredSnapshot() {
	try {
		const value = localStorage.getItem(TAB_CANVAS_STORAGE_KEY);
		return value ? pluginValueSchema.parse(JSON.parse(value)) : null;
	} catch {
		return null;
	}
}

export function regionList(
	tabs: Tab[],
	groups: TabGroup[],
	splits: Split[]
): CanvasRegion[] {
	const regions: CanvasRegion[] = [];
	for (const group of groups) {
		const memberCount = tabs.filter((tab) => tab.groupId === group.id).length;
		if (memberCount > 0) {
			regions.push({
				color: group.color,
				id: `group:${group.id}`,
				label: group.name,
				memberCount,
			});
		}
	}
	for (const split of splits) {
		const memberCount = tabs.filter((tab) => tab.splitId === split.id).length;
		if (memberCount > 0) {
			regions.push({
				color: split.color,
				id: `split:${split.id}`,
				label: split.name || "Pane group",
				memberCount,
			});
		}
	}
	return regions;
}

export function rectForNode(
	node: CanvasNode,
	fallback: CanvasRect
): CanvasRect {
	return {
		height: node.height ?? fallback.height,
		width: node.width ?? fallback.width,
		x: node.position.x,
		y: node.position.y,
	};
}
