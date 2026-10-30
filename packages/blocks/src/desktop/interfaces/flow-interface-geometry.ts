import type { LiteralMessage } from "@ryu/i18n/react";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import type { FlowView } from "./flow-hooks.ts";
import { flowMenuHeight } from "./flow-menu.tsx";
import { connectSections, type FlowLayout } from "./flow-model.ts";
import type { FlowPanelSubject } from "./flow-panel.tsx";

/**
 * Auto-fit never shrinks the flow below this; the user can zoom further. On a
 * phone-width canvas everything has to fit, so the floor drops.
 */
export function autoFitMinZoom(width: number): number {
	// Below this, 13px labels drop under 10px; the user pans instead.
	return width < 640 ? 0.75 : 0.8;
}

/** Framing may grow a small flow to 125%, so it fills the window. */
export const FIT_MAX_ZOOM = 1.25;
/** Room kept between the selected branch and the canvas edges. */
export const BRANCH_MARGIN = 32;

/** Below this canvas width the panel overlays the flow instead of narrowing it. */
export const PANEL_OVERLAY_BELOW = 1100;

/** Used until the canvas has been measured (and in server markup). */
export const DEFAULT_VIEW: FlowView = { k: 1, x: 64, y: 64 };

/** Panel width for a canvas of this width (full width on phones). */
export function panelWidth(width: number): number {
	if (width < 640) {
		return width;
	}
	return width >= 1280 ? 400 : 360;
}

export function subjectFor(
	layout: FlowLayout,
	selectedId: string | null
): FlowPanelSubject | null {
	const node = layout.nodes.find((item) => item.id === selectedId);
	if (node?.kind === "origin") {
		return {
			description: "Everything in this workspace",
			glyph: "origin",
			name: "You",
			scope: { kind: "all" },
		};
	}
	if (node?.kind === "agent") {
		return {
			description: node.agent.description,
			glyph: "agent",
			name: node.agent.name,
			scope: { agentId: node.agent.id, kind: "agent" },
		};
	}
	if (node?.kind === "team") {
		return {
			description: `${node.group.memberAgentIds.length} members`,
			glyph: "team",
			name: node.group.name,
			scope: { kind: "team", teamId: node.group.id },
		};
	}
	if (node?.kind === "lane") {
		return {
			description: "Conversations with no agent or team",
			glyph: "lane",
			name: node.label,
			scope: { kind: "unassigned" },
		};
	}
	return null;
}

/** The world-space box around a node and the nodes hanging off it. */
export function branchBox(
	layout: FlowLayout,
	id: string | null
): { maxX: number; maxY: number; minX: number; minY: number } | null {
	if (!id) {
		return null;
	}
	let box: { maxX: number; maxY: number; minX: number; minY: number } | null =
		null;
	for (const node of layout.nodes) {
		if (node.id !== id && node.parentId !== id) {
			continue;
		}
		const top = node.y - node.h / 2;
		const bottom = node.y + node.h / 2;
		box = box
			? {
					maxX: Math.max(box.maxX, node.x + node.w),
					maxY: Math.max(box.maxY, bottom),
					minX: Math.min(box.minX, node.x),
					minY: Math.min(box.minY, top),
				}
			: { maxX: node.x + node.w, maxY: bottom, minX: node.x, minY: top };
	}
	return box;
}

interface FlowBox {
	maxX: number;
	maxY: number;
	minX: number;
	minY: number;
}

/**
 * The node and its ancestors up to "You", stopping at the first ancestor that
 * would make the box wider than `maxWidth` (world px), so the parent chain wins
 * over the children when both cannot be shown.
 */
