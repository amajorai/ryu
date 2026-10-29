import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import type { RefObject } from "react";
import { GAME_PLATE } from "./game-hud.tsx";
import {
	type Moon,
	type Planet,
	type PlanetSystem,
	planetDescription,
} from "./planets-model.ts";
import { type PlanetsPalette, teamColor } from "./planets-palette.ts";
import { PlanetsStatusDot, STATUS_TONE, TeamMark } from "./planets-parts.tsx";

/**
 * DOM the scene moves every frame: a name plate by each planet and the star,
 * and a hit target over each moon. The scene writes each wrapper's
 * `transform` (the body's centre), its on-screen radius (`--body-r`), where
 * its plate or title sits (`--label-x`/`--label-y`, the label's top-left from
 * the centre), `data-hidden` (behind a nearer body, under the HUD, or off
 * screen) and, for the moons of the body being visited, `data-label="pinned"`
 * once the camera has settled.
 */
export interface OverlayRegistry {
	moons: Map<string, HTMLElement>;
	planets: Map<string, HTMLElement>;
	sun: HTMLElement | null;
}

export function createOverlayRegistry(): OverlayRegistry {
	return { moons: new Map(), planets: new Map(), sun: null };
}

/** Moons of different bodies can share a thread, so keys carry the body. */
export function moonKey(bodyId: string, threadId: string): string {
	return `${bodyId}:${threadId}`;
}

export const STAR_ID = "you";

/**
 * Hidden wrappers leave the layout entirely (`display: none`), so nothing
 * inside them (badges, dots, titles) can leak through.
 */
const WRAPPER =
	"group/wrap pointer-events-none absolute top-0 left-0 will-change-transform hover:z-20 data-[hidden=true]:hidden data-[label=pinned]:z-10";
/** Status words on a title: tinted, and never muted against a bright world. */
const LABEL_TONE: Record<Moon["status"], string> = {
	...STATUS_TONE,
	quiet: "text-(--gk-ink-muted)",
	waiting: "text-(--gk-ink-muted)",
};
const OFFSCREEN = { transform: "translate3d(-9999px, -9999px, 0)" };
/** Until the scene places it, a plate hangs centred under its body. */
const LABEL_AT = {
	transform:
		"translate3d(var(--label-x, -50%), var(--label-y, calc(var(--body-r, 12px) + 6px)), 0)",
};

/**
 * A moon's title: up on hover or keyboard focus, and (with moon labels on)
 * pinned up for the visited body's moons once the camera settles.
 */
const MOON_TITLE_HEAD =
	"pointer-events-none absolute top-1/2 left-1/2 flex translate-y-1 items-center gap-1.5 whitespace-nowrap rounded-lg border-(--gk-edge) border-2 bg-(--gk-plate) px-2.5 py-1 text-(--gk-ink) text-[13px] leading-5 opacity-0 shadow-(--gk-lip) transition-[opacity,translate] duration-150 group-hover/moon:translate-y-0 group-hover/moon:opacity-100 group-focus-visible/moon:translate-y-0 group-focus-visible/moon:opacity-100";
const MOON_TITLE = `${MOON_TITLE_HEAD} motion-reduce:transition-none`;
const MOON_TITLE_PINNED = `${MOON_TITLE_HEAD} group-data-[label=pinned]/wrap:translate-y-0 group-data-[label=pinned]/wrap:opacity-100 motion-reduce:transition-none`;

/** The game kit's name plate: ink edge, cream plate, display face, 13px. */
const PLATE = cn(
	GAME_PLATE,
	"gk-display pointer-events-auto absolute top-0 left-0 flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[13px] leading-none outline-none transition-[scale] duration-150 active:scale-[0.97] aria-pressed:bg-(--gk-accent) aria-pressed:text-(--gk-accent-ink)"
);

export function PlanetsOverlay({
	askOf,
	focusId,
	moonLabels = true,
	onAsk,
	onHover,
	onOpenThread,
	onSelect,
	palette,
	registry,
	system,
}: {
	/** With acts: the ask an asking planet's plate answers (else it visits). */
	askOf?: (planetId: string) => string | null;
	focusId: string | null;
	/** Pin the visited body's moon titles (the `moonLabels` setting). */
	moonLabels?: boolean;
	onAsk?: (askId: string, opener: HTMLElement) => void;
	onHover: (bodyId: string | null) => void;
	onOpenThread: (threadId: string, bodyId: string) => void;
	onSelect: (bodyId: string) => void;
	palette: PlanetsPalette;
	registry: RefObject<OverlayRegistry>;
	system: PlanetSystem;
}) {
	const waiting = system.summary.waitingOnYou;
	return (
		<div
			// Pointer targets only: the system list and the panel are the
			// accessible way to every planet and moon, and these move every frame.
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
		>
			<div
				className={WRAPPER}
				data-hidden="true"
				ref={(element) => {
					registry.current.sun = element;
				}}
				style={OFFSCREEN}
			>
				<button
					aria-label="You, the star"
					aria-pressed={focusId === STAR_ID}
					className={PLATE}
					data-plate={STAR_ID}
					onClick={() => onSelect(STAR_ID)}
					onPointerEnter={() => onHover(STAR_ID)}
					onPointerLeave={() => onHover(null)}
					style={LABEL_AT}
					tabIndex={-1}
					type="button"
				>
					You
					{waiting > 0 ? (
						<span className="rounded-full bg-(--planets-turn) px-1.5 font-semibold text-[12px] text-background tabular-nums leading-4">
							{waiting}
						</span>
					) : null}
				</button>
			</div>
			{system.starMoons.map((moon) => (
				<MoonTarget
					bodyId={STAR_ID}
					key={moonKey(STAR_ID, moon.threadId)}
					moon={moon}
					onHover={onHover}
					onOpen={onOpenThread}
					pinned={moonLabels}
					registry={registry}
				/>
			))}
			{system.planets.map((planet) => (
				<PlanetPlate
					ask={askOf?.(planet.id) ?? null}
					focused={focusId === planet.id}
					key={planet.id}
					onAsk={onAsk}
					onHover={onHover}
					onSelect={onSelect}
					palette={palette}
					planet={planet}
					registry={registry}
					teamIndex={
						system.teams.find((team) => team.id === planet.teamId)
							?.colorIndex ?? null
					}
				/>
			))}
			{system.planets.flatMap((planet) =>
				planet.moons.map((moon) => (
					<MoonTarget
						bodyId={planet.id}
						key={moonKey(planet.id, moon.threadId)}
						moon={moon}
						onHover={onHover}
						onOpen={onOpenThread}
						pinned={moonLabels}
						registry={registry}
					/>
				))
			)}
		</div>
	);
}

