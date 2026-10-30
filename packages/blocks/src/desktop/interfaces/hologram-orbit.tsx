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
	type HologramView,
	normalizeAngle,
	polar,
	type RingSlot,
	radialMenuLayout,
	ringSlots,
} from "./hologram-model.ts";
import { NodeBadge } from "./hologram-orbit-badge.tsx";
import {
	anchorTransform,
	isKeyboardFocus,
	LABEL_PLATE,
	labelKeepOut,
	MENU_RADIUS,
	MENU_SIZES,
	nodeLabel,
	orbitGeometry,
	PRESS_HOLD_MS,
	type RadialAction,
	RING_SPIN,
	TICK_OUTER,
	threadCountLabel,
} from "./hologram-orbit-geometry.ts";
import { RadialMenu } from "./hologram-orbit-menu.tsx";
import {
	CornerBrackets,
	HUD_INTERACTIVE,
	HUD_LABEL,
} from "./hologram-parts.tsx";

export {
	labelKeepOut,
	menuItemSize,
	orbitGeometry,
	type RadialAction,
	threadCountLabel,
} from "./hologram-orbit-geometry.ts";

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
