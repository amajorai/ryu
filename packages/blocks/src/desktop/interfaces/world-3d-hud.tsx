import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	WorldDirection,
	WorldEntity,
	WorldLayout,
	WorldPoint,
} from "@ryuhq/protocol/interfaces";
import { type ComponentProps, memo, type ReactNode } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import {
	type AgentSwatch,
	type Scene3dTheme,
	swatchOf,
} from "./game3d-palette.ts";
import type { TrackerGoal } from "./world-3d-model.ts";
import type { VillageLayout } from "./world-village.ts";

/**
 * The 3D world's heads-up display, in an action-RPG layout drawn with the
 * user's theme: a round minimap (top left), the quest tracker under it, and
 * the interaction prompt right of center (a keycap and "Talk to <name>").
 * It never captures the pointer except for the empty state's action, and it
 * lays itself out inside whatever part of the viewport a panel leaves
 * uncovered.
 */

/**
 * The one HUD surface (tracker, hints, talk prompt, dialogue, choices, empty
 * state): the theme's card, a hairline, a small lift and one radius.
 */
export const HUD_SURFACE =
	"rounded-lg border border-border bg-card text-card-foreground shadow-sm";

/** A keycap in the theme's colors. */
export function Keycap({ className, ...props }: ComponentProps<"kbd">) {
	return (
		<Kbd
			className={cn(
				"rounded-sm border border-border bg-background font-mono text-foreground",
				className
			)}
			{...props}
		/>
	);
}

/** The tracker's spoken name: where it goes, then what is waiting there. */
export function trackerLabel(goal: TrackerGoal, tl?: LiteralMessage): string {
	const detail = goal.detail.replaceAll(" · ", ", ");
	if (!goal.agentName) {
		return detail ? `${goal.title}: ${detail}` : goal.title;
	}
	if (detail) {
		return tl
			? tl("Go to {agentName}: {detail}", { agentName: goal.agentName, detail })
			: `Go to ${goal.agentName}: ${detail}`;
	}
	// An ask's tracker opens the ask: its name says the ask and the wait.
	if (goal.title.startsWith(`${goal.agentName} asks:`)) {
		const wait = goal.suffix?.replace(/^·\s*/, "");
		return `Answer ${goal.agentName}: ${goal.title}${wait ? `, ${wait}` : ""}`;
	}
	return tl
		? tl("Go to {agentName}", { agentName: goal.agentName })
		: `Go to ${goal.agentName}`;
}

/**
 * The quest tracker: who most needs the user (or who is nearest) and what
 * is waiting there. Like a tracked quest it is the way there: activating it
 * walks the player up to that agent. The detail line folds away on narrow
 * screens.
 */
export function QuestTracker({
	goal,
	onGo,
}: {
	goal: TrackerGoal;
	/** Walks to the agent, or opens `goal.askId`; the tracker is the opener. */
	onGo: (agentId: string, opener: HTMLElement, askId?: string) => void;
}) {
	const tl = useLiteralMessages();
	const { agentId } = goal;
	const body = (
		<>
			{goal.status === "attention" ? (
				// Optically centered on the 20px title line.
				<BoardStatusDot className="mt-1.5" pulse={false} status={goal.status} />
			) : null}
			<span className="flex min-w-0 flex-col">
				<span className="flex min-w-0 gap-1 font-medium text-sm leading-5">
					<span className="truncate">{goal.title}</span>
					{goal.suffix ? (
						<span className="shrink-0 tabular-nums">{goal.suffix}</span>
					) : null}
				</span>
				{goal.detail ? (
					<span className="@max-[640px]:hidden truncate text-foreground/70 text-xs leading-4">
						{goal.detail}
					</span>
				) : null}
			</span>
		</>
	);
	const className = cn(
		HUD_SURFACE,
		"flex @max-[480px]:w-auto w-64 @max-[480px]:max-w-56 items-start gap-2 px-3 py-2 text-left"
	);
	if (!agentId) {
		return (
			<div className={className} data-testid="world-3d-tracker">
				{body}
			</div>
		);
	}
	return (
		<button
			aria-label={trackerLabel(goal, tl)}
			className={cn(
				className,
				"pointer-events-auto cursor-pointer outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
			)}
			data-testid="world-3d-tracker"
			onClick={(event) => onGo(agentId, event.currentTarget, goal.askId)}
			type="button"
		>
			{body}
		</button>
	);
}

