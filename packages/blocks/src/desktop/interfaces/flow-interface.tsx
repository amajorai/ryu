import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import {
	type KeyboardEvent,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { FLOW_LINE_STYLE, FlowCanvas } from "./flow-canvas.tsx";
import { isFlowTypingTarget, useFlowClock, useFlowSize } from "./flow-hooks.ts";
import {
	FlowCornerLogo,
	FlowLoading,
	FlowNewConversation,
	FlowStartOverlay,
	FlowZoomToolbar,
	useFlowMenuDismiss,
} from "./flow-interface-controls.tsx";
import {
	flowMenuPlacement,
	menuTitle,
	panelWidth,
	subjectFor,
} from "./flow-interface-geometry.ts";
import { FlowDetailsBody } from "./flow-interface-panel-body.tsx";
import { useFlowInterfaceView } from "./flow-interface-view.ts";
import { FlowConnectMenu } from "./flow-menu.tsx";
import {
	buildFlowLayout,
	connectSections,
	type FlowAction,
	type FlowChip,
	type FlowDirection,
	type FlowMenuSection,
	type FlowNode,
	type FlowTarget,
	firstNeedingYou,
	flowNeighbor,
	flowPath,
	flowStartActions,
} from "./flow-model.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

const ARROWS: Record<string, FlowDirection> = {
	ArrowDown: "down",
	ArrowLeft: "left",
	ArrowRight: "right",
	ArrowUp: "up",
};

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
	const tl = useLiteralMessages();

	const [engaged, setEngaged] = useState<string[]>([]);
	const [expanded, setExpanded] = useState<string[]>([]);
	const [composer, setComposer] = useState<FlowTarget | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const [focusId, setFocusId] = useState<string | null>(null);
	const [startOpen, setStartOpen] = useState(false);
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

	const {
		animateView,
		fitToScreen,
		panning,
		reveal,
		shown,
		userMoved,
		view,
		zoomBy,
	} = useFlowInterfaceView({
		highlighted,
		layout,
		panelW,
		size,
		viewportRef,
	});

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

	useFlowMenuDismiss(menuFor, startOpen, setMenuFor, setStartOpen);

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
	const { menuPosition, sections } = flowMenuPlacement({
		layout,
		menuFor,
		panelW,
		shown,
		size,
		snapshot,
	});
	const transition = reduceMotion
		? { duration: 0 }
		: { damping: 36, stiffness: 340, type: "spring" as const };

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
					<FlowStartOverlay
						choose={choose}
						reduceMotion={reduceMotion}
						starts={starts}
						transition={transition}
					/>
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
						title={menuTitle(layout, menuFor, tl)}
						top={menuPosition.top}
					/>
				) : null}

				{showStart ? null : <FlowCornerLogo />}

				{showStart || showLoading ? null : (
					<FlowNewConversation
						choose={choose}
						newSections={newSections}
						panelW={panelW}
						reduceMotion={reduceMotion}
						setStartOpen={setStartOpen}
						size={size}
						startOpen={startOpen}
						viewportRef={viewportRef}
					/>
				)}

				{showStart || showLoading ? null : (
					<FlowZoomToolbar
						fitToScreen={fitToScreen}
						shown={shown}
						zoomBy={zoomBy}
					/>
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
						<FlowDetailsBody
							activeThread={activeThread}
							now={now}
							port={port}
							selectedId={selectedId}
							setMenuFor={setMenuFor}
							setSelectedId={setSelectedId}
							snapshot={snapshot}
							subject={subject}
							threadView={threadView}
						/>
					</motion.aside>
				) : null}
			</AnimatePresence>
		</div>
	);
}
