import { Button } from "@ryu/ui/components/button.tsx";
import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Maximize, Minus, Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { FLOW_LINE_STYLE, FlowCanvas } from "./flow-canvas.tsx";
import {
	type FlowView,
	fitView,
	isFlowTypingTarget,
	keepInView,
	useFlowClock,
	useFlowPanZoom,
	useFlowSize,
	zoomAt,
} from "./flow-hooks.ts";
import {
	FlowConnectMenu,
	FlowMenu,
	FlowStartCard,
	flowMenuHeight,
} from "./flow-menu.tsx";
import {
	buildFlowLayout,
	connectSections,
	type FlowAction,
	type FlowChip,
	type FlowDirection,
	type FlowLayout,
	type FlowMenuSection,
	type FlowNode,
	type FlowTarget,
	firstNeedingYou,
	flowNeighbor,
	flowPath,
	flowStartActions,
} from "./flow-model.ts";
import {
	FlowOverviewPanel,
	type FlowPanelSubject,
	FlowThreadPanel,
} from "./flow-panel.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * Auto-fit never shrinks the flow below this; the user can zoom further. On a
 * phone-width canvas everything has to fit, so the floor drops.
 */
function autoFitMinZoom(width: number): number {
	// Below this, 13px labels drop under 10px; the user pans instead.
	return width < 640 ? 0.75 : 0.8;
}

/** Framing may grow a small flow to 125%, so it fills the window. */
const FIT_MAX_ZOOM = 1.25;
/** Room kept between the selected branch and the canvas edges. */
const BRANCH_MARGIN = 32;

/** Below this canvas width the panel overlays the flow instead of narrowing it. */
const PANEL_OVERLAY_BELOW = 1100;

/** Used until the canvas has been measured (and in server markup). */
const DEFAULT_VIEW: FlowView = { k: 1, x: 64, y: 64 };

const ARROWS: Record<string, FlowDirection> = {
	ArrowDown: "down",
	ArrowLeft: "left",
	ArrowRight: "right",
	ArrowUp: "up",
};

/** Panel width for a canvas of this width (full width on phones). */
function panelWidth(width: number): number {
	if (width < 640) {
		return width;
	}
	return width >= 1280 ? 400 : 360;
}