/** The talk option, or the loading or controls line. */
export function Village3dPrompt({
	loading,
	answer = false,
	nearbyName,
	orbit,
}: {
	/** The agent nearby is asking: E opens its ask. */
	answer?: boolean;
	loading: boolean;
	nearbyName: string | null;
	orbit: boolean;
}) {
	const tl = useLiteralMessages();
	if (nearbyName) {
		// Drawn beside the agent's name plate; announced from here.
		return (
			<span>
				{answer
					? tl("Press E to answer {nearbyName}", { nearbyName })
					: tl("Press E to talk to {nearbyName}", { nearbyName })}
			</span>
		);
	}
	if (loading) {
		return <span>Loading agents</span>;
	}
	return (
		<span className="inline-flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
			<span className="inline-flex items-center gap-1.5">
				<Keycap className="h-5">WASD</Keycap>
				Move
			</span>
			<span className="inline-flex items-center gap-1.5">
				<Keycap className="h-5 min-w-5">E</Keycap>
				{answer ? "Answer" : "Talk"}
			</span>
			{orbit ? (
				<span className="@max-[640px]:hidden">Drag to look around</span>
			) : null}
		</span>
	);
}

/**
 * The empty village: a plain card in the middle of the island with the one
 * thing the user can do here. `startThread({})` runs only on click and
 * carries no prompt, so nothing is sent until the user types.
 */
export function Village3dEmpty({
	onStart,
	place,
}: {
	onStart: () => void;
	place: string;
}) {
	const tl = useLiteralMessages();
	return (
		<div
			className={cn(
				HUD_SURFACE,
				"pointer-events-auto flex w-80 max-w-[calc(100%-24px)] flex-col items-start gap-3 p-4"
			)}
			data-testid="world-3d-empty"
		>
			<div className="flex flex-col gap-1">
				<h2 className="font-semibold text-base">
					{tl("No agents in the {place}", { place })}
				</h2>
				<p className="text-card-foreground/70 text-sm">
					Each agent gets a house here. Start a conversation to set one up.
				</p>
			</div>
			<Button onClick={onStart} size="sm" type="button">
				New conversation
			</Button>
		</div>
	);
}

/**
 * Overlay for the visible part of the 3D viewport. `prompt` is omitted while
 * a conversation is open, since the dialogue already says who you talk to.
 */
export function Village3dHud({
	acts,
	empty,
	minimap,
	prompt,
	talkReady,
	tracker,
}: {
	/** The act layer's summary, caption and Need you / Queue buttons (top right). */
	acts?: ReactNode;
	/** Shown in the middle instead of the prompt when there are no agents. */
	empty?: ReactNode;
	minimap?: ReactNode;
	prompt?: ReactNode;
	/** The prompt is a talk option: drawn by the agent's plate, only announced here. */
	talkReady: boolean;
	tracker?: ReactNode;
}) {
	return (
		<div
			className="@container pointer-events-none absolute inset-0 z-[400] select-none font-sans"
			data-testid="world-hud"
		>
			<div
				className="absolute top-3 left-3 flex flex-col items-start gap-3"
				data-hud-band=""
			>
				{/* The map's ring sits 4px inside its square: pull it onto the gutter. */}
				{minimap ? (
					<div className="-m-1 @max-[480px]:hidden">{minimap}</div>
				) : null}
				{tracker}
			</div>
			{acts ? (
				// Below the tracker on narrow stages, top right beside it on wide ones.
				<div
					className="pointer-events-auto absolute @max-[640px]:top-16 top-3 right-3 flex max-w-[calc(100%-24px)] flex-col items-end gap-2"
					data-hud-band=""
				>
					{acts}
				</div>
			) : null}
			{empty ? (
				<div className="absolute inset-0 flex items-center justify-center p-3">
					{empty}
				</div>
			) : null}
			{prompt ? (
				<div
					aria-live="polite"
					className={cn(
						"absolute",
						talkReady
							? "sr-only"
							: cn(
									HUD_SURFACE,
									// Bottom right, clear of the player, as control hints sit in
									// the genre; phones have no keys to hint at.
									"right-3 bottom-3 @max-[480px]:hidden max-w-[calc(100%-24px)] px-2.5 py-1.5 text-muted-foreground text-xs"
								)
					)}
					role="status"
				>
					{prompt}
				</div>
			) : null}
		</div>
	);
}

/** Tiles across the minimap's view. */
const MINIMAP_TILES = 17;

