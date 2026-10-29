import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { AnimatePresence, motion } from "motion/react";
import { type Ref, useEffect, useLayoutEffect, useRef } from "react";
import type { MindmapViewController } from "./mindmap-hooks.ts";
import {
	type MindmapLayout,
	type MindmapNode,
	type MindmapPoint,
	type MindmapSize,
	type MindmapTree,
	outerAnchor,
} from "./mindmap-model.ts";
import {
	MINDMAP_EASE,
	MindmapHandles,
	type MindmapNodeEvents,
	MindmapNodeView,
} from "./mindmap-node.tsx";
import {
	MINDMAP_BRANCH_FALLBACK,
	mindmapBranchColor,
} from "./mindmap-palette.ts";

export interface MindmapCanvasProps {
	activeThreadId: string | null;
	agents: Map<string, InterfaceAgent>;
	ageOf: (node: MindmapNode) => string;
	animate: boolean;
	collapsed: ReadonlySet<string>;
	controller: MindmapViewController;
	describedBy: string;
	events: MindmapNodeEvents;
	hoveredId: string | null;
	layout: MindmapLayout;
	onMeasure: (sizes: Map<string, MindmapSize>) => void;
	onStart: (node: MindmapNode) => void;
	onToggle: (node: MindmapNode) => void;
	selectedId: string;
	sizes: ReadonlyMap<string, MindmapSize>;
	tree: MindmapTree;
	treeRef: Ref<HTMLDivElement>;
}

function foldLabel(node: MindmapNode, collapsed: boolean): string | null {
	if (node.childIds.length === 0 || node.kind === "root") {
		return null;
	}
	const what =
		node.threadCount > 0
			? `${node.threadCount} thread${node.threadCount === 1 ? "" : "s"}`
			: `${node.childIds.length} item${node.childIds.length === 1 ? "" : "s"}`;
	return collapsed
		? `Expand ${node.label} (${what})`
		: `Collapse ${node.label}`;
}

function startLabel(node: MindmapNode, tl: LiteralMessage): string {
	if (node.kind === "agent") {
		return tl("New thread with {label}", { label: node.label });
	}
	return node.groupKind === "direct"
		? "New direct thread"
		: tl("New thread in {label}", { label: node.label });
}

/** Sibling position for aria-posinset / aria-setsize. */
function siblingInfo(
	tree: MindmapTree,
	node: MindmapNode
): { position: number; size: number } {
	const parent = node.parentId ? tree.nodes.get(node.parentId) : undefined;
	if (!parent) {
		return { position: 1, size: 1 };
	}
	return {
		position: parent.childIds.indexOf(node.id) + 1,
		size: parent.childIds.length,
	};
}

/**
 * The map surface: a pannable, zoomable world holding the tapered branches
 * (SVG), the nodes (a flat ARIA tree), and the fold and "+" handles.
 */
