import { Button } from "@ryu/ui/components/button.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { LayoutGrid } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
	type CSSProperties,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import {
	GlanceAgentsFace,
	GlanceClockFace,
	type GlanceFaceProps,
	GlanceFlowFace,
} from "./glance-faces.tsx";
import { GlanceHome } from "./glance-home.tsx";
import {
	GLANCE_AUTO_INTERVAL_MS,
	GLANCE_DISTANCE_MODES,
	GLANCE_FACE_LABELS,
	GLANCE_FACES,
	type GlanceDistance,
	type GlanceDistanceMode,
	type GlanceFace,
	type GlanceKeyAction,
	glanceKeyAction,
	isGlanceDistanceMode,
	isGlanceTypingTarget,
	stepGlanceFace,
} from "./glance-model.ts";
import {
	GLANCE_EASE,
	GLANCE_FONT_STACK,
	GlanceThreadSheet,
	useGlanceClock,
} from "./glance-parts.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

type GlanceView = "faces" | "home";

/**
 * The display's edge: the largest square that fits the window under the
 * controls, capped near a 7-inch panel's proportions on a desktop.
 */
const DISPLAY_SIZE = "min(100cqw - 2rem, 100cqh - 9.5rem, 46rem)";

/**
 * The outgoing layer leaves fast while the next one is already arriving
 * beneath it: one crossfade, never a blank frame.
 */
const FADE_OUT = { duration: 0.14, ease: "easeOut" } as const;

/** What a stage change is, so each kind gets one fitting entrance. */
type StageChange = "distance" | "face" | "view";

/** How far a swipe must travel before it changes the face. */
const SWIPE_PX = 48;

interface DisplayStyle extends CSSProperties {
	"--glance-size": string;
}

const DISPLAY_STYLE: DisplayStyle = {
	"--glance-size": DISPLAY_SIZE,
};