const MinimapTerrain = memo(function MinimapTerrain({
	layout,
	scale,
	swatches,
	theme,
	village,
}: {
	layout: WorldLayout;
	scale: number;
	swatches: ReadonlyMap<string, AgentSwatch>;
	theme: Scene3dTheme;
	village: VillageLayout;
}) {
	const paths: string[] = [];
	for (const key of village.paths) {
		const [x = 0, y = 0] = key.split(",").map(Number);
		paths.push(`M${x * scale} ${y * scale}h${scale}v${scale}h${-scale}z`);
	}
	const trees = village.trees
		.map(
			(tree) =>
				`M${(tree.x + 0.5) * scale} ${(tree.y + 0.15) * scale}a${scale * 0.35} ${scale * 0.35} 0 1 0 0.01 0z`
		)
		.join("");
	return (
		<g>
			<rect
				fill={theme.grass[0]}
				height={layout.height * scale}
				rx={scale}
				width={layout.width * scale}
			/>
			<path d={paths.join("")} fill={theme.path[0]} opacity={0.95} />
			<path d={trees} fill={theme.pineLeaves[0]} opacity={0.7} />
			{village.houses.map((house) => (
				<rect
					className="stroke-background/70"
					fill={swatchOf(swatches, house.agentId).roof[0]}
					height={house.h * scale - 2}
					key={house.agentId}
					rx={2}
					strokeWidth={1}
					width={house.w * scale - 2}
					x={house.x * scale + 1}
					y={house.y * scale + 1}
				/>
			))}
		</g>
	);
});

const ARROW_TURN: Record<WorldDirection, number> = {
	down: 180,
	left: 270,
	right: 90,
	up: 0,
};

/**
 * Round minimap centered on the player: paths, cottages in their roof
 * colors, agents (working ones ringed in the success color), a compass "N"
 * on a single ring and the player's arrow pointing where they face.
 */
export function Village3dMinimap({
	entities,
	facing,
	layout,
	nearbyId,
	player,
	size,
	swatches,
	theme,
	village,
}: {
	entities: readonly WorldEntity[];
	facing: WorldDirection;
	layout: WorldLayout;
	nearbyId: string | null;
	player: WorldPoint;
	size: number;
	swatches: ReadonlyMap<string, AgentSwatch>;
	theme: Scene3dTheme;
	village: VillageLayout;
}) {
	const tl = useLiteralMessages();
	const scale = size / MINIMAP_TILES;
	const working = entities.filter(
		(entity) => entity.status === "working"
	).length;
	const center = size / 2;
	const shiftX = center - (player.x + 0.5) * scale;
	const shiftY = center - (player.y + 0.5) * scale;
	return (
		<svg
			aria-label={tl(
				"Village map: {agentCount} agents, {workingCount} working",
				{
					agentCount: String(entities.length),
					workingCount: String(working),
				}
			)}
			className="block"
			height={size + 8}
			role="img"
			viewBox={`-4 -4 ${size + 8} ${size + 8}`}
			width={size + 8}
		>
			<defs>
				<clipPath id="ryu-w3d-minimap-clip">
					<circle cx={center} cy={center} r={center} />
				</clipPath>
			</defs>
			<circle
				cx={center}
				cy={center}
				fill={theme.water ?? theme.sky}
				r={center}
			/>
			<g clipPath="url(#ryu-w3d-minimap-clip)">
				<g transform={`translate(${shiftX} ${shiftY})`}>
					<MinimapTerrain
						layout={layout}
						scale={scale}
						swatches={swatches}
						theme={theme}
						village={village}
					/>
					{entities.map((entity) => {
						const near = entity.agentId === nearbyId;
						const busy = entity.status === "working";
						return (
							<circle
								className={busy ? "stroke-success" : "stroke-background"}
								cx={(entity.x + 0.5) * scale}
								cy={(entity.y + 0.5) * scale}
								fill={swatchOf(swatches, entity.agentId).dot}
								key={entity.agentId}
								r={near ? scale * 0.62 : scale * 0.45}
								strokeWidth={busy ? 2 : 1.2}
							/>
						);
					})}
				</g>
			</g>
			<circle
				className="stroke-border"
				cx={center}
				cy={center}
				fill="none"
				r={center}
				strokeWidth={2}
			/>
			<g transform={`translate(${center} 0)`}>
				<circle className="fill-background stroke-border" r={7} />
				<text
					className="fill-foreground font-sans font-semibold"
					dominantBaseline="central"
					fontSize="8"
					textAnchor="middle"
				>
					N
				</text>
			</g>
			<g
				transform={`translate(${center} ${center}) rotate(${ARROW_TURN[facing]})`}
			>
				<path
					className="fill-primary stroke-background"
					d="M0 -8 6 6 0 3 -6 6Z"
					strokeLinejoin="round"
					strokeWidth={1.5}
				/>
			</g>
		</svg>
	);
}