export function MindmapCanvas({
	activeThreadId,
	agents,
	animate,
	ageOf,
	collapsed,
	controller,
	describedBy,
	events,
	hoveredId,
	layout,
	onMeasure,
	onStart,
	onToggle,
	selectedId,
	sizes,
	tree,
	treeRef,
}: MindmapCanvasProps) {
	const tl = useLiteralMessages();
	const worldRef = useRef<HTMLDivElement>(null);
	const onMeasureRef = useRef(onMeasure);
	onMeasureRef.current = onMeasure;
	const sizesRef = useRef(sizes);
	sizesRef.current = sizes;
	// Nodes that were on the map last render: only new ones grow in.
	const shownRef = useRef<Set<string> | null>(null);
	const previouslyShown = shownRef.current;

	// Read real label widths before paint, so branches meet their labels.
	useLayoutEffect(() => {
		shownRef.current = new Set(layout.order);
		const world = worldRef.current;
		if (!world) {
			return;
		}
		const measure = () => {
			const updates = new Map<string, MindmapSize>();
			for (const element of world.querySelectorAll<HTMLElement>(
				"[data-mindmap-node]"
			)) {
				const id = element.dataset.mindmapNode;
				const width = element.offsetWidth;
				const height = element.offsetHeight;
				if (!id || width === 0) {
					continue;
				}
				const known = sizesRef.current.get(id);
				if (!known || Math.abs(known.width - width) > 0.5) {
					updates.set(id, { height, width });
				}
			}
			if (updates.size > 0) {
				onMeasureRef.current(updates);
			}
		};
		measure();
	});

	// Web fonts can land after the first measure; measure once more then.
	useEffect(() => {
		const fonts = typeof document === "undefined" ? undefined : document.fonts;
		let cancelled = false;
		fonts?.ready.then(() => {
			const world = worldRef.current;
			if (cancelled || !world) {
				return;
			}
			const updates = new Map<string, MindmapSize>();
			for (const element of world.querySelectorAll<HTMLElement>(
				"[data-mindmap-node]"
			)) {
				const id = element.dataset.mindmapNode;
				if (id && element.offsetWidth > 0) {
					updates.set(id, {
						height: element.offsetHeight,
						width: element.offsetWidth,
					});
				}
			}
			if (updates.size > 0) {
				onMeasureRef.current(updates);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const { view } = controller;
	const transition = animate
		? { duration: 0.24, ease: MINDMAP_EASE }
		: { duration: 0 };

	const originOf = (node: MindmapNode): MindmapPoint | null => {
		const parent = node.parentId ? tree.nodes.get(node.parentId) : undefined;
		const parentBox = parent ? layout.placed.get(parent.id) : undefined;
		if (!(parent && parentBox && node.side)) {
			return null;
		}
		return outerAnchor(parent, parentBox, node.side);
	};

	return (
		<div
			className={cn(
				"absolute inset-0 touch-none overflow-hidden",
				controller.panning ? "cursor-grabbing" : "cursor-grab"
			)}
			data-testid="mindmap-viewport"
			onPointerCancel={controller.onPointerUp}
			onPointerDown={controller.onPointerDown}
			onPointerMove={controller.onPointerMove}
			onPointerUp={controller.onPointerUp}
			ref={controller.viewportRef}
		>
			<div
				className={cn(
					"absolute top-0 left-0 origin-top-left",
					controller.smooth &&
						animate &&
						"transition-transform duration-300 ease-[cubic-bezier(0.22,0.8,0.24,1)]"
				)}
				ref={worldRef}
				style={{
					transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
				}}
			>
				<svg
					aria-hidden="true"
					className={cn(
						"pointer-events-none absolute top-0 left-0 overflow-visible",
						MINDMAP_BRANCH_FALLBACK
					)}
					height="1"
					width="1"
				>
					<AnimatePresence initial={false}>
						{layout.edges.map((edge) => {
							const fresh =
								previouslyShown !== null && !previouslyShown.has(edge.childId);
							return (
								<motion.path
									animate={{ d: edge.path, opacity: 1 }}
									exit={{ d: edge.collapsedPath, opacity: 0, transition }}
									initial={
										fresh ? { d: edge.collapsedPath, opacity: 0 } : false
									}
									key={edge.childId}
									style={{ fill: mindmapBranchColor(edge.branch) }}
									transition={transition}
								/>
							);
						})}
					</AnimatePresence>
				</svg>
				<div
					aria-describedby={describedBy}
					aria-label="Mind map"
					ref={treeRef}
					role="tree"
				>
					<AnimatePresence initial={false}>
						{layout.order.map((id) => {
							const node = tree.nodes.get(id);
							const placed = layout.placed.get(id);
							if (!(node && placed)) {
								return null;
							}
							const { position, size } = siblingInfo(tree, node);
							return (
								<MindmapNodeView
									active={
										node.threadId !== null && node.threadId === activeThreadId
									}
									age={ageOf(node)}
									agent={node.agentId ? agents.get(node.agentId) : undefined}
									animate={animate}
									events={events}
									expanded={
										node.kind === "root" || node.childIds.length === 0
											? undefined
											: !collapsed.has(node.id)
									}
									fresh={
										previouslyShown !== null && !previouslyShown.has(node.id)
									}
									key={id}
									node={node}
									origin={originOf(node)}
									placed={placed}
									posInSet={position}
									selected={id === selectedId}
									setSize={size}
									tabStop={id === selectedId}
								/>
							);
						})}
					</AnimatePresence>
				</div>
				<div>
					{layout.order.map((id) => {
						const node = tree.nodes.get(id);
						const placed = layout.placed.get(id);
						if (
							!(
								node &&
								placed &&
								node.side &&
								(node.kind === "agent" || node.kind === "group")
							)
						) {
							return null;
						}
						const isCollapsed = collapsed.has(node.id);
						return (
							<MindmapHandles
								animate={animate}
								collapsed={isCollapsed && node.childIds.length > 0}
								foldLabel={foldLabel(node, isCollapsed)}
								key={id}
								node={node}
								onHover={events.onHover}
								onStart={() => onStart(node)}
								onToggle={() => onToggle(node)}
								point={outerAnchor(node, placed, node.side)}
								revealed={hoveredId === id || selectedId === id}
								startLabel={startLabel(node, tl)}
							/>
						);
					})}
				</div>
			</div>
		</div>
	);
}