/** Live distance: the fixed choice, or Auto's slow back-and-forth. */
function useGlanceDistance(mode: GlanceDistanceMode): GlanceDistance {
	const [cycled, setCycled] = useState<GlanceDistance>("far");
	useEffect(() => {
		if (mode !== "auto") {
			return;
		}
		const timer = setInterval(() => {
			if (document.visibilityState === "hidden") {
				return;
			}
			setCycled((current) => (current === "far" ? "near" : "far"));
		}, GLANCE_AUTO_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [mode]);
	return mode === "auto" ? cycled : mode;
}

function PageDots({
	face,
	onSelect,
	panelId,
}: {
	face: GlanceFace;
	onSelect: (face: GlanceFace, focus: boolean) => void;
	panelId: string;
}) {
	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		let next: GlanceFace | null = null;
		if (event.key === "ArrowRight") {
			next = stepGlanceFace(face, 1);
		} else if (event.key === "ArrowLeft") {
			next = stepGlanceFace(face, -1);
		} else if (event.key === "Home") {
			next = GLANCE_FACES[0] ?? null;
		} else if (event.key === "End") {
			next = GLANCE_FACES.at(-1) ?? null;
		}
		if (next) {
			event.preventDefault();
			onSelect(next, true);
		}
	};
	return (
		<div
			aria-label="Faces"
			className="flex items-center justify-center"
			onKeyDown={onKeyDown}
			role="tablist"
		>
			{GLANCE_FACES.map((option) => {
				const selected = option === face;
				return (
					<button
						aria-controls={panelId}
						aria-label={GLANCE_FACE_LABELS[option]}
						aria-selected={selected}
						className="group flex size-6 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
						data-face={option}
						key={option}
						onClick={() => onSelect(option, false)}
						role="tab"
						tabIndex={selected ? 0 : -1}
						title={GLANCE_FACE_LABELS[option]}
						type="button"
					>
						<span
							className={cn(
								"size-2 rounded-full transition-colors duration-200",
								selected
									? "bg-foreground"
									: "bg-foreground/25 group-hover:bg-foreground/45"
							)}
						/>
					</button>
				);
			})}
		</div>
	);
}

/**
 * Glance: Ryu on a calm square display, after Apple's HomeView. One face at a
 * time (Clock, Agents, Flow) that you page through with the dots, arrow keys,
 * or a swipe; a Distance control trades Far's few large facts for Near's
 * detail; and a Home Screen lays the same snapshot out as widgets. Threads
 * open in a sheet that holds the host's own conversation surface.
 */
export function GlanceInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const reduceMotion = useReducedMotion();
	const now = useGlanceClock();
	const panelId = useId();
	const distanceLabelId = useId();
	const [face, setFace] = useState<GlanceFace>("clock");
	const [direction, setDirection] = useState(1);
	const [view, setView] = useState<GlanceView>("faces");
	const [distanceMode, setDistanceMode] = useState<GlanceDistanceMode>("near");
	const distance = useGlanceDistance(distanceMode);
	const isOpen = threadView !== null && threadView !== undefined;
	const openThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;

	const rootRef = useRef<HTMLDivElement>(null);
	const sheetRef = useRef<HTMLElement>(null);
	const swipeRef = useRef<{ x: number; y: number } | null>(null);
	const swipedRef = useRef(false);

	const selectFace = (next: GlanceFace, focus = false) => {
		const from = GLANCE_FACES.indexOf(face);
		const to = GLANCE_FACES.indexOf(next);
		setDirection(to >= from ? 1 : -1);
		setFace(next);
		if (focus) {
			requestAnimationFrame(() => {
				rootRef.current
					?.querySelector<HTMLElement>(`[role='tab'][data-face='${next}']`)
					?.focus();
			});
		}
	};

	const step = (delta: number) => {
		setDirection(delta >= 0 ? 1 : -1);
		setFace((current) => stepGlanceFace(current, delta));
	};

	const runAction = (action: GlanceKeyAction): boolean => {
		if (action === "close") {
			if (isOpen) {
				port.closeThread();
				return true;
			}
			if (view === "home") {
				setView("faces");
				return true;
			}
			return false;
		}
		if (view !== "faces") {
			return false;
		}
		step(action === "next" ? 1 : -1);
		return true;
	};
	const runActionRef = useRef(runAction);
	runActionRef.current = runAction;

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (event.defaultPrevented || event.isComposing) {
				return;
			}
			const action = glanceKeyAction(event);
			if (!action || isGlanceTypingTarget(event.target)) {
				return;
			}
			const target = event.target;
			// Inside the host's conversation its own keys win.
			if (target instanceof Node && sheetRef.current?.contains(target)) {
				return;
			}
			const onPage =
				target === document.body ||
				target === document.documentElement ||
				(target instanceof Node && rootRef.current?.contains(target) === true);
			if (!onPage) {
				return;
			}
			if (runActionRef.current(action)) {
				event.preventDefault();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
		swipedRef.current = false;
		swipeRef.current =
			view === "faces" && event.isPrimary
				? { x: event.clientX, y: event.clientY }
				: null;
	};
	const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
		const start = swipeRef.current;
		swipeRef.current = null;
		if (!start) {
			return;
		}
		const dx = event.clientX - start.x;
		const dy = event.clientY - start.y;
		if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
			swipedRef.current = true;
			step(dx < 0 ? 1 : -1);
		}
	};

	const faceProps: GlanceFaceProps = {
		distance,
		loading,
		now,
		onOpenThread: (threadId) => port.openThread(threadId),
		onStartWithAgent: (agentId) => port.startThread({ agentId }),
		snapshot,
	};

	let content: ReactNode;
	if (view === "home") {
		content = <GlanceHome {...faceProps} />;
	} else if (face === "agents") {
		content = (
			<GlanceAgentsFace
				{...faceProps}
				onShowAll={() => setView("home")}
				onStartThread={() => port.startThread({})}
			/>
		);
	} else if (face === "flow") {
		content = <GlanceFlowFace {...faceProps} />;
	} else {
		content = (
			<GlanceClockFace {...faceProps} onShowAll={() => setView("home")} />
		);
	}

	const contentKey = view === "home" ? "home" : face;
	const stageKey = `${contentKey}:${distance}`;
	// Compare with the last committed stage to pick this change's entrance.
	const committedRef = useRef({ contentKey, distance, view });
	const committed = committedRef.current;
	let change: StageChange = "face";
	if (committed.view !== view) {
		change = "view";
	} else if (committed.distance !== distance) {
		change = "distance";
	}
	useEffect(() => {
		committedRef.current = { contentKey, distance, view };
	}, [contentKey, distance, view]);
	const offset = reduceMotion || change !== "face" ? 0 : 40;
	const settle = reduceMotion || change === "face" ? 1 : 0.985;
	const stageLabel =
		view === "home" ? "Home Screen" : `${GLANCE_FACE_LABELS[face]} face`;

	return (
		<div
			aria-busy={loading || undefined}
			className="relative flex size-full min-h-0 bg-background text-foreground antialiased"
			data-distance={distance}
			data-face={face}
			data-state={isOpen ? "open" : view}
			data-testid="interface-glance"
			ref={rootRef}
			style={{ fontFamily: GLANCE_FONT_STACK }}
		>
			<div className="relative min-w-0 flex-1 [container-type:size]">
				{/* Narrow windows pin the display to the top and let the page scroll. */}
				<div className="absolute inset-0 flex @max-[40rem]:items-start items-center justify-center overflow-y-auto @max-[40rem]:py-4">
					<div
						className="flex w-(--glance-size) flex-col gap-4"
						style={DISPLAY_STYLE}
					>
						<div className="flex h-9 items-center justify-between gap-3">
							<div className="flex items-center gap-3">
								<span
									className="font-medium text-[13px] text-muted-foreground max-sm:sr-only"
									id={distanceLabelId}
								>
									Distance
								</span>
								<ToggleGroup
									appearance="segmented"
									aria-labelledby={distanceLabelId}
									multiple={false}
									onValueChange={(values: string[]) => {
										const value = values[0];
										if (isGlanceDistanceMode(value)) {
											setDistanceMode(value);
										}
									}}
									spacing={0}
									value={[distanceMode]}
								>
									{GLANCE_DISTANCE_MODES.map((option) => (
										<ToggleGroupItem
											className="px-3.5 dark:aria-pressed:bg-foreground/15"
											density="segmented"
											key={option.value}
											onClick={(event) => {
												// A pointer choice hands the keys back to the faces.
												if (event.detail > 0) {
													event.currentTarget.blur();
												}
											}}
											title={
												option.value === "auto"
													? "Alternate Far and Near"
													: `${option.label}: ${option.value === "far" ? "large, simple" : "more detail"}`
											}
											value={option.value}
										>
											{option.label}
										</ToggleGroupItem>
									))}
								</ToggleGroup>
							</div>
							{view === "home" ? (
								<Button
									aria-keyshortcuts="Escape"
									className="min-w-16 font-semibold"
									onClick={() => setView("faces")}
									size="sm"
									title="Back to faces (Esc)"
									type="button"
									variant="secondary"
								>
									Done
								</Button>
							) : (
								<Button
									className="-mr-3 gap-1.5 text-muted-foreground"
									onClick={() => setView("home")}
									size="sm"
									type="button"
									variant="ghost"
								>
									<LayoutGrid aria-hidden="true" />
									Home Screen
								</Button>
							)}
						</div>
						<section
							aria-keyshortcuts={
								view === "faces" ? "ArrowLeft ArrowRight" : undefined
							}
							aria-label={stageLabel}
							aria-roledescription="display"
							className={cn(
								"@container corner-squircle relative h-(--glance-size) w-full touch-pan-y select-none overflow-hidden rounded-[calc(var(--glance-size)*0.075)] bg-card ring-1 ring-border",
								// A phone-width Home Screen grows with its widgets; the page scrolls.
								view === "home" &&
									"@max-[34rem]:h-auto @max-[34rem]:overflow-visible overflow-y-auto"
							)}
							data-testid="glance-display"
							id={panelId}
							onClickCapture={(event) => {
								if (swipedRef.current) {
									swipedRef.current = false;
									event.stopPropagation();
									event.preventDefault();
								}
							}}
							onPointerCancel={() => {
								swipeRef.current = null;
							}}
							onPointerDown={onPointerDown}
							onPointerUp={onPointerUp}
							role={view === "faces" ? "tabpanel" : undefined}
						>
							<AnimatePresence initial={false}>
								<motion.div
									animate={{ opacity: 1, scale: 1, x: 0 }}
									className={cn(
										"absolute inset-0",
										view === "home" && "@max-[32rem]:relative"
									)}
									exit={{ opacity: 0, transition: FADE_OUT }}
									initial={{
										opacity: 0,
										scale: settle,
										x: direction * offset,
									}}
									key={stageKey}
									transition={{ duration: 0.3, ease: GLANCE_EASE }}
								>
									{content}
								</motion.div>
							</AnimatePresence>
						</section>
						<div className="flex h-6 items-center justify-center">
							{view === "faces" ? (
								<PageDots face={face} onSelect={selectFace} panelId={panelId} />
							) : null}
						</div>
					</div>
				</div>
			</div>
			<AnimatePresence>
				{isOpen ? (
					<GlanceThreadSheet
						onClose={() => port.closeThread()}
						sheetRef={sheetRef}
						snapshot={snapshot}
						thread={openThread}
						threadView={threadView}
					/>
				) : null}
			</AnimatePresence>
		</div>
	);
}
