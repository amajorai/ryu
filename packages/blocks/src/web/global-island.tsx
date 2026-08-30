"use client";

/*
 * The persistent floating Island for the marketing site — a 1:1 web mirror of the
 * real desktop Island (apps/island `Island.tsx` + `overlay.ts`). Mounted once in
 * the web root layout so it rides along on EVERY page alongside the header logo:
 * it docks bottom-left by default, collapsed to just the logo circle, and can be
 * dragged anywhere and snapped to the nearest of 9 zones — with the same dim
 * backdrop + dashed ghost outlines + glowing active target the real app shows.
 *
 * The split-morph shapes, the `island-siri-border` bottom-lit rim, the shape
 * skins and the island-config constants are all copied verbatim from the real
 * Island; the Electron window-sizing (footprint/setContentSize) and native drag
 * IPC are replaced with pure-DOM pointer drag + the shared `island-snap` math.
 */

import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { IslandChatView } from "../island/chat/island-chat.tsx";
import type { IslandChatMessage } from "../island/chat/message-list.tsx";
import { ExpandedPanelShell } from "../island/expanded-panel-shell.tsx";
import { IslandSuggestionChip } from "../island/suggestion-chip.tsx";
import {
	CONTENT_SPRING,
	DETAIL_SIZES,
	ISLAND_CSS,
	ISLAND_SPRING,
	type IslandAction,
	IslandActionPills,
	LOGO_CIRCLE,
	SHAPE_BASE,
	SPLIT_GAP,
	TRANSLUCENT_SKIN,
} from "./island-shapes.tsx";
import {
	EDGE_MARGIN_PX,
	nearestSnapZone,
	type Point,
	type Rect,
	SNAP_THRESHOLD_PX,
	zoneAnchorPosition,
} from "./island-snap.ts";
import {
	dismissIslandPromo,
	type IslandState,
	setIslandState,
	useIslandStore,
} from "./island-store.ts";
import ScratchCard from "./scratch-card.tsx";

// useLayoutEffect warns during SSR; fall back to useEffect on the server.
const useIsoLayoutEffect =
	typeof window === "undefined" ? useEffect : useLayoutEffect;

// Resting footprint used for snap math: logo(40) + gap(8) + idle pill(96).
const RESTING_PILL = { width: 144, height: 40 } as const;
// Where the island first docks: zone 6 = bottom-left.
const DEFAULT_ZONE = 6;
// Height of the fixed mobile bottom nav (`md:hidden` in mobile-nav.tsx). The
// island's snap area is inset by this on small screens so it docks above the bar
// instead of underneath/overlapping it (same collision the feedback launcher
// had). Matches the nav's 80px (`h-20`) height and the `md:` = 768px breakpoint.
const MOBILE_NAV_HEIGHT_PX = 80;
const MOBILE_BREAKPOINT_PX = 768;
// The nine snap zones, row-major (0 top-left … 8 bottom-right). Kept as an
// explicit list so the overlay maps over stable keys, not array indices.
const ZONES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

// The area the island may dock/drag within. On screens narrow enough to show the
// fixed bottom nav the bottom is inset by the nav height so zone 6/7/8 land
// above it.
function workArea(v: { width: number; height: number }): Rect {
	const navInset = v.width < MOBILE_BREAKPOINT_PX ? MOBILE_NAV_HEIGHT_PX : 0;
	return {
		x: 0,
		y: 0,
		width: v.width,
		height: Math.max(0, v.height - navInset),
	};
}

// Ghost/overlay corner radius: match the dragged island's shape, capped so a big
// panel is not over-rounded (verbatim from the real overlay.ts).
const GHOST_RADIUS = Math.min(RESTING_PILL.height / 2, 28);

// Width of the "Home" mini-island — narrower than the default action pill.
const HOME_PILL_WIDTH = 56;

/* ── action mini-islands (shapes live in island-shapes.tsx) ───────────────── */

function SuggestionActionPills({
	state,
	acceptLabel,
	onAccept,
	onSnooze,
	onDismiss,
	onHome,
}: {
	state: IslandState;
	acceptLabel: string;
	onAccept: () => void;
	onSnooze: () => void;
	onDismiss: () => void;
	onHome: () => void;
}) {
	if (state !== "suggestion") {
		return null;
	}
	const actions: IslandAction[] = [
		{ key: "accept", label: acceptLabel, onClick: onAccept, primary: true },
		{ key: "snooze", label: "Snooze", onClick: onSnooze },
		{ key: "dismiss", label: "Dismiss", onClick: onDismiss },
		{ key: "home", label: "Home", onClick: onHome, width: HOME_PILL_WIDTH },
	];
	return <IslandActionPills actions={actions} />;
}