function subjectFor(
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
function branchBox(
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
function chainBox(
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
function menuTitle(layout: FlowLayout, ownerId: string): string {
	const node = layout.nodes.find((item) => item.id === ownerId);
	if (node?.kind === "agent") {
		return `Connect to ${node.agent.name}`;
	}
	if (node?.kind === "team") {
		return `Connect to ${node.group.name}`;
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
function placeMenu({
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

function FlowLoading() {
	return (
		<div
			aria-busy="true"
			aria-label="Loading"
			className="flex items-center gap-0"
			role="status"
		>
			<Skeleton className="size-10 rounded-full" />
			<span className="h-px w-16 bg-border" />
			<Skeleton className="h-10 w-44 rounded-lg" />
			<span className="h-px w-16 bg-border" />
			<Skeleton className="h-10 w-64 rounded-lg" />
		</div>
	);
}

/**
 * Flow: a calm canvas that starts as one card and grows as you use it. You
 * connect to agents, agents connect to their conversations, and selecting a
 * node slides in its metrics, activity, and logs (or the host's chat).
 */
export function FlowInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const reduceMotion = useReducedMotion();
	const now = useFlowClock();
	const viewportRef = useRef<HTMLDivElement>(null);
	const size = useFlowSize(viewportRef);
	const helpId = useId();

	const [engaged, setEngaged] = useState<string[]>([]);
	const [expanded, setExpanded] = useState<string[]>([]);
	const [composer, setComposer] = useState<FlowTarget | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const [focusId, setFocusId] = useState<string | null>(null);
	const [startOpen, setStartOpen] = useState(false);
	const [view, setView] = useState<FlowView | null>(null);
	const [animateView, setAnimateView] = useState(false);
	const userMoved = useRef(false);
	const pendingFocus = useRef<string | null>(null);

	const panelOpen = threadView !== null || selectedId !== null;
	// A menu opened from a lead's hover stub anchors to that stub, so only the
	// selected lead (or the origin) lays out a stub row of its own.
	// A lead's stub hangs off its port as an overlay, so selecting never reflows rows.
	const stubFor = composer || menuFor !== "origin" ? null : "origin";
	const layout = useMemo(
		() =>
			buildFlowLayout(snapshot, {
				activeThreadId,
				composer,
				engaged,
				expanded,
				originStub: true,
				stubFor,
			}),
		[activeThreadId, composer, engaged, expanded, snapshot, stubFor]
	);
	const starts = useMemo(() => flowStartActions(snapshot), [snapshot]);
	const newSections = useMemo((): FlowMenuSection[] => {
		const first = starts.all.filter(
			(action) => action.id === "review" || action.id === "blank"
		);
		return [
			...(first.length > 0 ? [{ id: "start", items: first, label: null }] : []),
			...connectSections(snapshot, "origin"),
		];
	}, [snapshot, starts.all]);
	const empty =
		snapshot.threads.length === 0 && engaged.length === 0 && composer === null;
	const panelW = panelOpen ? panelWidth(size.width) : 0;
	const activeNodeId = activeThreadId ? `thread:${activeThreadId}` : null;
	const highlighted = threadView === null ? selectedId : activeNodeId;
	const path = useMemo(
		() => flowPath(layout, highlighted),
		[layout, highlighted]
	);
	const rovingId =
		focusId && layout.nodes.some((node) => node.id === focusId)
			? focusId
			: (highlighted ?? "origin");

	const userChange = useCallback((update: (view: FlowView) => FlowView) => {
		userMoved.current = true;
		setAnimateView(false);
		setView((previous) => (previous ? update(previous) : previous));
	}, []);
	const { panning } = useFlowPanZoom(viewportRef, userChange);

	// Fit the flow to the screen until the user moves it themselves.
	const fitWidth =
		panelW < size.width && size.width >= PANEL_OVERLAY_BELOW
			? size.width - panelW
			: size.width;
	const minZoom = autoFitMinZoom(size.width);
	const { maxX, maxY, minX, minY } = layout.bounds;
	const shown = view ?? DEFAULT_VIEW;
	const viewRef = useRef<FlowView | null>(null);
	viewRef.current = view;
	// With the panel open, the selected node and its first-level children stay
	// clear of it, the way the reference keeps a service beside its panel.
	const branch =
		panelW > 0 && panelW < size.width ? branchBox(layout, highlighted) : null;
	const branchKey = branch
		? `${branch.minX},${branch.minY},${branch.maxX},${branch.maxY}`
		: "";
	const branchRef = useRef(branch);
	branchRef.current = branch;
	const layoutRef = useRef(layout);
	layoutRef.current = layout;
	const highlightedRef = useRef(highlighted);
	highlightedRef.current = highlighted;
	useEffect(() => {
		if (size.width === 0) {
			return;
		}
		const focusBox = branchKey ? branchRef.current : null;
		const previous = viewRef.current;
		let next =
			userMoved.current && previous
				? previous
				: fitView(
						{ maxX, maxY, minX, minY },
						{ height: size.height, width: fitWidth },
						minZoom,
						FIT_MAX_ZOOM
					);
		if (focusBox) {
			const area = {
				bottom: size.height - BRANCH_MARGIN,
				left: BRANCH_MARGIN,
				right: size.width - panelW - BRANCH_MARGIN,
				top: BRANCH_MARGIN,
			};
			next = keepInView(next, focusBox, area);
			// Then pull the parent chain back in: when the children do not fit
			// beside the panel, they run under it rather than "You" leaving.
			const chain = chainBox(
				layoutRef.current,
				highlightedRef.current,
				(area.right - area.left) / next.k
			);
			if (chain) {
				next = keepInView(next, chain, area);
			}
		}
		if (next === previous) {
			return;
		}
		setAnimateView(previous !== null);
		setView(next);
	}, [
		branchKey,
		fitWidth,
		maxX,
		maxY,
		minX,
		minY,
		minZoom,
		panelW,
		size.height,
		size.width,
	]);

	const fitToScreen = useCallback(() => {
		userMoved.current = false;
		setAnimateView(true);
		setView(
			fitView(
				{ maxX, maxY, minX, minY },
				{ height: size.height, width: fitWidth },
				minZoom,
				FIT_MAX_ZOOM
			)
		);
	}, [fitWidth, maxX, maxY, minX, minY, minZoom, size.height]);

	const zoomBy = useCallback(
		(factor: number) => {
			userMoved.current = true;
			setAnimateView(true);
			setView((previous) =>
				previous
					? zoomAt(previous, factor, (size.width - panelW) / 2, size.height / 2)
					: previous
			);
		},
		[panelW, size.height, size.width]
	);

	/** Pans just enough to bring a node clear of the edges and the panel. */
	const reveal = useCallback(
		(id: string) => {
			const node = layout.nodes.find((item) => item.id === id);
			if (!node || size.width === 0) {
				return;
			}
			const previous = viewRef.current;
			if (!previous) {
				return;
			}
			const margin = 32;
			const right = size.width - (panelW < size.width ? panelW : 0) - margin;
			const left = previous.x + node.x * previous.k;
			const end = previous.x + (node.x + node.w) * previous.k;
			const top = previous.y + (node.y - node.h / 2) * previous.k;
			const bottom = previous.y + (node.y + node.h / 2) * previous.k;
			let dx = 0;
			let dy = 0;
			if (end > right) {
				dx = right - end;
			}
			if (left + dx < margin) {
				dx = margin - left;
			}
			if (bottom > size.height - margin) {
				dy = size.height - margin - bottom;
			}
			if (top + dy < margin) {
				dy = margin - top;
			}
			if (dx === 0 && dy === 0) {
				return;
			}
			setAnimateView(true);
			setView({ ...previous, x: previous.x + dx, y: previous.y + dy });
		},
		[layout.nodes, panelW, size.height, size.width]
	);

	useEffect(() => {
		const id = pendingFocus.current;
		if (!id) {
			return;
		}
		pendingFocus.current = null;
		const element = viewportRef.current?.querySelector<HTMLElement>(
			`[data-flow-node="${CSS.escape(id)}"]`
		);
		const target =
			element?.tagName === "FORM"
				? element.querySelector<HTMLElement>("input")
				: element;
		target?.focus({ preventScroll: true });
	});

	const moveTo = (id: string) => {
		setFocusId(id);
		pendingFocus.current = id;
		userMoved.current = true;
		reveal(id);
	};

	const openComposer = (target: FlowTarget) => {
		if (target.groupKey !== "root") {
			setEngaged((previous) =>
				previous.includes(target.groupKey)
					? previous
					: [...previous, target.groupKey]
			);
		}
		setMenuFor(null);
		setStartOpen(false);
		setComposer(target);
		const id = `composer:${target.groupKey === "root" ? "root" : target.groupKey}`;
		setFocusId(id);
	};

	const choose = (action: FlowAction) => {
		if (action.target) {
			openComposer(action.target);
			return;
		}
		setMenuFor(null);
		setStartOpen(false);
		const next = firstNeedingYou(snapshot);
		if (next) {
			setSelectedId(null);
			port.openThread(next.id);
		}
	};

	const activate = (node: FlowNode) => {
		setFocusId(node.id);
		switch (node.kind) {
			case "origin":
			case "agent":
			case "team": {
				const same = selectedId === node.id && threadView === null;
				setMenuFor(null);
				setSelectedId(same ? null : node.id);
				if (threadView !== null) {
					port.closeThread();
				}
				return;
			}
			case "thread":
				setMenuFor(null);
				setSelectedId(null);
				port.openThread(node.thread.id);
				return;
			case "more":
				setExpanded((previous) => [...previous, node.groupKey]);
				return;
			case "stub":
				setMenuFor((previous) =>
					previous === node.ownerId ? null : node.ownerId
				);
				return;
			default:
		}
	};

	const onChip = (chip: FlowChip) => {
		const threadId = chip.threadId ?? firstNeedingYou(snapshot)?.id;
		if (threadId) {
			setMenuFor(null);
			setSelectedId(null);
			port.openThread(threadId);
		}
	};

	/** Where focus returns when a lead's "Connect to" menu closes. */
	const stubHome = (owner: string) => {
		const id = `stub:${owner}`;
		return layout.nodes.some((node) => node.id === id) ? id : owner;
	};

	const closeEverything = (): boolean => {
		if (menuFor) {
			const owner = menuFor;
			setMenuFor(null);
			moveTo(stubHome(owner));
			return true;
		}
		if (startOpen) {
			setStartOpen(false);
			return true;
		}
		if (composer) {
			setComposer(null);
			return true;
		}
		if (threadView !== null) {
			port.closeThread();
			return true;
		}
		if (selectedId) {
			setSelectedId(null);
			return true;
		}
		return false;
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.target instanceof Element &&
			event.target.closest(
				"[data-flow-menu], [data-flow-panel], [data-flow-start]"
			)
		) {
			if (event.key === "Escape" && closeEverything()) {
				event.preventDefault();
			}
			return;
		}
		if (event.key === "Escape") {
			if (closeEverything()) {
				event.preventDefault();
			}
			return;
		}
		if (isFlowTypingTarget(event.target) || empty) {
			return;
		}
		const direction = ARROWS[event.key];
		if (direction) {
			event.preventDefault();
			const next = flowNeighbor(layout, rovingId, direction);
			if (next) {
				moveTo(next);
			}
			return;
		}
		if (event.key === "=" || event.key === "+") {
			event.preventDefault();
			zoomBy(1.2);
		} else if (event.key === "-") {
			event.preventDefault();
			zoomBy(1 / 1.2);
		} else if (event.key === "0") {
			event.preventDefault();
			fitToScreen();
		}
	};

	// Close floating menus on a press anywhere outside them.
	useEffect(() => {
		if (!(menuFor || startOpen)) {
			return;
		}
		const onDown = (event: PointerEvent) => {
			if (
				event.target instanceof Element &&
				event.target.closest(
					"[data-flow-menu], [data-flow-start], [aria-haspopup='menu'], [data-flow-start-toggle]"
				)
			) {
				return;
			}
			setMenuFor(null);
			setStartOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [menuFor, startOpen]);

	const submit = (target: FlowTarget, prompt: string) => {
		setComposer(null);
		setSelectedId(null);
		port.startThread({
			agentId: target.agentId,
			projectId: target.projectId,
			prompt,
			teamId: target.teamId,
		});
	};

	const subject = threadView === null ? subjectFor(layout, selectedId) : null;
	const activeThread = snapshot.threads.find(
		(thread) => thread.id === activeThreadId
	);
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
	const transition = reduceMotion
		? { duration: 0 }
		: { damping: 36, stiffness: 340, type: "spring" as const };
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

	const showLoading = loading && snapshot.threads.length === 0;
	const showStart = !showLoading && empty;

	return (
		<div
			className="relative flex size-full overflow-hidden bg-background text-foreground"
			data-testid="interface-flow"
			style={FLOW_LINE_STYLE}
		>
			{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: the canvas is an application region with its own keyboard model */}
			<div
				aria-describedby={helpId}
				aria-label="Flow canvas"
				className={cn(
					"relative min-w-0 flex-1 touch-none select-none bg-muted/35 outline-none",
					panning ? "cursor-grabbing" : "cursor-default"
				)}
				data-flow-viewport=""
				onKeyDown={onKeyDown}
				ref={viewportRef}
				role="application"
				tabIndex={-1}
			>
				<p className="sr-only" id={helpId}>
					Arrow keys move between connected nodes. Enter opens a node; Tab from
					a selected agent or team reaches its Connect menu. Escape closes the
					panel. Drag or scroll to pan; hold Control or Command while scrolling
					to zoom.
				</p>
				{showLoading ? (
					<div className="absolute inset-0 flex items-center justify-center">
						<FlowLoading />
					</div>
				) : null}
				{showStart ? (
					<div
						className="absolute inset-0 flex items-center justify-center overflow-y-auto px-4 py-12"
						data-flow-start=""
					>
						<motion.div
							animate={{ opacity: 1, y: 0 }}
							className="flex w-full justify-center"
							initial={reduceMotion ? false : { opacity: 0, y: 6 }}
							transition={transition}
						>
							<FlowStartCard
								actions={starts.short}
								allActions={starts.all}
								onChoose={choose}
							/>
						</motion.div>
					</div>
				) : null}
				{showLoading || showStart ? null : (
					<motion.div
						animate={{ scale: shown.k, x: shown.x, y: shown.y }}
						className="absolute top-0 left-0"
						initial={false}
						style={{
							originX: 0,
							originY: 0,
							// Unmeasured (first paint): lay out, but do not flash the unfitted view.
							visibility: view ? "visible" : "hidden",
						}}
						transition={animateView ? transition : { duration: 0 }}
					>
						<FlowCanvas
							focusId={rovingId}
							layout={layout}
							menuFor={menuFor}
							onActivate={activate}
							onCancelComposer={() => {
								setComposer(null);
								moveTo(
									composer?.groupKey === "root" || !composer
										? "origin"
										: composer.groupKey
								);
							}}
							onChip={onChip}
							onConnect={(owner) =>
								setMenuFor((previous) => (previous === owner ? null : owner))
							}
							onFocusNode={setFocusId}
							onSubmitComposer={submit}
							path={path}
							reduceMotion={reduceMotion}
							selectedId={highlighted}
						/>
					</motion.div>
				)}
				{menuPosition && menuFor ? (
					<FlowConnectMenu
						left={menuPosition.left}
						maxHeight={menuPosition.maxHeight}
						onChoose={choose}
						onClose={() => {
							const owner = menuFor;
							setMenuFor(null);
							moveTo(stubHome(owner));
						}}
						sections={sections}
						title={menuTitle(layout, menuFor)}
						top={menuPosition.top}
					/>
				) : null}

				{showStart ? null : (
					<span
						aria-hidden="true"
						className="pointer-events-none absolute top-4 left-4 text-foreground"
					>
						<RyuLogo
							animated={false}
							size="20px"
							tone="inherit"
							variant="outline"
						/>
					</span>
				)}

				{showStart || showLoading ? null : (
					<div
						className="absolute top-3 z-10"
						style={{
							right: panelW > 0 && panelW < size.width ? panelW + 12 : 12,
						}}
					>
						<Button
							aria-expanded={startOpen}
							aria-label="New conversation"
							data-flow-start-toggle=""
							onClick={() => setStartOpen((value) => !value)}
							size="icon-sm"
							title="New conversation"
							variant="ghost-muted"
						>
							<Plus aria-hidden="true" className="size-4 stroke-[1.75]" />
						</Button>
						<AnimatePresence>
							{startOpen ? (
								<motion.div
									animate={{ opacity: 1, y: 0 }}
									className="absolute top-10 right-0 w-[22rem] max-w-[calc(100vw-2rem)]"
									data-flow-start=""
									exit={{ opacity: 0, y: -4 }}
									initial={reduceMotion ? false : { opacity: 0, y: -4 }}
									transition={{ duration: reduceMotion ? 0 : 0.14 }}
								>
									<FlowMenu
										label="New conversation"
										maxHeight={Math.max(
											160,
											Math.min(flowMenuHeight(newSections), size.height - 72)
										)}
										onChoose={choose}
										onClose={() => {
											setStartOpen(false);
											viewportRef.current
												?.querySelector<HTMLElement>("[data-flow-start-toggle]")
												?.focus();
										}}
										sections={newSections}
									/>
								</motion.div>
							) : null}
						</AnimatePresence>
					</div>
				)}

				{showStart || showLoading ? null : (
					<div
						aria-label="Zoom"
						className="absolute bottom-4 left-4 z-10 flex h-8 items-center rounded-lg border border-border bg-background shadow-xs"
						role="toolbar"
					>
						<button
							aria-label="Zoom out"
							className="flex h-full w-8 items-center justify-center rounded-s-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
							onClick={() => zoomBy(1 / 1.2)}
							type="button"
						>
							<Minus aria-hidden="true" className="size-3.5 stroke-[1.75]" />
						</button>
						<span className="w-11 border-border border-x text-center text-muted-foreground text-xs tabular-nums leading-[30px]">
							{Math.round(shown.k * 100)}%
						</span>
						<button
							aria-label="Zoom in"
							className="flex h-full w-8 items-center justify-center text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
							onClick={() => zoomBy(1.2)}
							type="button"
						>
							<Plus aria-hidden="true" className="size-3.5 stroke-[1.75]" />
						</button>
						<button
							aria-label="Fit to screen"
							className="flex h-full w-8 items-center justify-center rounded-e-lg border-border border-s text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
							onClick={fitToScreen}
							title="Fit to screen (0)"
							type="button"
						>
							<Maximize aria-hidden="true" className="size-3.5 stroke-[1.75]" />
						</button>
					</div>
				)}
			</div>

			<AnimatePresence initial={false}>
				{panelOpen ? (
					<motion.aside
						animate={{ opacity: 1 }}
						aria-label="Details"
						className="absolute inset-y-0 right-0 z-30 flex flex-col border-border border-l bg-background"
						data-flow-panel=""
						exit={{ opacity: 0 }}
						initial={reduceMotion ? false : { opacity: 0 }}
						key="panel"
						onKeyDown={(event) => {
							if (event.key === "Escape" && closeEverything()) {
								event.preventDefault();
							}
						}}
						style={{ width: panelW || panelWidth(size.width) || 400 }}
						// A fade, not a slide: the panel never paints past the viewport.
						transition={{ duration: reduceMotion ? 0 : 0.16, ease: "easeOut" }}
					>
						{threadView === null ? (
							subject ? (
								<FlowOverviewPanel
									now={now}
									onClose={() => setSelectedId(null)}
									onNew={
										subject.scope.kind === "all"
											? null
											: () => {
													const owner = selectedId;
													if (owner) {
														setMenuFor(owner);
													}
												}
									}
									onOpenThread={(threadId) => {
										setSelectedId(null);
										port.openThread(threadId);
									}}
									snapshot={snapshot}
									subject={subject}
								/>
							) : null
						) : (
							<FlowThreadPanel
								onClose={() => port.closeThread()}
								thread={activeThread}
								threadView={threadView}
							/>
						)}
					</motion.aside>
				) : null}
			</AnimatePresence>
		</div>
	);
}
