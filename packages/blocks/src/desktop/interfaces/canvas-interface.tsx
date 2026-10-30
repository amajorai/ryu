import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { CanvasParams } from "@ryuhq/protocol/interfaces";
import { AnimatePresence } from "motion/react";
import type { CSSProperties } from "react";
import { CanvasCard } from "./canvas-card.tsx";
import { CanvasComposer } from "./canvas-composer.tsx";
import { CanvasFrame } from "./canvas-frame.tsx";
import { useCanvasActions } from "./canvas-interface-actions.ts";
import {
	DOCK_EDGES_AFTER,
	DOCK_EDGES_BEFORE,
	MINIMAP_MIN_WIDTH,
	NO_EDGES,
	PHONE_DOCK_EDGES,
	PHONE_SIDE_EDGES,
} from "./canvas-interface-constants.ts";
import { useCanvasFit } from "./canvas-interface-fit.ts";
import { useCanvasKeyboard } from "./canvas-interface-keyboard.ts";
import { useCanvasPointer } from "./canvas-interface-pointer.ts";
import {
	useCanvasBase,
	useCanvasBoard,
	useCanvasCamera,
	useCanvasSelection,
} from "./canvas-interface-state.ts";
import { useCanvasView } from "./canvas-interface-view.ts";
import { CanvasMinimap } from "./canvas-minimap.tsx";
import {
	CARD_HEIGHT,
	CARD_WIDTH,
	cardPosition,
	centerOn,
	visibleWorldRect,
} from "./canvas-model.ts";
import { CanvasThreadPanel } from "./canvas-panel.tsx";
import {
	CanvasEdgeHints,
	CanvasEmpty,
	CanvasHeader,
	CanvasSkeleton,
} from "./canvas-parts.tsx";
import { CanvasToolbar } from "./canvas-toolbar.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";

/**
 * Canvas: threads as sticky notes on an infinite, zoomable board, first filed
 * into labelled frames (by status or by lead agent) and then wherever the
 * viewer drags them. Pan by dragging empty space, Space+drag, or the hand
 * tool; zoom with Ctrl/Cmd+wheel, pinch, or the dock. Double-click a sticky
 * (or press Enter) to open the host's real thread beside the canvas;
 * double-click empty canvas to write a new one right there.
 */