/* ── the island detail content, by state ───────────────────────────────────── */

const ISLAND_REPLIES = [
	"On it. Running that locally on your server, nothing leaves the machine.",
	"Done. I pulled the action items and queued a follow-up for 9am.",
];

function ExpandedIslandChat({
	onClose,
	onHome,
}: {
	onClose: () => void;
	onHome: () => void;
}) {
	const [messages, setMessages] = useState<IslandChatMessage[]>([
		{
			id: "i0",
			role: "assistant",
			content: "I noticed you joined a call. Want me to take notes?",
		},
		{
			id: "i1",
			role: "user",
			content: "Yes, and ping me with the action items after.",
		},
	]);
	const replyIndex = useRef(0);
	const idSeq = useRef(2);

	const onSend = useCallback((text: string) => {
		const trimmed = text.trim();
		if (!trimmed) {
			return;
		}
		idSeq.current += 1;
		setMessages((prev) => [
			...prev,
			{ id: `u${idSeq.current}`, role: "user", content: trimmed },
		]);
		const reply = ISLAND_REPLIES[replyIndex.current % ISLAND_REPLIES.length];
		replyIndex.current += 1;
		setTimeout(() => {
			idSeq.current += 1;
			setMessages((prev) => [
				...prev,
				{ id: `a${idSeq.current}`, role: "assistant", content: reply },
			]);
		}, 550);
	}, []);

	return (
		<ExpandedPanelShell onClose={onClose} onHome={onHome} view="chat">
			<IslandChatView messages={messages} onSend={onSend} />
		</ExpandedPanelShell>
	);
}

// The launch-promo panel: a physical-style scratch card revealing the coupon.
function PromoScratchPanel({
	onClose,
	onHome,
}: {
	onClose: () => void;
	onHome: () => void;
}) {
	return (
		<ExpandedPanelShell onClose={onClose} onHome={onHome} view="chat">
			<div className="flex flex-1 items-center justify-center">
				<ScratchCard
					caption="Apply LAUNCH30 at checkout · limited-time launch offer."
					className="max-w-full border-white/10 bg-white/5 shadow-none"
					code="LAUNCH30"
					discountLabel="30%"
					headline="I have a 30% discount. Just scratch this card!"
					onNeverShowAgain={dismissIslandPromo}
				/>
			</div>
		</ExpandedPanelShell>
	);
}

function IslandDetailContent({
	state,
	hasPromo,
	onClose,
	onHome,
}: {
	state: IslandState;
	hasPromo: boolean;
	onClose: () => void;
	onHome: () => void;
}) {
	if (state === "expanded") {
		return <ExpandedIslandChat onClose={onClose} onHome={onHome} />;
	}
	if (state === "promo") {
		return <PromoScratchPanel onClose={onClose} onHome={onHome} />;
	}
	if (state === "suggestion") {
		return (
			<IslandSuggestionChip
				suggestion={
					hasPromo
						? {
								title: "I have a 30% discount 🎁",
								body: "Just scratch the card to reveal your code",
							}
						: {
								title: "Prep for your 3pm with Acme?",
								body: "I can draft a brief from last week's notes",
							}
				}
			/>
		);
	}
	// idle: the plain text pill (matches the live ContextPill with no live app).
	return <span className="font-medium text-neutral-100 text-sm">Ryu</span>;
}

/* ── the Island shell (split-morph copied verbatim from Island.tsx) ────────── */

function detailContentClassFor(state: IslandState): string {
	if (state === "expanded" || state === "promo") {
		return "flex h-full w-full items-stretch px-3 py-2";
	}
	if (state === "suggestion") {
		return "flex h-full w-full items-center px-3";
	}
	return "flex h-full w-full items-center justify-center px-4";
}

