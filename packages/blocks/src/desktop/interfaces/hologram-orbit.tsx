import { cn } from "@ryu/ui/lib/utils";
import { Pause, Play } from "lucide-react";
import {
	type FocusEvent as ReactFocusEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { HoloCore } from "./hologram-core.tsx";
import { useElementSize, useRingSpin } from "./hologram-hooks.ts";
import {
	type HoloAgent,
	type HologramView,
	type MenuItemPlacement,
	normalizeAngle,
	polar,
	type RingSlot,
	radialMenuLayout,
	ringSlots,
} from "./hologram-model.ts";
import {
	CornerBrackets,
	HUD_INTERACTIVE,
	HUD_LABEL,
} from "./hologram-parts.tsx";

/**
 * Node labels sit on a plate of the deck tone, so a spoke running under
 * them stops at the text instead of striking through it.
 */
const LABEL_PLATE = "bg-(--holo-deck) px-1";

const NODE = 48;
const NODE_RADIUS = NODE / 2 - 2;
/** Room a node and its label need around the ring's edge. */
const NODE_MARGIN_X = 64;
const NODE_MARGIN_Y = 76;
/** Below this ring radius, nodes show their name only and hug the edge. */
const COMPACT_RADIUS = 170;
const COMPACT_MARGIN_X = 36;
const COMPACT_MARGIN_Y = 56;
/** How far out the menu items' near edges sit, from the node centre. */
const MENU_RADIUS = 42;
/** The name label's top edge and line height, from the node centre. */
const LABEL_TOP = NODE / 2 + 10;
const LABEL_LINE = 16;
/** Half the widest a name label gets: its w-36 slot. */
const LABEL_MAX_HALF = 72;

/** The tracked count line under the name (10px mono, 0.16em tracking). */
const META_LINE = 18;

/** A node's count line, e.g. "2 threads". */
export function threadCountLabel(count: number): string {
	return `${count} ${count === 1 ? "thread" : "threads"}`;
}

/**
 * The node's name and count lines, from the node centre, so the open menu
 * keeps clear of them.
 */
export function labelKeepOut(
	name: string,
	meta = ""
): {
	bottom: number;
	left: number;
	right: number;
	top: number;
} {
	const half = Math.min(
		LABEL_MAX_HALF,
		Math.max(Math.ceil(name.length * 3.6), Math.ceil(meta.length * 4.4)) + 4
	);
	return {
		bottom: LABEL_TOP + LABEL_LINE + (meta ? META_LINE : 0) + 2,
		left: -half,
		right: half,
		top: LABEL_TOP - 2,
	};
}
/** Focus that came from the keyboard (a click focuses without `:focus-visible`). */
function isKeyboardFocus(element: Element): boolean {
	try {
		return element.matches(":focus-visible");
	} catch {
		return false;
	}
}

/** Keeps the ring still this long after a press, so touch can land on a node. */
const PRESS_HOLD_MS = 1000;

export type RadialAction = "message" | "open-latest" | "show-threads";

const MENU_ITEMS: { action: RadialAction; label: string }[] = [
	{ action: "message", label: "Message" },
	{ action: "open-latest", label: "Open latest" },
	{ action: "show-threads", label: "Show threads" },
];

/**
 * A menu item's box: a tracked 10px mono label (about 7.6px a character)
 * with 8px either side.
 */
export function menuItemSize(label: string): { height: number; width: number } {
	return { height: 24, width: Math.ceil(label.length * 7.6 + 16) };
}

const MENU_SIZES = MENU_ITEMS.map((item) => menuItemSize(item.label));

interface Geometry {
	/** Name-only node labels, for small decks. */
	compact: boolean;
	coreDiameter: number;
	radii: [number, number];
}

/** Ring radii and core size that fit the measured box. */
export function orbitGeometry(
	width: number,
	height: number,
	rings: number
): Geometry {
	const fitRadius = (marginX: number, marginY: number) =>
		Math.max(96, Math.min(width / 2 - marginX, height / 2 - marginY));
	let outer = fitRadius(NODE_MARGIN_X, NODE_MARGIN_Y);
	const compact = outer < COMPACT_RADIUS;
	if (compact) {
		outer = fitRadius(COMPACT_MARGIN_X, COMPACT_MARGIN_Y);
	}
	const inner = rings > 1 ? Math.max(84, outer * 0.62) : outer;
	const coreDiameter = Math.round(
		Math.max(96, Math.min(248, (inner - NODE - 16) * 2))
	);
	return {
		compact,
		coreDiameter,
		radii: [Math.round(inner), Math.round(outer)],
	};
}

/** Spin direction and speed per ring: the outer ring turns back, slower. */
const RING_SPIN = [
	"var(--holo-spin, 0deg)",
	"calc(var(--holo-spin, 0deg) * -0.6)",
] as const;

function anchorTransform(slot: RingSlot, radius: number): string {
	const turn = `calc(${slot.angle}deg + ${RING_SPIN[slot.ring]})`;
	const back = `calc(-${slot.angle}deg - ${RING_SPIN[slot.ring]})`;
	return `rotate(${turn}) translateY(-${radius}px) rotate(${back})`;
}

function nodeLabel(agent: HoloAgent): string {
	const parts = [
		agent.name,
		agent.status === "working" ? "working" : "idle",
		`${agent.threadCount} ${agent.threadCount === 1 ? "thread" : "threads"}`,
	];
	if (agent.failed > 0) {
		parts.push(`${agent.failed} failed`);
	}
	if (agent.needsYou > 0) {
		parts.push(
			`${agent.needsYou} ${agent.needsYou === 1 ? "needs" : "need"} you`
		);
	}
	return parts.join(", ");
}

/** Thread ticks around a node: one per thread, this far apart, at most this many. */
const TICK_STEP = 24;
const TICK_MAX = 360 / TICK_STEP;
const TICK_INNER = NODE_RADIUS + 4;
const TICK_OUTER = NODE_RADIUS + 9;
/** The working sweep's length on the rim, in degrees. */
const SWEEP = 96;

/**
 * Tick tones in order: failed runs, then replies owed, live runs, the rest;
 * they sit on a hairline track, so a short run of ticks reads as a segment.
 */
function tickTones(agent: HoloAgent): string[] {
	const tones: string[] = [];
	const push = (count: number, tone: string) => {
		for (let index = 0; index < count && tones.length < TICK_MAX; index++) {
			tones.push(tone);
		}
	};
	const needsYou = Math.max(0, agent.needsYou - agent.failed);
	push(agent.failed, "stroke-(--holo-alert)");
	push(needsYou, "stroke-(--holo-turn)");
	push(agent.workingThreads, "stroke-(--holo-ink)");
	push(
		agent.threadCount - agent.failed - needsYou - agent.workingThreads,
		"stroke-(--holo-dim)"
	);
	return tones;
}

/** An arc on a circle round the origin, clockwise from `from` to `to` degrees. */
function arcPath(radius: number, from: number, to: number): string {
	const start = polar(from, radius);
	const end = polar(to, radius);
	const large = normalizeAngle(to - from) > 180 ? 1 : 0;
	return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${large} 1 ${end.x} ${end.y}`;
}

/**
 * The node's badge: avatar or initials in a disc, one tick per thread on a
 * ring outside it (toned by what each thread needs), and, while the agent
 * works, a lit sweep turning round the rim. `marked` gives the rim a solid
 * ink edge (the agent is targeted or its threads are open).
 */
function NodeBadge({
	agent,
	marked,
	reduceMotion,
}: {
	agent: HoloAgent;
	marked: boolean;
	reduceMotion: boolean;
}) {
	const working = agent.status === "working";
	const tones = tickTones(agent);
	return (
		<span className="relative block size-12">
			<svg
				aria-hidden="true"
				className="absolute inset-0 overflow-visible"
				height={NODE}
				viewBox={`${-NODE / 2} ${-NODE / 2} ${NODE} ${NODE}`}
				width={NODE}
			>
				<circle
					className={cn(
						"fill-(--holo-deck)",
						marked || working ? "stroke-(--holo-ink)" : "stroke-(--holo-line)"
					)}
					r={NODE_RADIUS}
					strokeWidth={marked ? 2 : 1}
				/>
				<circle
					className={working ? "fill-(--holo-ink)/14" : "fill-(--holo-ink)/5"}
					r={NODE_RADIUS - 1}
				/>
				<circle
					className="stroke-(--holo-line)"
					fill="none"
					r={(TICK_INNER + TICK_OUTER) / 2}
					strokeWidth={1}
				/>
				{tones.map((tone, index) => {
					const angle = index * TICK_STEP;
					const from = polar(angle, TICK_INNER);
					const to = polar(angle, TICK_OUTER);
					return (
						<line
							className={tone}
							// biome-ignore lint/suspicious/noArrayIndexKey: ticks are positional
							key={index}
							strokeWidth={3}
							x1={from.x}
							x2={to.x}
							y1={from.y}
							y2={to.y}
						/>
					);
				})}
			</svg>
			{working ? (
				<svg
					aria-hidden="true"
					className={cn(
						"absolute inset-0 overflow-visible",
						!reduceMotion && "motion-safe:animate-[spin_1.8s_linear_infinite]"
					)}
					height={NODE}
					viewBox={`${-NODE / 2} ${-NODE / 2} ${NODE} ${NODE}`}
					width={NODE}
				>
					<path
						className="stroke-(--holo-ink)"
						d={arcPath(NODE_RADIUS, 0, SWEEP)}
						fill="none"
						strokeLinecap="round"
						strokeWidth={3}
					/>
				</svg>
			) : null}
			{agent.agent.avatarUrl ? (
				<img
					alt=""
					className="absolute inset-[6px] size-9 rounded-full object-cover"
					height={36}
					src={agent.agent.avatarUrl}
					width={36}
				/>
			) : (
				<span
					className={cn(
						"absolute inset-0 flex items-center justify-center font-medium font-mono text-[14px]",
						working ? "text-(--holo-ink)" : "text-(--holo-text)"
					)}
				>
					{agent.initials}
				</span>
			)}
		</span>
	);
}

/** The arc the open menu's items hang off, just outside the thread ticks. */
const MENU_ARC = TICK_OUTER + 4;

/**
 * The arc through the fan, from the item that is furthest anticlockwise to
 * the one furthest clockwise.
 */
function menuArcPath(placements: MenuItemPlacement[]): string {
	const first = placements[0];
	if (!first) {
		return "";
	}
	// Offsets from the first item, so the fan reads as one span even when
	// it crosses 12 o'clock.
	const offsets = placements.map(
		(place) => normalizeAngle(place.angle - first.angle + 180) - 180
	);
	const from = first.angle + Math.min(...offsets);
	const to = first.angle + Math.max(...offsets);
	return arcPath(MENU_ARC, from, to);
}

function RadialMenu({
	agent,
	nodeId,
	onAction,
	onClose,
	placements,
}: {
	agent: HoloAgent;
	/** The node that opened the menu; focus moving back to it keeps nothing open. */
	nodeId: string;
	onAction: (action: RadialAction) => void;
	/** Closes the menu; `refocus` returns focus to the node. */
	onClose: (refocus: boolean) => void;
	placements: MenuItemPlacement[];
}) {
	const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
	useEffect(() => {
		itemsRef.current[0]?.focus({ preventScroll: true });
	}, []);
	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		const items = itemsRef.current.filter(
			(item): item is HTMLButtonElement => item !== null && !item.disabled
		);
		const index = items.indexOf(document.activeElement as HTMLButtonElement);
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onClose(true);
			return;
		}
		let step = 0;
		if (event.key === "ArrowDown" || event.key === "ArrowRight") {
			step = 1;
		} else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
			step = -1;
		}
		if (step !== 0 && items.length > 0) {
			event.preventDefault();
			items[(index + step + items.length) % items.length]?.focus();
		}
	};
	return (
		<div
			aria-label={`${agent.name} actions`}
			className="absolute top-6 left-6 z-40"
			data-holo-menu={nodeId}
			onBlur={(event) => {
				const next = event.relatedTarget;
				if (next instanceof Node && event.currentTarget.contains(next)) {
					return;
				}
				onClose(false);
			}}
			onKeyDown={onKeyDown}
			role="menu"
		>
			<svg
				aria-hidden="true"
				className="pointer-events-none absolute overflow-visible"
				height={1}
				width={1}
			>
				<path
					className="stroke-(--holo-ink)"
					d={menuArcPath(placements)}
					fill="none"
					strokeWidth={1}
				/>
				{placements.map((place, index) => {
					const from = polar(place.angle, MENU_ARC - 3);
					const to = polar(place.angle, MENU_ARC + 3);
					return (
						<line
							className="stroke-(--holo-ink)"
							key={MENU_ITEMS[index]?.action ?? index}
							strokeWidth={1}
							x1={from.x}
							x2={to.x}
							y1={from.y}
							y2={to.y}
						/>
					);
				})}
			</svg>
			{MENU_ITEMS.map((item, index) => {
				const place = placements[index] ?? {
					angle: 0,
					left: 0,
					reach: MENU_RADIUS,
					top: 0,
				};
				const disabled =
					item.action === "open-latest" && agent.latestThreadId === null;
				return (
					<button
						className={cn(
							HUD_LABEL,
							"absolute flex h-6 items-center justify-center whitespace-nowrap rounded-sm bg-(--holo-deck) px-2 text-(--holo-text) outline-none transition-colors duration-150 hover:bg-(--holo-ink) hover:text-(--holo-deck) focus-visible:bg-(--holo-ink) focus-visible:text-(--holo-deck) active:bg-(--holo-ink)/80 disabled:pointer-events-none disabled:text-(--holo-faint) motion-safe:animate-[holo-pop_140ms_cubic-bezier(0.2,0,0,1)_backwards]"
						)}
						disabled={disabled}
						key={item.action}
						onClick={() => onAction(item.action)}
						ref={(node) => {
							itemsRef.current[index] = node;
						}}
						role="menuitem"
						style={{
							animationDelay: `${index * 30}ms`,
							left: place.left,
							top: place.top,
							width: MENU_SIZES[index]?.width,
						}}
						tabIndex={index === 0 ? 0 : -1}
						type="button"
					>
						{item.label}
					</button>
				);
			})}
		</div>
	);
}

/**
 * The agent ring: one or two rotating rings of agent nodes around the core,
 * each tied to it by a thin line (animated for agents that are working).
 * Selecting a node pauses the ring and fans out its radial menu.
 */
export function HoloOrbit({
	children,
	loading,
	onAction,
	onSelect,
	pinnedId = null,
	reduceMotion,
	selectedId,
	targetId = null,
	view,
}: {
	/** Shown under the core when there is nothing on the ring. */
	children?: ReactNode;
	loading: boolean;
	onAction: (agentId: string, action: RadialAction) => void;
	onSelect: (agentId: string | null) => void;
	/** The agent whose threads the side panel shows; its node stays marked. */
	pinnedId?: string | null;
	reduceMotion: boolean;
	selectedId: string | null;
	/** The agent the command bar is addressed to; its node stays bracketed. */
	targetId?: string | null;
	view: HologramView;
}) {
	const boxRef = useRef<HTMLDivElement>(null);
	const spinRef = useRef<HTMLDivElement>(null);
	const angleRef = useRef(0);
	const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
	const { height, width } = useElementSize(boxRef);
	const [hovered, setHovered] = useState(false);
	/** The viewer paused the rings, or they settled after a full turn. */
	const [held, setHeld] = useState(false);
	const settle = useCallback(() => setHeld(true), []);
	const [pressed, setPressed] = useState(false);
	const [focusWithin, setFocusWithin] = useState(false);
	/** The node that takes the ring's single Tab stop (roving focus). */
	const [rovingId, setRovingId] = useState<string | null>(null);
	const hintId = useId();
	const pressTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined
	);
	useEffect(() => () => clearTimeout(pressTimerRef.current), []);
	const holdAfterPress = () => {
		setPressed(true);
		clearTimeout(pressTimerRef.current);
		pressTimerRef.current = setTimeout(() => setPressed(false), PRESS_HOLD_MS);
	};
	const slots = useMemo(
		() => ringSlots(view.agents.map((agent) => agent.id)),
		[view.agents]
	);
	const rings = slots.some((slot) => slot.ring === 1) ? 2 : 1;
	const geometry = orbitGeometry(width, height, rings);
	const byId = useMemo(
		() => new Map(view.agents.map((agent) => [agent.id, agent])),
		[view.agents]
	);
	const canSpin = !(reduceMotion || loading);
	useRingSpin(
		spinRef,
		angleRef,
		canSpin,
		held || hovered || pressed || focusWithin || selectedId !== null,
		settle
	);

	useEffect(() => {
		if (selectedId === null) {
			return;
		}
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && spinRef.current?.contains(target)) {
				const node =
					target instanceof Element ? target.closest("[data-holo-node]") : null;
				if (node) {
					return;
				}
			}
			onSelect(null);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [selectedId, onSelect]);

	const focusNode = (id: string) => nodeRefs.current.get(id)?.focus();
	const closeMenu = (refocus: boolean) => {
		const id = selectedId;
		onSelect(null);
		if (refocus && id) {
			focusNode(id);
		}
	};
	const onNodeKeyDown = (
		event: ReactKeyboardEvent<HTMLButtonElement>,
		id: string
	) => {
		const order = slots.map((slot) => slot.id);
		const index = order.indexOf(id);
		const step =
			event.key === "ArrowRight" || event.key === "ArrowDown"
				? 1
				: event.key === "ArrowLeft" || event.key === "ArrowUp"
					? -1
					: 0;
		if (step !== 0) {
			event.preventDefault();
			focusNode(order[(index + step + order.length) % order.length] ?? id);
		}
	};
	const screenAngle = (slot: RingSlot) =>
		normalizeAngle(
			slot.angle + (slot.ring === 1 ? -0.6 : 1) * angleRef.current
		);
	/**
	 * Tabbing into the ring for the first time lands on the topmost node
	 * (wherever the spin has carried it); after that, on the last one used.
	 */
	const onNodeFocus = (
		event: ReactFocusEvent<HTMLButtonElement>,
		id: string
	) => {
		const from = event.relatedTarget;
		const fromRing =
			from instanceof Element && from.closest("[data-holo-node]") !== null;
		if (
			rovingId === null &&
			!fromRing &&
			isKeyboardFocus(event.currentTarget)
		) {
			const fromTop = (slot: RingSlot) => {
				const angle = screenAngle(slot);
				return Math.min(angle, 360 - angle);
			};
			const topmost = [...slots].sort((a, b) => fromTop(a) - fromTop(b))[0];
			if (topmost && topmost.id !== id) {
				setRovingId(topmost.id);
				focusNode(topmost.id);
				return;
			}
		}
		setRovingId(id);
	};

	const showRing = width > 0 && height > 0;
	const menuFor = (slot: RingSlot) => {
		const angle = screenAngle(slot);
		const point = polar(angle, geometry.radii[slot.ring]);
		const agent = byId.get(slot.id);
		return radialMenuLayout({
			box: { height, width },
			items: MENU_SIZES,
			keepOut: labelKeepOut(
				agent?.name ?? "",
				geometry.compact || !agent ? "" : threadCountLabel(agent.threadCount)
			),
			nodeX: width / 2 + point.x,
			nodeY: height / 2 + point.y,
			outward: angle,
			radius: MENU_RADIUS,
		});
	};

	return (
		<div
			className="relative size-full min-h-0"
			onPointerLeave={() => setHovered(false)}
			onPointerMove={() => {
				if (!hovered) {
					setHovered(true);
				}
			}}
			ref={boxRef}
		>
			<div
				className="absolute inset-0"
				onBlur={(event) => {
					if (
						!event.currentTarget.contains(event.relatedTarget as Node | null)
					) {
						setFocusWithin(false);
					}
				}}
				onFocus={() => setFocusWithin(true)}
				onPointerDown={holdAfterPress}
				ref={spinRef}
			>
				{showRing ? (
					<svg
						aria-hidden="true"
						className="pointer-events-none absolute inset-0 overflow-visible"
						height={height}
						viewBox={`${-width / 2} ${-height / 2} ${width} ${height}`}
						width={width}
					>
						{(rings > 1 ? [0, 1] : [0]).map((ring) => (
							<circle
								className="stroke-(--holo-line)"
								fill="none"
								key={`track-${ring}`}
								r={geometry.radii[ring]}
								strokeDasharray="1 7"
								strokeWidth={1}
							/>
						))}
						{loading
							? null
							: slots.map((slot) => {
									const agent = byId.get(slot.id);
									const radius = geometry.radii[slot.ring];
									// Core rim to the node's tick ring, on the true radial.
									const from = polar(slot.angle, geometry.coreDiameter / 2 + 6);
									const to = polar(slot.angle, radius - TICK_OUTER - 4);
									const live = agent?.status === "working";
									// The open menu's leaders take over; the spoke would cross them.
									if (slot.id === selectedId) {
										return null;
									}
									return (
										<g
											key={`line-${slot.id}`}
											style={{ transform: `rotate(${RING_SPIN[slot.ring]})` }}
										>
											<line
												className={
													live
														? "stroke-(--holo-ink)/40"
														: "stroke-(--holo-line)"
												}
												strokeWidth={1}
												x1={from.x}
												x2={to.x}
												y1={from.y}
												y2={to.y}
											/>
											{live ? (
												<line
													className={cn(
														"stroke-(--holo-ink)",
														!reduceMotion &&
															"motion-safe:animate-[holo-dash_1.2s_linear_infinite]"
													)}
													strokeDasharray="4 12"
													strokeWidth={1.5}
													x1={to.x}
													x2={from.x}
													y1={to.y}
													y2={from.y}
												/>
											) : null}
										</g>
									);
								})}
					</svg>
				) : null}
				{showRing ? (
					<HoloCore
						diameter={geometry.coreDiameter}
						dimmed={loading}
						distribution={view.distribution}
						pulse={view.pulse}
						reduceMotion={reduceMotion}
						totals={view.totals}
					/>
				) : null}
				{showRing && !loading ? (
					<>
						<p className="sr-only" id={hintId}>
							Arrow keys move around the ring. Enter opens an agent's actions.
						</p>
						<ul
							aria-describedby={hintId}
							aria-label="Agents"
							className="absolute top-1/2 left-1/2 size-0"
						>
							{slots.map((slot) => {
								const agent = byId.get(slot.id);
								if (!agent) {
									return null;
								}
								const selected = selectedId === agent.id;
								const targeted = targetId === agent.id;
								const marked = targeted || pinnedId === agent.id;
								const placements = selected ? menuFor(slot) : [];
								const tabStop = (rovingId ?? slots[0]?.id) === agent.id;
								return (
									<li
										className={cn(
											"absolute top-0 left-0",
											selected ? "z-20" : "z-10"
										)}
										key={agent.id}
										style={{
											transform: anchorTransform(
												slot,
												geometry.radii[slot.ring]
											),
										}}
									>
										<div className="absolute -top-6 -left-6" data-holo-node="">
											<button
												aria-expanded={selected}
												aria-haspopup="menu"
												aria-label={nodeLabel(agent)}
												className="group flex flex-col items-center rounded-full outline-none"
												data-agent-id={agent.id}
												data-targeted={targeted ? "" : undefined}
												onClick={() => onSelect(selected ? null : agent.id)}
												onFocus={(event) => onNodeFocus(event, agent.id)}
												onKeyDown={(event) => onNodeKeyDown(event, agent.id)}
												ref={(node) => {
													if (node) {
														nodeRefs.current.set(agent.id, node);
													} else {
														nodeRefs.current.delete(agent.id);
													}
												}}
												tabIndex={tabStop ? 0 : -1}
												type="button"
											>
												<span className="relative rounded-full transition-transform duration-150 group-hover:scale-105 group-active:scale-100">
													<NodeBadge
														agent={agent}
														marked={marked}
														reduceMotion={reduceMotion}
													/>
													<span
														aria-hidden="true"
														className={cn(
															"pointer-events-none absolute -inset-2",
															targeted && !selected
																? "block"
																: "hidden group-focus-visible:block"
														)}
													>
														<CornerBrackets />
													</span>
												</span>
												<span className="absolute top-full mt-2.5 flex w-36 justify-center">
													<span className="flex max-w-full flex-col items-center">
														<span
															className={cn(
																"max-w-full truncate font-medium text-[13px] leading-4",
																LABEL_PLATE,
																targeted
																	? "text-(--holo-ink)"
																	: "text-(--holo-text)"
															)}
														>
															{agent.name}
														</span>
														<span
															className={cn(
																HUD_LABEL,
																LABEL_PLATE,
																"pt-0.5 tabular-nums",
																agent.status === "working"
																	? "text-(--holo-ink)"
																	: "text-(--holo-dim)",
																geometry.compact && "hidden"
															)}
														>
															{threadCountLabel(agent.threadCount)}
														</span>
													</span>
												</span>
											</button>
											{selected ? (
												<RadialMenu
													agent={agent}
													nodeId={agent.id}
													onAction={(action) => onAction(agent.id, action)}
													onClose={closeMenu}
													placements={placements}
												/>
											) : null}
										</div>
									</li>
								);
							})}
						</ul>
					</>
				) : null}
				{children ? (
					<div
						className="absolute inset-x-0 flex justify-center"
						style={{ top: `calc(50% + ${geometry.coreDiameter / 2 + 24}px)` }}
					>
						{children}
					</div>
				) : null}
			</div>
			{canSpin && view.agents.length > 0 ? (
				<button
					className={cn(
						HUD_LABEL,
						HUD_INTERACTIVE,
						"absolute top-1 left-0 z-10 flex h-7 items-center gap-2 rounded-sm px-2 text-(--holo-dim) hover:text-(--holo-text)"
					)}
					onClick={() => setHeld((current) => !current)}
					title={held ? "Resume ring rotation" : "Pause ring rotation"}
					type="button"
				>
					{held ? (
						<Play aria-hidden="true" className="size-3" />
					) : (
						<Pause aria-hidden="true" className="size-3" />
					)}
					<span>{held ? "Resume rings" : "Pause rings"}</span>
				</button>
			) : null}
		</div>
	);
}