function PlanetPlate({
	ask,
	focused,
	onAsk,
	onHover,
	onSelect,
	palette,
	planet,
	registry,
	teamIndex,
}: {
	ask: string | null;
	focused: boolean;
	onAsk?: (askId: string, opener: HTMLElement) => void;
	onHover: (bodyId: string | null) => void;
	onSelect: (bodyId: string) => void;
	palette: PlanetsPalette;
	planet: Planet;
	registry: RefObject<OverlayRegistry>;
	teamIndex: number | null;
}) {
	const tl = useLiteralMessages();
	const needsYou = planet.counts.attention + planet.counts["your-turn"];
	return (
		<div
			className={WRAPPER}
			data-hidden="true"
			ref={(element) => {
				if (element) {
					registry.current.planets.set(planet.id, element);
				} else {
					registry.current.planets.delete(planet.id);
				}
			}}
			style={OFFSCREEN}
		>
			<button
				aria-label={tl("Planet {description}", {
					description: planetDescription(planet),
				})}
				aria-pressed={ask ? undefined : focused}
				className={PLATE}
				data-planet-plate={planet.id}
				data-plate={planet.id}
				onClick={(event) => {
					if (ask && onAsk) {
						onAsk(ask, event.currentTarget);
						return;
					}
					onSelect(planet.id);
				}}
				onPointerEnter={() => onHover(planet.id)}
				onPointerLeave={() => onHover(null)}
				style={LABEL_AT}
				tabIndex={-1}
				type="button"
			>
				{planet.name}
				{teamIndex === null ? null : (
					<TeamMark color={teamColor(palette, teamIndex)} />
				)}
				{planet.working ? (
					<PlanetsStatusDot className="size-1.5" status="working" />
				) : null}
				{needsYou > 0 ? (
					<span
						className={cn(
							"rounded-full px-1.5 font-semibold text-[12px] tabular-nums leading-4",
							planet.counts.attention > 0
								? "bg-(--gk-bad) text-white"
								: "bg-(--planets-turn) text-background"
						)}
					>
						{needsYou}
					</span>
				) : null}
				{planet.overflow > 0 ? (
					<span className="text-(--gk-ink-muted) text-[12px] tabular-nums">
						+{planet.overflow}
					</span>
				) : null}
			</button>
		</div>
	);
}

function MoonTarget({
	bodyId,
	moon,
	onHover,
	onOpen,
	pinned,
	registry,
}: {
	bodyId: string;
	moon: Moon;
	onHover: (bodyId: string | null) => void;
	onOpen: (threadId: string, bodyId: string) => void;
	/** The title stays up while the scene pins it (`data-label="pinned"`). */
	pinned: boolean;
	registry: RefObject<OverlayRegistry>;
}) {
	const key = moonKey(bodyId, moon.threadId);
	const tl = useLiteralMessages();
	const label = THREAD_STATUS_LABELS[moon.status];
	return (
		<div
			className={WRAPPER}
			data-hidden="true"
			ref={(element) => {
				if (element) {
					registry.current.moons.set(key, element);
				} else {
					registry.current.moons.delete(key);
				}
			}}
			style={OFFSCREEN}
		>
			<button
				aria-label={tl("Moon: {title} ({statusLabel})", {
					title: moon.title,
					statusLabel: label,
				})}
				className="group/moon pointer-events-auto absolute top-0 left-0 size-[max(2rem,calc(var(--body-r,12px)*2+10px))] -translate-x-1/2 -translate-y-1/2 rounded-full outline-none transition-shadow hover:ring-2 hover:ring-foreground/45 focus-visible:ring-2 focus-visible:ring-ring"
				data-moon={moon.threadId}
				onClick={() => onOpen(moon.threadId, bodyId)}
				onPointerEnter={() => onHover(bodyId)}
				onPointerLeave={() => onHover(null)}
				tabIndex={-1}
				type="button"
			>
				<span
					aria-hidden="true"
					className={pinned ? MOON_TITLE_PINNED : MOON_TITLE}
					data-label=""
					style={{
						transform:
							"translate3d(var(--label-x, -50%), var(--label-y, calc(-100% - var(--body-r, 12px) - 6px)), 0)",
					}}
				>
					<PlanetsStatusDot className="size-1.5" status={moon.status} />
					<span className="max-w-48 truncate font-medium">{moon.title}</span>
					<span className={cn("font-medium", LABEL_TONE[moon.status])}>
						{label}
					</span>
				</span>
			</button>
		</div>
	);
}