// The island column visual: logo + morphing detail + suggestion action pills.
// `dragHandlers` are spread onto the drag-grab surfaces (logo always; the detail
// strip only while it isn't the interactive expanded chat).
function IslandColumn({
	state,
	setState,
	dragHandlers,
	hasPromo,
	onHome,
}: {
	state: IslandState;
	setState: (s: IslandState) => void;
	dragHandlers: DragHandlers;
	hasPromo: boolean;
	onHome: () => void;
}) {
	const detail = DETAIL_SIZES[state];
	const detailContentClass = detailContentClassFor(state);
	const isOpen = state === "expanded" || state === "promo";
	// Collapsed/idle → tap opens chat; open → tap collapses back to logo only.
	const toggle = () => setState(isOpen ? "collapsed" : "expanded");
	const logoTap = () => {
		if (state === "collapsed" && window.location.pathname !== "/") {
			onHome();
			return;
		}
		toggle();
	};
	const collapse = () => setState("collapsed");
	const stripIsHandle = !isOpen;

	return (
		<div className="flex flex-col items-start">
			<div className="flex items-start" style={{ gap: SPLIT_GAP }}>
				<motion.div
					animate={{ scale: 1, opacity: 1 }}
					className={`${SHAPE_BASE} ${TRANSLUCENT_SKIN}`}
					initial={{ scale: 0.6, opacity: 0 }}
					style={{
						width: LOGO_CIRCLE.width,
						height: LOGO_CIRCLE.height,
						borderRadius: LOGO_CIRCLE.radius,
					}}
					transition={ISLAND_SPRING}
				>
					{/* The logo is the primary drag handle; a tap (no drag) toggles chat. */}
					<button
						aria-label={
							state === "collapsed" && window.location.pathname !== "/"
								? "Go to homepage"
								: "Drag Ryu island, tap to toggle"
						}
						className="absolute inset-0 z-10 cursor-grab touch-none bg-transparent active:cursor-grabbing"
						type="button"
						{...dragHandlers.forTap(logoTap)}
					/>
					<div className="flex h-full w-full items-center justify-center">
						<RyuLogo className="text-current" size="34px" variant="eyes" />
					</div>
				</motion.div>

				<AnimatePresence initial={false}>
					{detail ? (
						<motion.div
							animate={{
								width: detail.width,
								height: detail.height,
								borderRadius: detail.radius,
								opacity: 1,
							}}
							className={`${SHAPE_BASE} ${TRANSLUCENT_SKIN}`}
							exit={{ width: 0, opacity: 0 }}
							initial={{ width: 0, opacity: 0 }}
							key="detail"
							transition={ISLAND_SPRING}
						>
							<AnimatePresence initial={false} mode="wait">
								<motion.div
									animate={{ opacity: 1, scale: 1, y: 0 }}
									className={cn(
										detailContentClass,
										stripIsHandle &&
											"cursor-grab touch-none active:cursor-grabbing"
									)}
									exit={{ opacity: 0, scale: 0.92, y: -6 }}
									initial={{ opacity: 0, scale: 0.92, y: 6 }}
									key={state}
									transition={CONTENT_SPRING}
									{...(stripIsHandle
										? dragHandlers.forTap(
												state === "idle" ? toggle : () => undefined
											)
										: {})}
								>
									<IslandDetailContent
										hasPromo={hasPromo}
										onClose={collapse}
										onHome={onHome}
										state={state}
									/>
								</motion.div>
							</AnimatePresence>
						</motion.div>
					) : null}
				</AnimatePresence>
			</div>

			<SuggestionActionPills
				acceptLabel={hasPromo ? "Scratch" : "Accept"}
				onAccept={() => setState(hasPromo ? "promo" : "expanded")}
				onDismiss={collapse}
				onHome={onHome}
				onSnooze={collapse}
				state={state}
			/>
		</div>
	);
}

// Pointer handlers a grab surface spreads on itself. `forTap` binds a per-surface
// tap callback that only fires when the pointer didn't move (a real drag is never a tap).
interface DragHandlers {
	forTap: (onTap: () => void) => {
		onPointerDown: (e: React.PointerEvent) => void;
		onPointerMove: (e: React.PointerEvent) => void;
		onPointerUp: (e: React.PointerEvent) => void;
		onPointerCancel: (e: React.PointerEvent) => void;
		onClick: (e: React.MouseEvent) => void;
	};
}

const DRAG_START_THRESHOLD_PX = 4;
const NO_ACTIVE_ZONE = -1;

// The dim veil + 9 dashed ghost outlines + glowing active target shown while the
// island is being dragged — a DOM port of the real app's snap-zone overlay
// (apps/island/src/main/overlay.ts). `active` is the zone index the island will
// land in, or -1 when the drop is out of snap range (free-drop, no highlight).
function SnapZoneOverlay({
	shown,
	active,
	area,
}: {
	shown: boolean;
	active: number;
	area: Rect;
}) {
	const ghosts = useMemo(
		() =>
			ZONES.map((zone) => ({
				zone,
				anchor: zoneAnchorPosition(
					area,
					zone,
					RESTING_PILL.width,
					RESTING_PILL.height,
					EDGE_MARGIN_PX
				),
			})),
		[area]
	);

	return (
		<div
			className="island-zone-overlay pointer-events-none fixed inset-0 z-[119]"
			data-shown={shown ? "true" : "false"}
		>
			<div className="island-zone-backdrop" />
			{ghosts.map(({ zone, anchor }) => (
				<div
					className={`island-zone-ghost${zone === active ? "active" : ""}`}
					key={`island-zone-${zone}`}
					style={{
						left: anchor.x,
						top: anchor.y,
						width: RESTING_PILL.width,
						height: RESTING_PILL.height,
						borderRadius: GHOST_RADIUS,
					}}
				/>
			))}
		</div>
	);
}