export function chainBox(
	layout: FlowLayout,
	id: string | null,
	maxWidth: number
): FlowBox | null {
	const byId = new Map(layout.nodes.map((node) => [node.id, node]));
	let node = id ? byId.get(id) : undefined;
	let box: FlowBox | null = null;
	while (node) {
		const next: FlowBox = {
			maxX: Math.max(box?.maxX ?? Number.NEGATIVE_INFINITY, node.x + node.w),
			maxY: Math.max(
				box?.maxY ?? Number.NEGATIVE_INFINITY,
				node.y + node.h / 2
			),
			minX: Math.min(box?.minX ?? Number.POSITIVE_INFINITY, node.x),
			minY: Math.min(
				box?.minY ?? Number.POSITIVE_INFINITY,
				node.y - node.h / 2
			),
		};
		if (box && next.maxX - next.minX > maxWidth) {
			break;
		}
		box = next;
		node = node.parentId ? byId.get(node.parentId) : undefined;
	}
	return box;
}

/** The tab over a stub's menu: "Connect to Atlas", or a plain start for You. */
export function menuTitle(
	layout: FlowLayout,
	ownerId: string,
	tl: LiteralMessage
): string {
	const node = layout.nodes.find((item) => item.id === ownerId);
	if (node?.kind === "agent") {
		return tl("Connect to {name}", { name: node.agent.name });
	}
	if (node?.kind === "team") {
		return tl("Connect to {name}", { name: node.group.name });
	}
	return "Start a conversation";
}

const MENU_TAB = 28;
const MENU_EDGE = 16;
const MENU_MAX = 448;

/**
 * Screen position for a stub's menu: beside the stub, opening downward, or
 * upward when the rows would not fit below and there is more room above.
 */
export function placeMenu({
	anchor,
	lift,
	limit,
	natural,
	size,
	view,
}: {
	anchor: { right: number; y: number } | undefined | null;
	lift: number;
	limit: number;
	natural: number;
	size: { height: number; width: number };
	view: FlowView;
}): { left: number; maxHeight: number; top: number } | null {
	if (!anchor) {
		return null;
	}
	const wanted = Math.min(MENU_MAX, natural);
	const left = Math.max(
		8,
		Math.min(view.x + anchor.right * view.k + 12, limit - 328)
	);
	const anchorY = view.y + anchor.y * view.k;
	const downTop = Math.max(8, anchorY - lift);
	const below = size.height - downTop - MENU_TAB - MENU_EDGE;
	// Upward, the menu's foot lines up just under the stub.
	const foot = Math.min(size.height - MENU_EDGE, anchorY + 14);
	const above = foot - MENU_TAB - MENU_EDGE;
	if (below >= wanted || below >= above) {
		return {
			left,
			maxHeight: Math.max(120, Math.min(wanted, below)),
			top: downTop,
		};
	}
	const maxHeight = Math.min(wanted, above);
	return { left, maxHeight, top: foot - maxHeight - MENU_TAB };
}

/** Where a lead's "Connect to" menu opens, and the rows it lists. */
export function flowMenuPlacement({
	layout,
	menuFor,
	panelW,
	shown,
	size,
	snapshot,
}: {
	layout: FlowLayout;
	menuFor: string | null;
	panelW: number;
	shown: FlowView;
	size: { height: number; width: number };
	snapshot: InterfaceSnapshot;
}) {
	const stubNode = menuFor
		? layout.nodes.find(
				(node) => node.kind === "stub" && node.ownerId === menuFor
			)
		: undefined;
	// A hover stub sits off the lead's port: 12px right, one half-gap below.
	const hoverOwner =
		menuFor && !stubNode
			? layout.nodes.find((node) => node.id === menuFor)
			: undefined;
	const sections = menuFor ? connectSections(snapshot, menuFor) : [];
	const menuPosition = placeMenu({
		anchor: stubNode
			? { right: stubNode.x + stubNode.w, y: stubNode.y }
			: hoverOwner && {
					right: hoverOwner.x + hoverOwner.w + 28,
					y: hoverOwner.y + 27,
				},
		// Layout stubs own a row, so the menu's tab can rise beside them; a
		// hover stub sits between rows, so its menu starts level with it.
		lift: stubNode ? 46 : 10,
		limit: size.width - panelW,
		natural: flowMenuHeight(sections),
		size,
		view: shown,
	});
	return { menuPosition, sections };
}