export function CanvasInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<CanvasParams>) {
	const tl = useLiteralMessages();
	const baseScope = useCanvasBase({
		activeThreadId,
		loading,
		params,
		port,
		snapshot,
		threadView,
	});
	const boardScope = { ...baseScope, ...useCanvasBoard(baseScope) };
	const cameraScope = { ...boardScope, ...useCanvasCamera(boardScope) };
	const stateScope = { ...cameraScope, ...useCanvasSelection(cameraScope) };
	const fitScope = { ...stateScope, ...useCanvasFit(stateScope) };
	const actionScope = { ...fitScope, ...useCanvasActions(fitScope) };
	const pointerScope = { ...actionScope, ...useCanvasPointer(actionScope) };
	const keyboard = useCanvasKeyboard(pointerScope);
	const view = useCanvasView(pointerScope);
	const {
		activeCard,
		arrange,
		camera,
		cameraRef,
		canPan,
		changeArrange,
		closeComposer,
		compact,
		composer,
		composerScreen,
		content,
		covered,
		drag,
		empty,
		fitView,
		frameFit,
		glide,
		grid,
		layout,
		livePosition,
		minimapCards,
		minimapFrames,
		minimapShown,
		moveCamera,
		movedByFrame,
		now,
		offscreen,
		onBlurCard,
		onDoubleClick,
		onFocusCard,
		onKeyDown,
		onKeyUp,
		onOpenCard,
		onPointerDown,
		onSelectCard,
		openComposerCentered,
		overlay,
		overrides,
		panning,
		phoneDock,
		resetLayout,
		resetZoom,
		revealOffscreen,
		rootRef,
		selectable,
		selectedCard,
		selectedId,
		setCameraNow,
		setMinimap,
		setSelectedId,
		setTool,
		showEdgeHints,
		submitComposer,
		summary,
		threadOpen,
		tiny,
		tool,
		viewport,
		viewportRef,
		zIndexOf,
		zoomBy,
		zoomToSelection,
	} = { ...pointerScope, ...keyboard, ...view };

	return (
		<div
			className="relative flex size-full min-h-0 overflow-hidden bg-background text-foreground"
			data-testid="interface-canvas"
			ref={rootRef}
		>
			<p aria-live="polite" className="sr-only" data-testid="canvas-announcer">
				{selectedCard
					? tl("Selected: {title}", {
							title: selectedCard.thread.title.trim() || "Untitled thread",
						})
					: ""}
			</p>
			<section
				aria-label="Canvas"
				className="@container relative min-w-0 flex-1 overflow-hidden"
				inert={covered}
				onKeyDown={onKeyDown}
				onKeyUp={onKeyUp}
				onScroll={(event) => event.currentTarget.scrollTo(0, 0)}
			>
				{/* The chrome comes first in tab order (header, then the tools), and
				    floats above the world. */}
				<div className="pointer-events-none absolute inset-0 z-10">
					<div className="absolute top-3 left-3 max-w-[calc(100%-1.5rem)]">
						<CanvasHeader
							arrange={arrange}
							loading={loading}
							onArrange={changeArrange}
							summary={summary}
						/>
					</div>
					<div
						className="absolute inset-x-0 bottom-4 flex items-center justify-center gap-2 px-3"
						data-canvas-keeps-selection=""
					>
						{showEdgeHints && offscreen && !phoneDock ? (
							<CanvasEdgeHints
								edges={DOCK_EDGES_BEFORE}
								inline
								offscreen={offscreen}
								onReveal={revealOffscreen}
							/>
						) : null}
						<CanvasToolbar
							canReset={Object.keys(overrides).length > 0}
							canZoomToSelection={selectable}
							disabled={loading || empty}
							minimap={
								loading || empty || viewport.width < MINIMAP_MIN_WIDTH
									? undefined
									: {
											onToggle: () =>
												setMinimap(minimapShown ? "hidden" : "shown"),
											shown: minimapShown,
										}
							}
							onFit={() => fitView()}
							onNewThread={openComposerCentered}
							onResetLayout={resetLayout}
							onResetZoom={resetZoom}
							onTool={setTool}
							onZoom={zoomBy}
							onZoomToSelection={zoomToSelection}
							tool={tool}
							zoom={camera.zoom}
						/>
						{showEdgeHints && offscreen ? (
							<CanvasEdgeHints
								edges={phoneDock ? PHONE_DOCK_EDGES : DOCK_EDGES_AFTER}
								inline
								offscreen={offscreen}
								onReveal={revealOffscreen}
							/>
						) : null}
					</div>
					{empty ? (
						<CanvasEmpty
							hasAgents={snapshot.agents.length > 0}
							onNewThread={openComposerCentered}
						/>
					) : null}
					{showEdgeHints && offscreen ? (
						<CanvasEdgeHints
							edges={phoneDock ? PHONE_SIDE_EDGES : NO_EDGES}
							offscreen={offscreen}
							onReveal={revealOffscreen}
						/>
					) : null}
					{!(loading || empty) && minimapShown ? (
						<div className="absolute right-4 bottom-4">
							<CanvasMinimap
								cards={minimapCards}
								content={content}
								frames={minimapFrames}
								onNavigate={(point) =>
									setCameraNow(centerOn(cameraRef.current, point, viewport))
								}
								visible={visibleWorldRect(camera, viewport)}
							/>
						</div>
					) : null}
					{composer && composerScreen ? (
						<CanvasComposer
							agents={snapshot.agents}
							defaultAgentId={composer.agentId}
							key={`${composer.world.x}:${composer.world.y}`}
							left={composerScreen.x}
							onClose={closeComposer}
							onSubmit={submitComposer}
							top={composerScreen.y}
							world={composer.world}
							zoom={camera.zoom}
						/>
					) : null}
				</div>

				<div
					aria-label="Thread canvas. Drag to pan, double-click to start a thread."
					aria-roledescription="canvas"
					className={cn(
						"peer absolute inset-0 touch-none select-none overflow-hidden outline-none",
						canPan && "cursor-grab",
						panning && "cursor-grabbing"
					)}
					data-canvas-viewport=""
					data-testid="canvas-viewport"
					onDoubleClick={onDoubleClick}
					onPointerDown={onPointerDown}
					onScroll={(event) => event.currentTarget.scrollTo(0, 0)}
					ref={viewportRef}
					role="application"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the canvas is a keyboard-driven pan/zoom surface (role="application").
					tabIndex={0}
				>
					<div
						aria-hidden="true"
						className="pointer-events-none absolute inset-0 text-muted-foreground/35"
						style={{
							backgroundImage:
								"radial-gradient(circle, currentColor 1px, transparent 1.3px)",
							backgroundPosition: `${camera.x}px ${camera.y}px`,
							backgroundSize: `${grid}px ${grid}px`,
						}}
					/>
					{loading ? (
						<CanvasSkeleton />
					) : (
						<div
							className={cn(
								"absolute top-0 left-0 origin-top-left will-change-transform",
								canPan && "[&_*]:cursor-[inherit]"
							)}
							data-testid="canvas-world"
							style={
								{
									"--canvas-scale": 1 / camera.zoom,
									transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.zoom})`,
								} as CSSProperties
							}
						>
							<AnimatePresence initial={false}>
								{layout.frames.map((frame) => (
									<CanvasFrame
										frame={frame}
										gliding={glide !== null}
										key={frame.id}
										moved={movedByFrame.get(frame.id) ?? 0}
										rect={frameFit.rects.get(frame.id) ?? frame.rect}
										vacant={frame.threadIds.every((id) =>
											frameFit.loose.has(id)
										)}
									/>
								))}
							</AnimatePresence>
							{layout.cards.map((card) => {
								const point =
									drag?.id === card.id
										? drag.point
										: cardPosition(card, overrides);
								return (
									<CanvasCard
										card={card}
										compact={compact}
										dragging={drag?.id === card.id}
										gliding={glide !== null && glide.except !== card.id}
										key={card.id}
										loose={frameFit.loose.has(card.id)}
										now={now}
										onBlurCard={onBlurCard}
										onFocusCard={onFocusCard}
										onOpenCard={onOpenCard}
										onSelectCard={onSelectCard}
										open={card.id === activeThreadId && threadOpen}
										selected={card.id === selectedId}
										showGroup={arrange === "status"}
										tiny={tiny}
										x={point.x}
										y={point.y}
										z={zIndexOf(card.id)}
									/>
								);
							})}
						</div>
					)}
				</div>
				{/* The canvas's focus ring, drawn above the world (frames and stickies
				    would otherwise cut it up) and under the chrome. */}
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 z-[5] rounded-[inherit] opacity-0 ring-2 ring-ring ring-inset peer-focus-visible:opacity-100"
					data-testid="canvas-focus-ring"
				/>
			</section>
			<AnimatePresence>
				{threadView ? (
					<CanvasThreadPanel
						card={activeCard}
						key="canvas-thread-panel"
						onClose={() => port.closeThread()}
						onLocate={
							activeCard
								? () => {
										const point = livePosition(activeCard.id);
										if (point) {
											setSelectedId(activeCard.id);
											moveCamera(
												centerOn(
													cameraRef.current,
													{
														x: point.x + CARD_WIDTH / 2,
														y: point.y + CARD_HEIGHT / 2,
													},
													viewport
												)
											);
										}
									}
								: undefined
						}
						overlay={overlay}
						threadView={threadView}
					/>
				) : null}
			</AnimatePresence>
		</div>
	);
}