// A free-floating Island that mirrors the real app: portaled over the whole page,
// dragged by the logo/strip, and snapped to the nearest of 9 zones on release —
// with the snap-zone overlay fading in while dragging.
function FloatingIsland({
	state,
	setState,
	hasPromo,
}: {
	state: IslandState;
	setState: (s: IslandState) => void;
	hasPromo: boolean;
}) {
	const [mounted, setMounted] = useState(false);
	const [viewport, setViewport] = useState({ width: 0, height: 0 });
	const [pos, setPos] = useState<Point>({ x: 0, y: 0 });
	const [render, setRender] = useState<Point>({ x: 0, y: 0 });
	const [dragging, setDragging] = useState(false);
	// Whether the drag has actually moved past the threshold (drives the overlay).
	const [snapping, setSnapping] = useState(false);
	const [activeZone, setActiveZone] = useState(NO_ACTIVE_ZONE);

	const containerRef = useRef<HTMLDivElement>(null);
	const renderRef = useRef<Point>({ x: 0, y: 0 });
	const posRef = useRef<Point>({ x: 0, y: 0 });
	const viewportRef = useRef({ width: 0, height: 0 });
	const draggingRef = useRef(false);
	const movedRef = useRef(false);
	const grabRef = useRef({ offX: 0, offY: 0, startX: 0, startY: 0 });

	renderRef.current = render;
	viewportRef.current = viewport;

	const applyPos = useCallback((p: Point) => {
		posRef.current = p;
		setPos(p);
	}, []);
	const goHome = useCallback(() => {
		if (window.location.pathname === "/") {
			setState("collapsed");
			window.scrollTo({ top: 0, behavior: "smooth" });
			return;
		}
		window.location.assign("/");
	}, [setState]);

	// Live-resolve the nearest snap zone from the current footprint center, so the
	// overlay highlights the zone the island would land in (mirrors resolveSnapZone).
	const resolveActiveZone = useCallback(() => {
		const area = workArea(viewportRef.current);
		const cur = posRef.current;
		const center = {
			x: cur.x + RESTING_PILL.width / 2,
			y: cur.y + RESTING_PILL.height / 2,
		};
		const snap = nearestSnapZone(
			area,
			center,
			RESTING_PILL,
			EDGE_MARGIN_PX,
			SNAP_THRESHOLD_PX
		);
		setActiveZone(snap.withinRange ? snap.index : NO_ACTIVE_ZONE);
		return snap;
	}, []);

	// Mount: dock at the default zone and track viewport size.
	useEffect(() => {
		setMounted(true);
		const measure = () => {
			const v = { width: window.innerWidth, height: window.innerHeight };
			setViewport(v);
			viewportRef.current = v;
			return v;
		};
		const v = measure();
		const area = workArea(v);
		const start = zoneAnchorPosition(
			area,
			DEFAULT_ZONE,
			RESTING_PILL.width,
			RESTING_PILL.height,
			EDGE_MARGIN_PX
		);
		applyPos(start);
		const onResize = () => measure();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [applyPos]);

	// Keep the whole footprint (including the expanded panel) on-screen by shifting
	// the render position inward — the expanded panel opens toward center, never off-edge.
	useIsoLayoutEffect(() => {
		if (!mounted) {
			return;
		}
		const el = containerRef.current;
		if (!(el && viewport.width)) {
			return;
		}
		const content = { width: el.offsetWidth, height: el.offsetHeight };
		const area = workArea(viewport);
		const minX = area.x + EDGE_MARGIN_PX;
		const minY = area.y + EDGE_MARGIN_PX;
		const maxX = area.x + area.width - content.width - EDGE_MARGIN_PX;
		const maxY = area.y + area.height - content.height - EDGE_MARGIN_PX;
		const nx = Math.round(
			Math.min(Math.max(pos.x, minX), Math.max(minX, maxX))
		);
		const ny = Math.round(
			Math.min(Math.max(pos.y, minY), Math.max(minY, maxY))
		);
		setRender((prev) =>
			prev.x === nx && prev.y === ny ? prev : { x: nx, y: ny }
		);
	}, [pos, state, viewport, mounted]);

	const dragHandlers: DragHandlers = {
		forTap: (onTap: () => void) => ({
			onPointerDown: (e: React.PointerEvent) => {
				if (e.button !== 0) {
					return;
				}
				// Start from the current rendered spot so the grab never jumps.
				const cur = renderRef.current;
				applyPos(cur);
				draggingRef.current = true;
				movedRef.current = false;
				setDragging(true);
				grabRef.current = {
					offX: e.clientX - cur.x,
					offY: e.clientY - cur.y,
					startX: e.clientX,
					startY: e.clientY,
				};
				try {
					e.currentTarget.setPointerCapture(e.pointerId);
				} catch {
					// pointer can't be captured (e.g. already released) — drag still works
				}
			},
			onPointerMove: (e: React.PointerEvent) => {
				if (!draggingRef.current) {
					return;
				}
				const g = grabRef.current;
				if (
					!movedRef.current &&
					Math.hypot(e.clientX - g.startX, e.clientY - g.startY) >
						DRAG_START_THRESHOLD_PX
				) {
					movedRef.current = true;
					// Real drag begun → reveal the snap-zone overlay.
					setSnapping(true);
				}
				applyPos({ x: e.clientX - g.offX, y: e.clientY - g.offY });
				if (movedRef.current) {
					resolveActiveZone();
				}
			},
			onPointerUp: (e: React.PointerEvent) => {
				if (!draggingRef.current) {
					return;
				}
				draggingRef.current = false;
				setDragging(false);
				setSnapping(false);
				setActiveZone(NO_ACTIVE_ZONE);
				try {
					e.currentTarget.releasePointerCapture(e.pointerId);
				} catch {
					// pointer already released
				}
				if (!movedRef.current) {
					onTap();
					return;
				}
				const v = viewportRef.current;
				const area = workArea(v);
				const cur = posRef.current;
				const center = {
					x: cur.x + RESTING_PILL.width / 2,
					y: cur.y + RESTING_PILL.height / 2,
				};
				const snap = nearestSnapZone(
					area,
					center,
					RESTING_PILL,
					EDGE_MARGIN_PX,
					SNAP_THRESHOLD_PX
				);
				if (snap.withinRange) {
					applyPos(
						zoneAnchorPosition(
							area,
							snap.index,
							RESTING_PILL.width,
							RESTING_PILL.height,
							EDGE_MARGIN_PX
						)
					);
				}
				// else: free drop — the clamp effect keeps it on-screen.
			},
			onPointerCancel: () => {
				draggingRef.current = false;
				setDragging(false);
				setSnapping(false);
				setActiveZone(NO_ACTIVE_ZONE);
			},
			// Keyboard-initiated clicks (Enter/Space on the focused logo) have detail 0
			// and no preceding pointer sequence, so route them to the tap without
			// double-firing alongside the pointer-up tap.
			onClick: (e: React.MouseEvent) => {
				if (e.detail === 0) {
					onTap();
				}
			},
		}),
	};

	if (!mounted) {
		return null;
	}

	return createPortal(
		<>
			{/* Static, in-repo CSS injected as a text child (no user input, no XSS surface). */}
			<style>{ISLAND_CSS}</style>
			<SnapZoneOverlay
				active={activeZone}
				area={workArea(viewport)}
				shown={snapping}
			/>
			<div className="pointer-events-none fixed inset-0 z-[120]">
				<motion.div
					animate={{ x: render.x, y: render.y }}
					className="pointer-events-auto absolute top-0 left-0 select-none"
					ref={containerRef}
					transition={dragging ? { duration: 0 } : ISLAND_SPRING}
				>
					<IslandColumn
						dragHandlers={dragHandlers}
						hasPromo={hasPromo}
						onHome={goHome}
						setState={setState}
						state={state}
					/>
				</motion.div>
			</div>
		</>,
		document.body
	);
}

/* ── the site-wide mount: reads the shared store, drives the one island ─────── */

// Mounted once in the web root layout so the island appears on every page.
export function GlobalIsland() {
	const { state, hasPromo, suppressed } = useIslandStore();
	// A surface that draws its own island (the landing hero's workflow loop) takes
	// the floor while it is on screen — except for a promo, which is the one
	// site-wide state allowed to interrupt the demo and open automatically.
	if (suppressed && state !== "promo") {
		return null;
	}
	return (
		<FloatingIsland
			hasPromo={hasPromo}
			setState={setIslandState}
			state={state}
		/>
	);
}

export default GlobalIsland;
