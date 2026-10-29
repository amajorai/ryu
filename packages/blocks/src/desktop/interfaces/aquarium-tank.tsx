import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import {
	type FocusEvent,
	type KeyboardEvent,
	type RefObject,
	useId,
	useMemo,
} from "react";
import {
	type AquariumActHandlers,
	actPlateBadge,
	type CreaturePlateAct,
	creatureTargets,
} from "./aquarium-acts.tsx";
import {
	type AquariumActScene,
	AquariumDioramaScene,
} from "./aquarium-diorama.tsx";
import { layoutTank, TANK_SURFACE } from "./aquarium-layout.ts";
import {
	CREATURE_LABELS,
	type Creature,
	creatureDescription,
	creatureOrder,
} from "./aquarium-model.ts";
import {
	type AquariumWallpaper,
	creatureHue,
	type TankPalette,
} from "./aquarium-palette.ts";
import { CreaturePortrait } from "./aquarium-parts.tsx";
import {
	actBubble,
	bubbleOverlayId,
	type OffStage,
	slotOf,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { queuePlateText } from "./game3d-meters.tsx";
import {
	type IsoInsets,
	IsoStage,
	type IsoView,
	useFocusOnOpen,
} from "./game3d-stage.tsx";
import { ActStatus } from "./interface-ask-card.tsx";

function isFocusVisible(element: Element): boolean {
	try {
		return element.matches(":focus-visible");
	} catch {
		return true;
	}
}

const ZOOM_KEYS: Partial<Record<string, "in" | "out" | "reset">> = {
	"+": "in",
	"-": "out",
	"0": "reset",
	"=": "in",
};

const LIST_KEYS = new Set([
	"ArrowDown",
	"ArrowRight",
	"ArrowUp",
	"ArrowLeft",
	"Home",
	"End",
]);

/**
 * The tank: the reef diorama on the game kit's stage (a glass tank on its
 * cabinet in a room, a creature per agent with its kit name plate). The creature list
 * below is its keyboard and screen-reader path.
 */
/** How much farther apart homes stand with acts (props stand between them). */
const ACT_SPREAD = 1.3;

/** The width of the act layer's queue lane at the tank's right-hand glass. */
const QUEUE_LANE = 2.6;

/** Opening a creature glides to it with a gentle zoom: the tank stays in view. */
const AQUARIUM_FOCUS_ZOOM = 1.15;

/**
 * The act layer for the tank, when the host sends asks: the creatures swim
 * to their act targets, the queue plates carry their waits, and the act
 * props sit on the sand and at the front glass (pointer targets only).
 */
export interface AquariumTankActs {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	handlers: AquariumActHandlers;
	offStage: OffStage;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
}

export function AquariumTank({
	actLayer = null,
	creatures,
	focusedId,
	insets,
	label,
	onDismiss,
	onRendered,
	onSelect,
	palette,
	reduced,
	sceneReady,
	selectedId,
	view,
	wallpaper,
}: {
	actLayer?: AquariumTankActs | null;
	creatures: readonly Creature[];
	/** The creature the list has keyboard focus on (its plate shows a ring). */
	focusedId: string | null;
	/** Pixels the HUD (and an open sheet) cover on each side. */
	insets: IsoInsets;
	/** What the picture shows, for assistive technology. */
	label: string;
	/** A click on the sand or the cabinet: put the selection down. */
	onDismiss: () => void;
	/** The scene has drawn its first frame. */
	onRendered: () => void;
	onSelect: (agentId: string) => void;
	palette: TankPalette;
	reduced: boolean;
	/** WebGL is available and the scene may mount. */
	sceneReady: boolean;
	selectedId: string | null;
	view: IsoView;
	/** The room's wallpaper (the aquarium's `wallpaper` setting). */
	wallpaper?: AquariumWallpaper;
}) {
	// The open card's creature: the camera glides to it (it holds still while open).
	useFocusOnOpen(sceneReady ? view : undefined, selectedId);
	// With acts the tank keeps a lane at its right-hand glass for the queue.
	const actsOn = actLayer !== null;
	const layout = useMemo(
		() =>
			layoutTank(creatures, actsOn ? QUEUE_LANE : 0, actsOn ? ACT_SPREAD : 1),
		[actsOn, creatures]
	);
	const actScene = useMemo((): AquariumActScene | null => {
		if (!actLayer) {
			return null;
		}
		const { acts, handlers, slots } = actLayer;
		const plates = new Map<string, CreaturePlateAct>();
		for (const act of acts.values()) {
			const ask = act.act === "asking" ? act.ask : null;
			const badge = actPlateBadge(act);
			const bubbleId = bubbleOverlayId(act);
			const bubble =
				bubbleId && handlers.shown.has(bubbleId) ? actBubble(act) : null;
			const activate = ask ? () => handlers.onAsk(ask.id) : undefined;
			plates.set(act.agentId, { activate, badge, bubble, youSpot: false });
			if (ask && slotOf(slots.slots, act.agentId)) {
				plates.set(act.agentId, {
					activate,
					badge,
					bubble,
					text: queuePlateText(
						act.agentName,
						{
							approx: ask.sinceApprox,
							since: ask.since,
							until: ask.expiresAt ?? null,
							untilApprox: ask.expiresApprox,
						},
						handlers.nowMs
					),
					youSpot: true,
				});
			}
		}
		return {
			...actLayer,
			plates,
			targets: creatureTargets(acts, layout, slots.slots, handlers.reduced),
		};
	}, [actLayer, layout]);
	return (
		<div className="absolute inset-0 select-none" data-testid="aquarium-tank">
			<div aria-label={label} className="absolute inset-0" role="img">
				{sceneReady ? (
					<IsoStage
						bounds={{
							maxX: layout.halfWidth + 0.4,
							maxZ: layout.halfDepth + 0.6,
							minX: -layout.halfWidth - 0.4,
							minZ: -layout.halfDepth - 0.4,
							top: TANK_SURFACE + 0.9,
						}}
						fallback={null}
						fill={1.12}
						focusZoom={AQUARIUM_FOCUS_ZOOM}
						insets={insets}
						label={label}
						night={palette.mode === "dark"}
						// With acts a phone frames the whole tank (no zoom on to the
						// plates), so the glass queue and the sand props stay in view.
						portrait={
							actScene
								? {
										bounds: {
											maxX: layout.halfWidth + 0.4,
											maxZ: layout.halfDepth + 0.6,
											minX: -layout.halfWidth - 0.4,
											minZ: -layout.halfDepth - 0.4,
											top: TANK_SURFACE + 0.9,
										},
									}
								: undefined
						}
						reducedMotion={reduced}
						view={view}
					>
						{() => (
							<AquariumDioramaScene
								actScene={actScene}
								creatures={creatures}
								focusedId={focusedId}
								layout={layout}
								night={palette.mode === "dark"}
								onDismiss={onDismiss}
								onRendered={onRendered}
								onSelect={onSelect}
								palette={palette}
								reduced={reduced}
								selectedId={selectedId}
								wallpaper={wallpaper}
							/>
						)}
					</IsoStage>
				) : null}
			</div>
		</div>
	);
}

/**
 * Every creature as a button, so each can be reached with Tab (arrows move
 * between them, Home and End jump) and opened with Enter. Visually hidden
 * while the 3D tank runs (the focused creature's plate wears the kit's
 * focus ring); a plain list of chips when WebGL is unavailable.
 */
/** The act layer for the list rows, when the host sends asks. */
export interface CreatureListActs {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	nowMs: number;
	onAsk: (askId: string, opener?: HTMLElement) => void;
	onBlocker: (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => void;
	snapshot: InterfaceSnapshot;
}

export function CreatureList({
	actLayer = null,
	buttonRefs,
	creatures,
	onFocusChange,
	onSelect,
	palette,
	panelId,
	sceneReady,
	selectedId,
	view,
	webglMissing,
}: {
	/**
	 * With acts each row is named by its act ("… Open their card.", or
	 * "… Answer their ask." opening the ask card, with no aria-expanded);
	 * without WebGL each visible row also says its act and its buttons.
	 */
	actLayer?: CreatureListActs | null;
	buttonRefs: RefObject<Map<string, HTMLButtonElement>>;
	creatures: readonly Creature[];
	onFocusChange: (agentId: string | null) => void;
	onSelect: (agentId: string) => void;
	palette: TankPalette;
	panelId: string;
	sceneReady: boolean;
	selectedId: string | null;
	view: IsoView;
	webglMissing: boolean;
}) {
	const ordered = useMemo(() => creatureOrder(creatures), [creatures]);
	const listId = useId();
	const tl = useLiteralMessages();
	const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
		// The stage's zoom keys work from the creature list too.
		const zoom = ZOOM_KEYS[event.key];
		if (zoom && sceneReady) {
			event.preventDefault();
			view.send(zoom);
			return;
		}
		if (!LIST_KEYS.has(event.key)) {
			return;
		}
		const ids = ordered.map((creature) => creature.id);
		const focused =
			event.target instanceof HTMLElement ? event.target.dataset.agentId : "";
		const current = ids.indexOf(focused ?? "");
		let next = current;
		if (event.key === "Home") {
			next = 0;
		} else if (event.key === "End") {
			next = ids.length - 1;
		} else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
			next = current === -1 ? 0 : (current + 1) % ids.length;
		} else {
			next = current <= 0 ? ids.length - 1 : current - 1;
		}
		const target = ids[next];
		if (target) {
			event.preventDefault();
			event.stopPropagation();
			buttonRefs.current.get(target)?.focus();
		}
	};

	const onButtonFocus = (event: FocusEvent<HTMLButtonElement>, id: string) => {
		onFocusChange(isFocusVisible(event.currentTarget) ? id : null);
	};

	return (
		<ul
			aria-label="Agents in the tank"
			className={cn(
				webglMissing
					? "pointer-events-auto absolute inset-x-0 bottom-20 z-20 mx-auto flex max-w-xl flex-wrap justify-center gap-2 px-4"
					: "sr-only"
			)}
			data-agent-list={actLayer ? "" : undefined}
			onKeyDown={onListKeyDown}
		>
			{ordered.map((creature) => {
				const act = actLayer?.acts.get(creature.id);
				const ask = act?.act === "asking" ? act.ask : null;
				let label = creatureDescription(creature);
				if (act) {
					label = ask
						? tl("{actLabel} Answer their ask.", { actLabel: act.ariaLabel })
						: tl("{actLabel} Open their card.", { actLabel: act.ariaLabel });
				}
				return (
					<li
						className={cn(
							webglMissing && act
								? "flex flex-col items-center gap-1"
								: undefined
						)}
						key={creature.id}
					>
						<button
							aria-controls={
								!ask && selectedId === creature.id ? panelId : undefined
							}
							aria-describedby={act ? `${listId}-${creature.id}` : undefined}
							aria-expanded={ask ? undefined : selectedId === creature.id}
							aria-label={label}
							className={cn(
								webglMissing &&
									"flex items-center gap-2 rounded-full border border-border bg-card py-1 ps-1 pe-3 text-foreground text-sm shadow-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-expanded:border-primary/60"
							)}
							data-act-agent={act ? creature.id : undefined}
							data-agent-id={creature.id}
							onBlur={() => onFocusChange(null)}
							onClick={(event) => {
								event.stopPropagation();
								if (ask && actLayer) {
									actLayer.onAsk(ask.id, event.currentTarget);
									return;
								}
								onSelect(creature.id);
							}}
							onFocus={(event) => onButtonFocus(event, creature.id)}
							ref={(node) => {
								if (node) {
									buttonRefs.current.set(creature.id, node);
								} else {
									buttonRefs.current.delete(creature.id);
								}
							}}
							type="button"
						>
							{webglMissing ? (
								<CreaturePortrait
									creature={creature}
									eye={palette.eye}
									hue={creatureHue(palette, creature.colorIndex)}
									size={26}
								/>
							) : null}
							{creature.name}
							<span className={cn(webglMissing ? "sr-only" : undefined)}>
								{" "}
								({CREATURE_LABELS[creature.kind]})
							</span>
						</button>
						{act ? (
							<span hidden id={`${listId}-${creature.id}`}>
								{act.ariaLabel}
							</span>
						) : null}
						{act && actLayer ? (
							// While the 3D tank runs the list is sr-only: the row's own
							// buttons would be invisible Tab stops, so they step aside
							// (the row and the ask queue carry them).
							<div className="contents" inert={!webglMissing}>
								<ActStatus
									act={act}
									clock={actLayer.clock}
									nowMs={actLayer.nowMs}
									onAsk={actLayer.onAsk}
									onBlocker={actLayer.onBlocker}
									snapshot={actLayer.snapshot}
								/>
							</div>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}
