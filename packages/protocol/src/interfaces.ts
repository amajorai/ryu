import { z } from "zod";
import { isMarketplaceId, type JsonValue } from "./marketplace-wallpaper.ts";

/**
 * Ryu Interface Protocol (v1).
 *
 * An **interface** is a presentation layer over the same agents, threads, and
 * messages. Bot, OS, and Console were the first three; Channels, Feed, and the
 * 2D/3D worlds are the next. Every interface reads one normalized
 * {@link InterfaceSnapshot} and acts through one {@link InterfacePort}, so the
 * chat engine (streaming, tools, approvals, history) stays a single source of
 * truth and an interface can only change how that state is displayed.
 *
 * Marketplace interfaces are data-only, like themes and wallpapers: a plugin
 * contributes `contributes.interfaces[]`, each entry names one host-owned
 * {@link InterfaceRenderer} plus bounded params. No interface ships executable
 * rendering code into the shell.
 */
export const INTERFACE_PROTOCOL_VERSION = 1;

/** Host-owned renderers, in the order the switcher lists them. */
export const INTERFACE_RENDERERS = [
	"bot",
	"os",
	"console",
	"channels",
	"feed",
	"world-2d",
	"world-3d",
	"board",
	"inbox",
	"graph",
	"timeline",
	"messenger",
	"terminal",
	"arena",
	"desk",
	"card-table",
	"sheet",
	"canvas",
	"calendar",
	"notebook",
	"mission-control",
	"ticker",
	"focus",
	"aquarium",
	"planets",
	"stream",
	"forum",
	"live",
	"posts",
	"community",
	"wiki",
	"dashboard",
	"mindmap",
	"gallery",
	"newspaper",
	"qa",
	"cinema",
	"noticeboard",
	"mail",
	"status",
	"records",
	"path",
	"glance",
	"hub",
	"library",
	"tickets",
	"persona",
	"panels",
	"departures",
	"tracking",
	"flow",
	"moments",
	"kitchen",
	"market",
	"workers",
	"arcade",
	"farm",
	"town",
	"rides",
	"journal",
	"passport",
	"lobby",
	"seasonal",
	"bank",
	"quiz",
	"jobs",
	"knowledge",
	"hologram",
	"warehouse",
] as const;
export type InterfaceRenderer = (typeof INTERFACE_RENDERERS)[number];

/**
 * The product tier an interface runs in. The tier decides access and feature
 * level; the renderer decides presentation.
 *
 * - `managed`: Bot's focused chat, available to everyone.
 * - `workspace`: the full workspace without organization-admin controls.
 * - `admin`: Agent, gated server-side by organization authority.
 */
export type InterfaceTier = "admin" | "managed" | "workspace";

const RENDERER_TIER = {
	bot: "managed",
	os: "workspace",
	console: "admin",
	channels: "workspace",
	feed: "workspace",
	"world-2d": "workspace",
	"world-3d": "workspace",
	board: "workspace",
	inbox: "workspace",
	graph: "workspace",
	timeline: "workspace",
	messenger: "workspace",
	terminal: "workspace",
	arena: "workspace",
	desk: "workspace",
	"card-table": "workspace",
	sheet: "workspace",
	canvas: "workspace",
	calendar: "workspace",
	notebook: "workspace",
	"mission-control": "workspace",
	ticker: "workspace",
	focus: "workspace",
	aquarium: "workspace",
	planets: "workspace",
	stream: "workspace",
	forum: "workspace",
	live: "workspace",
	posts: "workspace",
	community: "workspace",
	wiki: "workspace",
	dashboard: "workspace",
	mindmap: "workspace",
	gallery: "workspace",
	newspaper: "workspace",
	qa: "workspace",
	cinema: "workspace",
	noticeboard: "workspace",
	mail: "workspace",
	status: "workspace",
	records: "workspace",
	path: "workspace",
	glance: "workspace",
	hub: "workspace",
	library: "workspace",
	tickets: "workspace",
	persona: "workspace",
	panels: "workspace",
	departures: "workspace",
	tracking: "workspace",
	flow: "workspace",
	moments: "workspace",
	kitchen: "workspace",
	market: "workspace",
	workers: "workspace",
	arcade: "workspace",
	farm: "workspace",
	town: "workspace",
	rides: "workspace",
	journal: "workspace",
	passport: "workspace",
	lobby: "workspace",
	seasonal: "workspace",
	bank: "workspace",
	quiz: "workspace",
	jobs: "workspace",
	knowledge: "workspace",
	hologram: "workspace",
	warehouse: "workspace",
} as const satisfies Record<InterfaceRenderer, InterfaceTier>;

/** Tier a renderer runs in. */
export function interfaceTier(renderer: InterfaceRenderer): InterfaceTier {
	return RENDERER_TIER[renderer];
}

/**
 * Renderers a Marketplace contribution may select. The managed and admin
 * shells are host-only: a plugin cannot opt a user into Console, and Bot's
 * restricted route set is not a presentation choice.
 */
export const CONTRIBUTABLE_INTERFACE_RENDERERS: readonly InterfaceRenderer[] =
	INTERFACE_RENDERERS.filter(
		(renderer) => interfaceTier(renderer) === "workspace"
	);

export function isInterfaceRenderer(
	value: unknown
): value is InterfaceRenderer {
	return INTERFACE_RENDERERS.some((renderer) => renderer === value);
}

/** Namespace reserved for interfaces that ship with Ryu. */
export const BUILTIN_INTERFACE_NAMESPACE = "ryu";

/** Stable id of the built-in interface for a renderer, e.g. `ryu:channels`. */
export function builtinInterfaceId(renderer: InterfaceRenderer): string {
	return `${BUILTIN_INTERFACE_NAMESPACE}:${renderer}`;
}

/** A persisted interface choice is a namespaced `<plugin>:<local-id>` id. */
export function isInterfaceId(value: unknown): value is string {
	return typeof value === "string" && isMarketplaceId(value);
}

// ---------------------------------------------------------------------------
// Renderer params
// ---------------------------------------------------------------------------

export type WorldTheme = "meadow" | "night" | "office";

export interface ChannelsParams {
	/** Put project threads in project channels, or keep them in agent DMs. */
	groupBy: "agent" | "project";
}

export interface FeedParams {
	/** `recent` sorts by last activity; `active` lifts running threads first. */
	order: "active" | "recent";
}

export interface World2dParams {
	/** The controls hint: by stage size, or always shown or hidden ("?" toggles it). */
	controls?: "auto" | "hidden" | "shown";
	theme: WorldTheme;
}

export interface World3dParams {
	camera: "isometric" | "orbit";
	/** The round minimap in the top-left corner. */
	minimap?: boolean;
	theme: WorldTheme;
}

/**
 * The game settings below are optional in the type, like `KitGameParams`, so
 * a renderer can be given `{}`; `resolveInterfaceParams` always fills them.
 */
export interface ArcadeParams {
	/** The hall by day, at night with its neon lit, or as the color theme (dark is night). */
	lights?: "day" | "night" | "theme";
	/** The credits, running and jackpot meters in the bottom-left corner. */
	meters?: boolean;
}

export interface LobbyParams {
	/** The menu tab the lobby opens on (switching tabs keeps the last one). */
	openOn?: "lobby" | "news" | "quests" | "squad";
	/** Agents on the podium, 1 to 4. */
	squadSize?: number;
}

export interface QuizParams {
	/** The studio audience in theatre rows along the front. */
	audience?: boolean;
	/** Tile values: doubled once the board is busy, or always one round. */
	round?: "auto" | "double" | "single";
}

export interface RidesParams {
	/** Day or night in the city, or the color theme's (dark is night). */
	timeOfDay?: "day" | "night" | "theme";
}

export interface BoardParams {
	/** Groups by thread status, one per agent, or one per project. */
	groupBy: "agent" | "project" | "status";
	/** Kanban columns, or a dense list with one section per group. */
	view: "board" | "list";
}

export interface CanvasParams {
	/** How cards are first laid out before the user moves them. */
	arrange: "agent" | "status";
	/** The overview map: shown when the board is wide enough (`auto`), always, or never. */
	minimap: "auto" | "hidden" | "shown";
}

export interface CardTableParams {
	/** The card backs: the stock blue, or a named deck. */
	deck?: "black" | "classic" | "red";
	/** The table's cloth: the stock baize, or a named felt. */
	felt?: "blue" | "classic" | "red";
	/**
	 * The layout the Card Table starts in: `poker` seats agents around a felt
	 * table with the user's hand, and `spread` drops the table and lays each
	 * agent out as a deck of its conversations. The user can still switch
	 * between the two (Table and Cards) from the header, which saves the
	 * choice as their setting (`updateSettings`).
	 */
	layout: "poker" | "spread";
}

export interface SeasonalParams {
	/**
	 * Which seasonal board to show first; `auto` picks one from today's date
	 * (Halloween in October, Advent from 20 November through December, Lunar
	 * New Year from 15 January through February, otherwise Advent). The user
	 * can still switch boards from the header; that choice is not saved and
	 * resets when this param changes.
	 */
	season: "advent" | "auto" | "halloween" | "lunar-new-year";
	/** Snow over the advent square, and motes over the patch and the street. */
	weather?: boolean;
}

export interface CalendarParams {
	/** Whether the side rail (mini month and layers) is open on a wide window. */
	rail: boolean;
	/** A month grid, or a seven-day week. */
	scale: "month" | "week";
}

/** The Knowledge graph's "Graph settings" panel: what it shows and how it moves. */
export interface KnowledgeParams {
	agents: boolean;
	/** Center force, 0..1. */
	centerForce: number;
	conversations: boolean;
	/** How many links out a local graph reaches. */
	depth: number;
	groups: boolean;
	/** Link distance in world units, 12..120. */
	linkDistance: number;
	/** Link force, 0..1. */
	linkForce: number;
	/** Link thickness in CSS pixels, 0.5..4. */
	linkWidth: number;
	/** Topics also link conversations by their latest message. */
	messages: boolean;
	mode: "global" | "local";
	/** Node size multiplier, 0.5..2. */
	nodeSize: number;
	orphans: boolean;
	/** Repel force, 0..1. */
	repelForce: number;
	/** Text fade threshold, 0..1. */
	textFade: number;
	topics: boolean;
}

export interface TimelineParams {
	/** A day-by-day list, or a seven-day week grid. */
	scale: "day" | "week";
}

/**
 * Settings every kit 3D game shares (the act layer's stations and
 * villagers), on top of its own. Optional in the type so a renderer can be
 * given `{}`; `resolveInterfaceParams` always fills them.
 */
export interface KitchenParams {
	/** Show the service clock in the kitchen's corner. */
	serviceClock?: boolean;
}

export interface WorkersParams {
	/** What each monitor's plate says: the step a worker is on, or its conversation's title. */
	screenWords?: "step" | "title";
}

export interface FarmParams {
	/** Show the coins counter (one coin per message). */
	coins?: boolean;
}

export interface TownParams {
	/** The town map's data overlay. */
	dataView?: "activity" | "needs" | "none";
	/**
	 * How fast the town's clock and traffic run. `auto` (the default) runs at
	 * normal speed, or starts paused when the user prefers reduced motion.
	 */
	speed?: "auto" | "fast" | "normal" | "paused";
}

export interface AquariumParams {
	/** The wallpaper of the room the tank stands in. */
	wallpaper?: "blue" | "cream" | "sage";
}

export interface PathParams {
	/** Show the streak, XP and daily goal in the top bar. */
	stats?: boolean;
}

export interface MarketParams {
	/** The shops' awning colours: the mixed stock, or a named preset. */
	awnings?: "harvest" | "mixed" | "seaside";
	/** Pennant strings over the square (lit with bulbs at night). */
	bunting?: boolean;
}

export interface WarehouseParams {
	/** The floor stands still (the HUD's pause button keeps this). */
	paused?: boolean;
	/** The shift's light: the color theme's (dark is night), or day or night. */
	shift?: "day" | "night" | "theme";
}

export interface PassportParams {
	/** The booklet's cover colour. */
	cover?: "black" | "burgundy" | "green" | "navy";
}

export interface PlanetsParams {
	/** Pin the titles of the visited body's moons (else on hover or focus). */
	moonLabels?: boolean;
	/** How fast planets travel their orbits and moons circle them. */
	orbitSpeed?: "normal" | "slow" | "still";
}

export interface KitGameParams {
	/** `minimal` keeps only limit lines on station boards (no progress, next, elapsed). */
	overlayDensity?: "full" | "minimal";
	/** Show villagers' work bubbles ("Editing snapshot.ts"); asks and alarms always show. */
	workBubbles?: boolean;
}

export interface InterfaceParamsByRenderer {
	aquarium: AquariumParams & KitGameParams;
	arcade: ArcadeParams & KitGameParams;
	arena: Record<string, never>;
	bank: Record<string, never>;
	board: BoardParams;
	bot: Record<string, never>;
	calendar: CalendarParams;
	canvas: CanvasParams;
	"card-table": CardTableParams & KitGameParams;
	channels: ChannelsParams;
	cinema: Record<string, never>;
	community: Record<string, never>;
	console: Record<string, never>;
	dashboard: Record<string, never>;
	departures: Record<string, never>;
	desk: Record<string, never>;
	farm: FarmParams & KitGameParams;
	feed: FeedParams;
	flow: Record<string, never>;
	focus: Record<string, never>;
	forum: Record<string, never>;
	gallery: Record<string, never>;
	glance: Record<string, never>;
	graph: Record<string, never>;
	hologram: Record<string, never>;
	hub: Record<string, never>;
	inbox: Record<string, never>;
	jobs: Record<string, never>;
	journal: Record<string, never>;
	kitchen: KitchenParams & KitGameParams;
	knowledge: KnowledgeParams;
	library: Record<string, never>;
	live: Record<string, never>;
	lobby: LobbyParams & KitGameParams;
	mail: Record<string, never>;
	market: MarketParams & KitGameParams;
	messenger: Record<string, never>;
	mindmap: Record<string, never>;
	"mission-control": Record<string, never>;
	moments: Record<string, never>;
	newspaper: Record<string, never>;
	notebook: Record<string, never>;
	noticeboard: Record<string, never>;
	os: Record<string, never>;
	panels: Record<string, never>;
	passport: PassportParams & KitGameParams;
	path: PathParams & KitGameParams;
	persona: Record<string, never>;
	planets: PlanetsParams & KitGameParams;
	posts: Record<string, never>;
	qa: Record<string, never>;
	quiz: QuizParams & KitGameParams;
	records: Record<string, never>;
	rides: RidesParams & KitGameParams;
	seasonal: SeasonalParams & KitGameParams;
	sheet: Record<string, never>;
	status: Record<string, never>;
	stream: Record<string, never>;
	terminal: Record<string, never>;
	ticker: Record<string, never>;
	tickets: Record<string, never>;
	timeline: TimelineParams;
	town: TownParams & KitGameParams;
	tracking: Record<string, never>;
	warehouse: WarehouseParams & KitGameParams;
	wiki: Record<string, never>;
	workers: WorkersParams & KitGameParams;
	"world-2d": World2dParams & KitGameParams;
	"world-3d": World3dParams & KitGameParams;
}

const MAX_LABEL = 64;
const MAX_DESCRIPTION = 160;
const MAX_SETTING_DESCRIPTION = 160;
const MAX_PARAMS_JSON = 4096;

const worldTheme = z.enum(["meadow", "night", "office"]).catch("meadow");
/** The kit game settings' schema shape (`KitGameParams`), spread into each kit game. */
const KIT_GAME_SHAPE = {
	overlayDensity: z.enum(["full", "minimal"]).catch("full"),
	workBubbles: z.boolean().catch(true),
};
const paramObject = z.record(z.string(), z.unknown()).catch(() => ({}));
/** A 0..1 slider param. */
const unitRange = (fallback: number) =>
	z.number().min(0).max(1).catch(fallback);

const PARAM_SCHEMAS = {
	bot: z.object({}).catch(() => ({})),
	os: z.object({}).catch(() => ({})),
	console: z.object({}).catch(() => ({})),
	channels: z.object({
		groupBy: z.enum(["agent", "project"]).catch("agent"),
	}),
	feed: z.object({ order: z.enum(["active", "recent"]).catch("recent") }),
	"world-2d": z.object({
		...KIT_GAME_SHAPE,
		controls: z.enum(["auto", "shown", "hidden"]).catch("auto"),
		theme: worldTheme,
	}),
	"world-3d": z.object({
		...KIT_GAME_SHAPE,
		camera: z.enum(["isometric", "orbit"]).catch("orbit"),
		minimap: z.boolean().catch(true),
		theme: worldTheme,
	}),
	board: z.object({
		groupBy: z.enum(["agent", "project", "status"]).catch("status"),
		view: z.enum(["board", "list"]).catch("board"),
	}),
	inbox: z.object({}).catch(() => ({})),
	graph: z.object({}).catch(() => ({})),
	timeline: z.object({ scale: z.enum(["day", "week"]).catch("day") }),
	messenger: z.object({}).catch(() => ({})),
	terminal: z.object({}).catch(() => ({})),
	arena: z.object({}).catch(() => ({})),
	desk: z.object({}).catch(() => ({})),
	"card-table": z.object({
		...KIT_GAME_SHAPE,
		deck: z.enum(["black", "classic", "red"]).catch("classic"),
		felt: z.enum(["blue", "classic", "red"]).catch("classic"),
		layout: z.enum(["poker", "spread"]).catch("poker"),
	}),
	sheet: z.object({}).catch(() => ({})),
	canvas: z.object({
		arrange: z.enum(["agent", "status"]).catch("status"),
		minimap: z.enum(["auto", "hidden", "shown"]).catch("auto"),
	}),
	calendar: z.object({
		rail: z.boolean().catch(true),
		scale: z.enum(["month", "week"]).catch("month"),
	}),
	notebook: z.object({}).catch(() => ({})),
	"mission-control": z.object({}).catch(() => ({})),
	ticker: z.object({}).catch(() => ({})),
	focus: z.object({}).catch(() => ({})),
	aquarium: z.object({
		...KIT_GAME_SHAPE,
		wallpaper: z.enum(["blue", "cream", "sage"]).catch("cream"),
	}),
	planets: z.object({
		...KIT_GAME_SHAPE,
		moonLabels: z.boolean().catch(true),
		orbitSpeed: z.enum(["normal", "slow", "still"]).catch("normal"),
	}),
	stream: z.object({}).catch(() => ({})),
	forum: z.object({}).catch(() => ({})),
	live: z.object({}).catch(() => ({})),
	posts: z.object({}).catch(() => ({})),
	community: z.object({}).catch(() => ({})),
	wiki: z.object({}).catch(() => ({})),
	dashboard: z.object({}).catch(() => ({})),
	mindmap: z.object({}).catch(() => ({})),
	gallery: z.object({}).catch(() => ({})),
	newspaper: z.object({}).catch(() => ({})),
	qa: z.object({}).catch(() => ({})),
	cinema: z.object({}).catch(() => ({})),
	noticeboard: z.object({}).catch(() => ({})),
	mail: z.object({}).catch(() => ({})),
	status: z.object({}).catch(() => ({})),
	records: z.object({}).catch(() => ({})),
	path: z.object({ ...KIT_GAME_SHAPE, stats: z.boolean().catch(true) }),
	glance: z.object({}).catch(() => ({})),
	hub: z.object({}).catch(() => ({})),
	library: z.object({}).catch(() => ({})),
	tickets: z.object({}).catch(() => ({})),
	persona: z.object({}).catch(() => ({})),
	panels: z.object({}).catch(() => ({})),
	departures: z.object({}).catch(() => ({})),
	tracking: z.object({}).catch(() => ({})),
	flow: z.object({}).catch(() => ({})),
	moments: z.object({}).catch(() => ({})),
	kitchen: z.object({
		...KIT_GAME_SHAPE,
		serviceClock: z.boolean().catch(true),
	}),
	market: z.object({
		...KIT_GAME_SHAPE,
		awnings: z.enum(["harvest", "mixed", "seaside"]).catch("mixed"),
		bunting: z.boolean().catch(true),
	}),
	workers: z.object({
		...KIT_GAME_SHAPE,
		screenWords: z.enum(["step", "title"]).catch("step"),
	}),
	arcade: z.object({
		...KIT_GAME_SHAPE,
		lights: z.enum(["theme", "day", "night"]).catch("theme"),
		meters: z.boolean().catch(true),
	}),
	farm: z.object({ ...KIT_GAME_SHAPE, coins: z.boolean().catch(true) }),
	town: z.object({
		...KIT_GAME_SHAPE,
		dataView: z.enum(["activity", "needs", "none"]).catch("none"),
		speed: z.enum(["auto", "fast", "normal", "paused"]).catch("auto"),
	}),
	rides: z.object({
		...KIT_GAME_SHAPE,
		timeOfDay: z.enum(["theme", "day", "night"]).catch("theme"),
	}),
	journal: z.object({}).catch(() => ({})),
	passport: z.object({
		...KIT_GAME_SHAPE,
		cover: z.enum(["black", "burgundy", "green", "navy"]).catch("navy"),
	}),
	lobby: z.object({
		...KIT_GAME_SHAPE,
		openOn: z.enum(["lobby", "quests", "squad", "news"]).catch("lobby"),
		squadSize: z.number().int().min(1).max(4).catch(4),
	}),
	seasonal: z.object({
		...KIT_GAME_SHAPE,
		season: z
			.enum(["advent", "auto", "halloween", "lunar-new-year"])
			.catch("auto"),
		weather: z.boolean().catch(true),
	}),
	bank: z.object({}).catch(() => ({})),
	quiz: z.object({
		...KIT_GAME_SHAPE,
		audience: z.boolean().catch(true),
		round: z.enum(["auto", "single", "double"]).catch("auto"),
	}),
	jobs: z.object({}).catch(() => ({})),
	knowledge: z.object({
		agents: z.boolean().catch(true),
		centerForce: unitRange(0.5),
		conversations: z.boolean().catch(true),
		depth: z.number().int().min(1).max(2).catch(1),
		groups: z.boolean().catch(true),
		linkDistance: z.number().min(12).max(120).catch(30),
		linkForce: unitRange(0.6),
		linkWidth: z.number().min(0.5).max(4).catch(1),
		messages: z.boolean().catch(false),
		mode: z.enum(["global", "local"]).catch("global"),
		nodeSize: z.number().min(0.5).max(2).catch(1),
		orphans: z.boolean().catch(true),
		repelForce: unitRange(0.5),
		textFade: unitRange(0.5),
		topics: z.boolean().catch(true),
	}),
	hologram: z.object({}).catch(() => ({})),
	warehouse: z.object({
		...KIT_GAME_SHAPE,
		paused: z.boolean().catch(false),
		shift: z.enum(["day", "night", "theme"]).catch("theme"),
	}),
} as const;

/**
 * Resolve untrusted params to a renderer's typed params. Unknown keys are
 * dropped and every invalid value falls back to its default, so a bad
 * Marketplace entry degrades to the stock look instead of failing to render.
 */
export function resolveInterfaceParams<R extends InterfaceRenderer>(
	renderer: R,
	raw: unknown
): InterfaceParamsByRenderer[R] {
	const parsed = PARAM_SCHEMAS[renderer].parse(paramObject.parse(raw));
	// SAFETY: PARAM_SCHEMAS is keyed by renderer and each schema's output is the
	// matching InterfaceParamsByRenderer member; TypeScript cannot correlate the
	// generic key with the indexed schema's inferred output type.
	return parsed as InterfaceParamsByRenderer[R];
}

// ---------------------------------------------------------------------------
// Settings: the renderable form of a renderer's params
// ---------------------------------------------------------------------------

/** A setting's value: the same scalar kinds a param may hold. */
export type InterfaceSettingValue = boolean | number | string;

/** One choice of a `select` setting. */
export interface InterfaceSettingOption {
	label: string;
	value: string;
}

/**
 * One user-facing setting of an interface: a param the host shows in
 * Settings → Appearance → Interfaces (and a renderer may change in view with
 * `InterfacePort.updateSettings`). `key` is the param's key; `default` is
 * what `resolveInterfaceParams` gives when the param is unset.
 */
export interface InterfaceSettingField {
	default: InterfaceSettingValue;
	description?: string;
	key: string;
	label: string;
	/** `number`: the allowed range and step. */
	max?: number;
	min?: number;
	/** `select`: the choices, in order. */
	options?: readonly InterfaceSettingOption[];
	step?: number;
	type: "boolean" | "number" | "select" | "text";
}

const select = (
	key: string,
	label: string,
	options: readonly [string, string][],
	description?: string
): InterfaceSettingField => ({
	default: options[0]?.[0] ?? "",
	...(description ? { description } : {}),
	key,
	label,
	options: options.map(([value, optionLabel]) => ({
		label: optionLabel,
		value,
	})),
	type: "select",
});

const toggle = (
	key: string,
	label: string,
	fallback: boolean,
	description?: string
): InterfaceSettingField => ({
	default: fallback,
	...(description ? { description } : {}),
	key,
	label,
	type: "boolean",
});

const range = (
	key: string,
	label: string,
	fallback: number,
	bounds: { max: number; min: number; step: number }
): InterfaceSettingField => ({
	default: fallback,
	key,
	label,
	...bounds,
	type: "number",
});

const UNIT_RANGE = { max: 1, min: 0, step: 0.05 } as const;
const FORCE_RANGE = { max: 1, min: 0, step: 0.02 } as const;

const THEME_OPTIONS: readonly [string, string][] = [
	["meadow", "Meadow"],
	["night", "Night"],
	["office", "Office"],
];

/**
 * The settings every kit 3D game shares (`KitGameParams`), appended to each
 * kit game's own (`KIT_GAME_RENDERERS`).
 */
export const KIT_GAME_SETTINGS: readonly InterfaceSettingField[] = [
	select(
		"overlayDensity",
		"Overlay density",
		[
			["full", "Full"],
			["minimal", "Minimal"],
		],
		"Minimal keeps alarms, asks and limits, and drops progress and next-step lines from stations."
	),
	{
		default: true,
		description:
			"What each agent is working on, over its head. Asks and alarms always show.",
		key: "workBubbles",
		label: "Work bubbles",
		type: "boolean",
	},
];

/** The renderers built on the 3D game kit's act stations (they share KIT_GAME_SETTINGS). */
export const KIT_GAME_RENDERERS: readonly InterfaceRenderer[] = [
	"aquarium",
	"arcade",
	"card-table",
	"farm",
	"kitchen",
	"lobby",
	"market",
	"passport",
	"path",
	"planets",
	"quiz",
	"rides",
	"seasonal",
	"town",
	"warehouse",
	"workers",
	"world-3d",
];

/**
 * Each renderer's own settings, in lockstep with PARAM_SCHEMAS: one field per
 * param, its `default` the schema's fallback, a `select`'s options the
 * schema's enum (a test holds them together). Renderers with no params have
 * none; kit games add KIT_GAME_SETTINGS (see `interfaceSettingsFor`).
 */
export const RENDERER_SETTINGS: Partial<
	Record<InterfaceRenderer, readonly InterfaceSettingField[]>
> = {
	board: [
		select("view", "Layout", [
			["board", "Board"],
			["list", "List"],
		]),
		select("groupBy", "Group by", [
			["status", "Status"],
			["agent", "Agent"],
			["project", "Project"],
		]),
	],
	calendar: [
		select("scale", "Scale", [
			["month", "Month"],
			["week", "Week"],
		]),
		toggle(
			"rail",
			"Side rail",
			true,
			"The mini month and layers beside the calendar on a wide window."
		),
	],
	canvas: [
		select("arrange", "First layout", [
			["status", "By status"],
			["agent", "By agent"],
		]),
		select(
			"minimap",
			"Minimap",
			[
				["auto", "When there's room"],
				["shown", "Always"],
				["hidden", "Never"],
			],
			"The overview map in the corner of a wide board."
		),
	],
	aquarium: [
		select("wallpaper", "Wallpaper", [
			["cream", "Cream"],
			["sage", "Sage"],
			["blue", "Blue"],
		]),
	],
	"card-table": [
		select(
			"layout",
			"Table",
			[
				["poker", "Poker table"],
				["spread", "Spread"],
			],
			"The Table and Cards switch in the header keeps your choice."
		),
		select("felt", "Felt", [
			["classic", "Classic"],
			["blue", "Blue"],
			["red", "Red"],
		]),
		select("deck", "Card backs", [
			["classic", "Classic"],
			["red", "Red"],
			["black", "Black"],
		]),
	],
	channels: [
		select("groupBy", "Project threads", [
			["agent", "In agent DMs"],
			["project", "In project channels"],
		]),
	],
	farm: [
		toggle("coins", "Coins", true, "The coins counter: one coin per message."),
	],
	feed: [
		select("order", "Order", [
			["recent", "Most recent"],
			["active", "Running first"],
		]),
	],
	kitchen: [
		toggle(
			"serviceClock",
			"Service clock",
			true,
			"The clock in the kitchen's corner, with the time to the next order."
		),
	],
	market: [
		select("awnings", "Awnings", [
			["mixed", "Mixed"],
			["harvest", "Harvest"],
			["seaside", "Seaside"],
		]),
		toggle(
			"bunting",
			"Bunting",
			true,
			"Pennant strings over the square, lit with bulbs at night."
		),
	],
	passport: [
		select("cover", "Cover", [
			["navy", "Navy"],
			["burgundy", "Burgundy"],
			["green", "Green"],
			["black", "Black"],
		]),
	],
	planets: [
		select("orbitSpeed", "Orbit speed", [
			["normal", "Normal"],
			["slow", "Slow"],
			["still", "Still"],
		]),
		toggle(
			"moonLabels",
			"Moon labels",
			true,
			"Name the moons of the planet you visit. Off, a moon's name shows on hover or focus."
		),
	],
	path: [
		toggle(
			"stats",
			"Streak and goal",
			true,
			"The streak, XP and daily goal in the top bar."
		),
	],
	seasonal: [
		select(
			"season",
			"Season",
			[
				["auto", "From today's date"],
				["advent", "Advent"],
				["halloween", "Halloween"],
				["lunar-new-year", "Lunar New Year"],
			],
			"The season menu on the board keeps your choice."
		),
		toggle(
			"weather",
			"Weather",
			true,
			"Snow over the advent square, and motes drifting over the patch and the street."
		),
	],
	timeline: [
		select("scale", "Scale", [
			["day", "Day"],
			["week", "Week"],
		]),
	],
	knowledge: [
		select("mode", "Graph", [
			["global", "Everything"],
			["local", "Around the selection"],
		]),
		range("depth", "Local depth", 1, { max: 2, min: 1, step: 1 }),
		toggle("agents", "Agents", true),
		toggle("groups", "Projects and teams", true),
		toggle("conversations", "Conversations", true),
		toggle("topics", "Topics", true),
		toggle(
			"messages",
			"Include latest messages",
			false,
			"Topics also link conversations by words in their latest message."
		),
		toggle("orphans", "Orphans", true),
		range("textFade", "Text fade threshold", 0.5, UNIT_RANGE),
		range("nodeSize", "Node size", 1, { max: 2, min: 0.5, step: 0.05 }),
		range("linkWidth", "Link thickness", 1, { max: 4, min: 0.5, step: 0.25 }),
		range("centerForce", "Center force", 0.5, FORCE_RANGE),
		range("repelForce", "Repel force", 0.5, FORCE_RANGE),
		range("linkForce", "Link force", 0.6, FORCE_RANGE),
		range("linkDistance", "Link distance", 30, { max: 120, min: 12, step: 1 }),
	],
	town: [
		select(
			"speed",
			"Speed",
			[
				["auto", "Automatic"],
				["normal", "Normal"],
				["fast", "Fast"],
				["paused", "Paused"],
			],
			"Automatic runs at normal speed, or starts paused when you prefer reduced motion."
		),
		select(
			"dataView",
			"Data view",
			[
				["none", "None"],
				["activity", "Activity"],
				["needs", "Needs"],
			],
			"Tints the districts by how busy they are or by what they need."
		),
	],
	warehouse: [
		select("shift", "Shift", [
			["theme", "Follow the color theme"],
			["day", "Day shift"],
			["night", "Night shift"],
		]),
		toggle(
			"paused",
			"Paused",
			false,
			"The floor stands still. The pause button on the floor keeps your choice."
		),
	],
	workers: [
		select("screenWords", "Screen plates", [
			["step", "What each worker is doing"],
			["title", "The conversation's title"],
		]),
	],
	"world-2d": [
		select("theme", "Theme", THEME_OPTIONS),
		select(
			"controls",
			"Controls hint",
			[
				["auto", "By window size"],
				["shown", "Shown"],
				["hidden", "Hidden"],
			],
			"The keys to walk, talk and visit. The ? slot shows or hides it, and keeps your choice."
		),
		...KIT_GAME_SETTINGS,
	],
	"world-3d": [
		select("camera", "Camera", [
			["orbit", "Orbit"],
			["isometric", "Isometric"],
		]),
		select("theme", "Theme", THEME_OPTIONS),
		toggle(
			"minimap",
			"Minimap",
			true,
			"The round map in the top-left corner, centred on you."
		),
	],
	arcade: [
		select("lights", "Hall lights", [
			["theme", "Follow the color theme"],
			["day", "Day"],
			["night", "Night, neon lit"],
		]),
		toggle(
			"meters",
			"Meters",
			true,
			"Credits, running and jackpot counts, in the bottom-left corner."
		),
	],
	lobby: [
		{
			...range("squadSize", "Squad size", 4, { max: 4, min: 1, step: 1 }),
			description: "How many agents stand on the podium as your squad.",
		},
		select(
			"openOn",
			"Opens on",
			[
				["lobby", "Lobby"],
				["quests", "Quests"],
				["squad", "Squad"],
				["news", "News"],
			],
			"The tab the lobby opens on. Switching tabs keeps the last one."
		),
	],
	quiz: [
		select(
			"round",
			"Round",
			[
				["auto", "Doubles when the board is busy"],
				["single", "Round 1 (100 to 500)"],
				["double", "Double Round (200 to 1,000)"],
			],
			"The tile values."
		),
		toggle(
			"audience",
			"Audience",
			true,
			"The studio audience in theatre rows along the front."
		),
	],
	rides: [
		select("timeOfDay", "Time of day", [
			["theme", "Follow the color theme"],
			["day", "Day"],
			["night", "Night"],
		]),
	],
};

/** Every setting a renderer offers: its own, then the kit games' shared ones. */
export function rendererSettings(
	renderer: InterfaceRenderer
): readonly InterfaceSettingField[] {
	const own = RENDERER_SETTINGS[renderer] ?? [];
	return KIT_GAME_RENDERERS.includes(renderer)
		? [...own, ...KIT_GAME_SETTINGS]
		: own;
}

/**
 * The settings an interface shows: a Marketplace interface's own `settings`
 * (a relabelled subset of its renderer's, already validated), else its
 * renderer's.
 */
export function interfaceSettingsFor(
	descriptor: Pick<InterfaceDescriptor, "renderer" | "settings">
): readonly InterfaceSettingField[] {
	return descriptor.settings ?? rendererSettings(descriptor.renderer);
}

/**
 * An interface's params with the user's `overrides` applied, before
 * resolving: a Marketplace interface's own setting defaults, then its
 * params, then the overrides. Only keys of its settings may be overridden,
 * and only with values that fit them (`settingValueFits`).
 */
export function interfaceParamsWithOverrides(
	descriptor: Pick<InterfaceDescriptor, "params" | "renderer" | "settings">,
	overrides: Readonly<Record<string, InterfaceSettingValue>> | undefined
): Record<string, JsonValue> {
	const fields = new Map(
		interfaceSettingsFor(descriptor).map((field) => [field.key, field])
	);
	const merged: Record<string, JsonValue> = {};
	for (const field of descriptor.settings ?? []) {
		merged[field.key] = field.default;
	}
	Object.assign(merged, descriptor.params);
	// A param outside its narrowed setting falls back to that setting's default,
	// so the renderer draws what Settings shows.
	for (const field of descriptor.settings ?? []) {
		if (!settingValueFits(field, merged[field.key])) {
			merged[field.key] = field.default;
		}
	}
	for (const [key, value] of Object.entries(overrides ?? {})) {
		const field = fields.get(key);
		if (field && settingValueFits(field, value)) {
			merged[key] = value;
		}
	}
	return merged;
}

/** The live, resolved params for an interface with the user's `overrides`. */
export function interfaceParamsWith<R extends InterfaceRenderer>(
	descriptor: Pick<InterfaceDescriptor, "params" | "settings"> & {
		renderer: R;
	},
	overrides: Readonly<Record<string, InterfaceSettingValue>> | undefined
): InterfaceParamsByRenderer[R] {
	return resolveInterfaceParams(
		descriptor.renderer,
		interfaceParamsWithOverrides(descriptor, overrides)
	);
}

/** Whether `value` is a valid choice for `field` (its type; a select's options). */
export function settingValueFits(
	field: InterfaceSettingField,
	value: unknown
): value is InterfaceSettingValue {
	switch (field.type) {
		case "boolean":
			return typeof value === "boolean";
		case "number":
			return (
				typeof value === "number" &&
				Number.isFinite(value) &&
				(field.min === undefined || value >= field.min) &&
				(field.max === undefined || value <= field.max)
			);
		case "select":
			return (
				typeof value === "string" &&
				(field.options ?? []).some((option) => option.value === value)
			);
		case "text":
			return typeof value === "string" && value.length <= 128;
		default:
			return false;
	}
}

/** Most settings one interface may show (the Rust manifest's params cap). */
export const MAX_INTERFACE_SETTINGS = 16;

const settingFieldSchema = z.object({
	default: z.union([z.boolean(), z.number(), z.string().max(128)]).optional(),
	description: z.string().trim().max(MAX_SETTING_DESCRIPTION).optional(),
	key: z.string(),
	label: z.string().trim().min(1).max(MAX_LABEL),
	options: z
		.array(
			z.object({
				label: z.string().trim().min(1).max(MAX_LABEL),
				value: z.string(),
			})
		)
		.max(MAX_INTERFACE_SETTINGS)
		.optional(),
});

/**
 * A Marketplace interface's `settings`: which of its renderer's settings to
 * show, relabelled and reworded, a `select` narrowed to some of its options.
 * Each must name one of the renderer's settings (same key, same type) and
 * may not invent a key, a type or an option. Returns null when the list is
 * absent or any field is invalid (the renderer's own settings then show).
 */
export function parseInterfaceSettings(
	renderer: InterfaceRenderer,
	raw: unknown,
	params: Readonly<Record<string, JsonValue>> = {}
): InterfaceSettingField[] | null {
	if (!Array.isArray(raw) || raw.length > MAX_INTERFACE_SETTINGS) {
		return null;
	}
	const known = new Map(rendererSettings(renderer).map((f) => [f.key, f]));
	const seen = new Set<string>();
	const fields: InterfaceSettingField[] = [];
	for (const row of raw) {
		const parsed = settingFieldSchema.safeParse(row);
		const base = parsed.success ? known.get(parsed.data.key) : undefined;
		if (!(parsed.success && base) || seen.has(base.key)) {
			return null;
		}
		seen.add(base.key);
		const field = parsed.data;
		let options = base.options;
		if (field.options) {
			const allowed = new Set(base.options?.map((option) => option.value));
			if (
				base.type !== "select" ||
				field.options.length === 0 ||
				!field.options.every((option) => allowed.has(option.value))
			) {
				return null;
			}
			options = field.options;
		}
		const narrowed: InterfaceSettingField = {
			...base,
			...(options ? { options } : {}),
		};
		// An explicit default must be valid. Without one, start from the
		// contribution's `params` when that fits the (narrowed) field, else the
		// renderer's default when still offered, else the first option.
		let fallback: InterfaceSettingValue | undefined = field.default;
		if (fallback === undefined) {
			const fromParams = params[base.key];
			if (settingValueFits(narrowed, fromParams)) {
				fallback = fromParams;
			} else if (settingValueFits(narrowed, base.default)) {
				fallback = base.default;
			} else {
				fallback = options?.[0]?.value ?? base.default;
			}
		}
		const resolved = (
			resolveInterfaceParams(renderer, { [base.key]: fallback }) as Record<
				string,
				unknown
			>
		)[base.key];
		const inOptions =
			!options || options.some((option) => option.value === fallback);
		if (resolved !== fallback || !inOptions) {
			return null;
		}
		fields.push({
			...base,
			default: fallback,
			...(field.description ? { description: field.description } : {}),
			label: field.label,
			...(options ? { options } : {}),
		});
	}
	return fields;
}

// ---------------------------------------------------------------------------
// Descriptors and Marketplace contributions
// ---------------------------------------------------------------------------

/** One interface the switcher can offer. */
export interface InterfaceDescriptor {
	attribution?: string;
	description: string;
	id: string;
	label: string;
	origin: "builtin" | "marketplace";
	params: Record<string, JsonValue>;
	/** Owning plugin id for a Marketplace interface. */
	plugin?: string;
	renderer: InterfaceRenderer;
	/**
	 * A Marketplace interface's own settings (see `parseInterfaceSettings`);
	 * absent: its renderer's (`interfaceSettingsFor`).
	 */
	settings?: InterfaceSettingField[];
}

const contributionSchema = z.object({
	attribution: z
		.string()
		.trim()
		.min(1)
		.max(MAX_LABEL)
		.optional()
		.catch(undefined),
	description: z
		.string()
		.trim()
		.max(MAX_DESCRIPTION)
		.optional()
		.catch(undefined),
	id: z.string().refine(isInterfaceId),
	label: z.string().trim().min(1).max(MAX_LABEL),
	params: z
		.record(z.string(), z.json())
		.refine((value) => JSON.stringify(value).length <= MAX_PARAMS_JSON)
		.optional()
		.catch(undefined),
	plugin: z.string().min(1),
	renderer: z.string(),
	settings: z.array(z.unknown()).optional().catch(undefined),
});

/** Most Marketplace interfaces the host will list at once. */
export const MAX_CONTRIBUTED_INTERFACES = 64;

/**
 * Validate one served `contributes.interfaces[]` row (already tagged with its
 * owning `plugin` by Core). Returns null for anything the host must not offer:
 * a malformed row, a host-only renderer, an id outside the plugin's own
 * namespace, or anything from a plugin claiming the reserved `ryu` namespace
 * (a plugin id of `ryu` would otherwise own `ryu:*` ids next to the built-ins).
 */
export function parseInterfaceContribution(
	raw: unknown
): InterfaceDescriptor | null {
	const parsed = contributionSchema.safeParse(raw);
	if (!parsed.success) {
		return null;
	}
	const row = parsed.data;
	if (
		!(
			isInterfaceRenderer(row.renderer) &&
			CONTRIBUTABLE_INTERFACE_RENDERERS.includes(row.renderer)
		)
	) {
		return null;
	}
	if (
		row.plugin === BUILTIN_INTERFACE_NAMESPACE ||
		row.id.startsWith(`${BUILTIN_INTERFACE_NAMESPACE}:`) ||
		!row.id.startsWith(`${row.plugin}:`)
	) {
		return null;
	}
	const settings =
		row.settings === undefined
			? null
			: parseInterfaceSettings(row.renderer, row.settings, row.params ?? {});
	return {
		...(row.attribution ? { attribution: row.attribution } : {}),
		description: row.description ?? "",
		id: row.id,
		label: row.label,
		origin: "marketplace",
		params: row.params ?? {},
		plugin: row.plugin,
		renderer: row.renderer,
		...(settings ? { settings } : {}),
	};
}

/** Validate a served list, dropping invalid rows and duplicate ids. */
export function parseInterfaceContributions(
	raw: unknown
): InterfaceDescriptor[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const seen = new Set<string>();
	const descriptors: InterfaceDescriptor[] = [];
	for (const row of raw) {
		const descriptor = parseInterfaceContribution(row);
		if (descriptor && !seen.has(descriptor.id)) {
			seen.add(descriptor.id);
			descriptors.push(descriptor);
		}
		if (descriptors.length >= MAX_CONTRIBUTED_INTERFACES) {
			break;
		}
	}
	return descriptors;
}

// ---------------------------------------------------------------------------
// Snapshot: the one read model every interface renders
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Useful state: optional detail a host can add so scenes show what each agent
// is doing, what it needs from the user, why it stopped and what it produced.
// Every field is optional and additive; INTERFACE_PROTOCOL_VERSION stays 1.
// ---------------------------------------------------------------------------

// ── Provenance ───────────────────────────────────────────────────────────
/** Where a detail came from, so a scene can label estimates and partial reads honestly. */
export type InterfaceDetailSource =
	| "run-stream" // Core /api/runs/stream push (live)
	| "approvals" // Core approvals inbox (status=pending), SSE-invalidated (live)
	| "messages" // saved message parts read by the host (Core checkpoints every 2 s + host poll)
	| "live-tab" // a chat tab mounted in this host (fresh, that thread only, dropped on reload)
	| "schedule" // scheduler history / next runs (60 s poll)
	| "usage" // per-agent subscription windows (5 min round-robin poll)
	| "estimate"; // host inference (median run length of one routine, or an inferred limit blocker); render as approximate

// ── Asks: what the user is being asked for ───────────────────────────────
export type InterfaceAskKind =
	| "approval" // Core ApprovalRequest (tool_call | workflow_gate | scheduled_run | trigger_run | skill_synthesis | heal_fix)
	| "question" // open tool-Question part in saved parts (main or helper session thread). Blocking only while its thread is running and the part is not async/deferred (isAsyncQuestionPart)
	| "permission" // in-turn ACP data-ryu-permission (visible only to a tab streaming that thread), only while running
	| "input" // run_status === "awaiting_input" (Phase 2(a); always in askBlindSpots until then)
	| "reply"; // the run finished, the agent spoke last, and the answer is UNREAD

export interface InterfaceAskChoice {
	/** Set by the host. The ask card asks for a second confirmation before calling answerAsk.
	 *  Approval: Approve when subject === "tool_call". Permission: every allow-toned option.
	 *  Reject / deny options are never destructive. Renderers never derive this from tag words. */
	destructive?: boolean;
	id: string; // "approve" | "reject" | ACP optionId ("allow_once", …) | question option id
	label: string; // at most 2 words: "Approve", "Allow once", "Reject"
	tone: "allow" | "deny" | "neutral";
}

export interface InterfaceAsk {
	agentId: string | null;
	/** Needs your decision before something can happen: approval tool_call / workflow_gate / scheduled_run /
	 *  trigger_run, permission, blocking question, input. It does NOT by itself mean a run is paused
	 *  (see holdsRun). Non-blocking: reply, and the SUGGESTIONS: async/deferred question, skill_synthesis,
	 *  heal_fix. */
	blocking: boolean;
	/** Choices the port can answer in place (only through the ask card). Absent: the renderer offers Open only. */
	choices?: InterfaceAskChoice[];
	/** expiresAt is an upper bound. Draw "≤" / "up to" / "within" instead of an exact countdown. */
	expiresApprox?: boolean;
	/** RFC 3339 deadline. Every question and permission deadline is an UPPER bound (expiresApprox: true).
	 *  - Question (blocking only): readToolTiming(part).startedAt + 600 s. Core's waiters time out at 600 s
	 *    (ACP elicitation: apps/core/src/sidecar/adapters/acp.rs:4888-4903; ask_user:
	 *    apps/core/src/sidecar/adapters/mcp_bridge.rs:349). The ask_user waiter also releases EARLY whenever
	 *    presence::questions_deferred() turns true, polled every 5 s (mcp_bridge.rs:353, :1286-1295), so
	 *    the real deadline can be sooner.
	 *  - Permission: host first-seen + 600 s (acp.rs:1456-1462). First sighting is later than the real start,
	 *    so this is an upper bound too.
	 *  - Approval: `expires_at` is passed through only when present; Core does not currently set it
	 *    (apps/core/src/approvals/mod.rs:273).
	 *  The host drops a blocking question or permission ask once nowMs passes expiresAt (the waiter is gone). */
	expiresAt?: string | null;
	/** A live run is actually waiting on this ask: permission, blocking question, input, workflow_gate.
	 *  False for tool_call approvals. Core queues them and returns an error to the agent at once, and the
	 *  turn carries on or ends (apps/core/src/approvals/mod.rs:1082-1093). Also false for scheduled_run /
	 *  trigger_run, which start no run until approved (apps/core/src/scheduler/mod.rs:241-276). */
	holdsRun?: boolean;
	/** Stable: "approval:<id>" | "question:<toolCallId>" | "permission:<requestId>" | "input:<threadId>" | "reply:<threadId>". */
	id: string;
	kind: InterfaceAskKind;
	/** At most 160 chars: why (approval summary, question description, heal_fix diagnosis). Null when redacted. */
	reason?: string | null;
	/** Core risk tags, verbatim (classify_risk verbs, agent-configuration, *-mutation, manual-mode,
	 *  or provenance tags such as "scheduled"). Display with riskTagLabel(); never match against a fixed vocabulary. */
	riskTags?: string[];
	/** RFC 3339 start of the wait. Null when the source has no time and the host never saw it start. */
	since: string | null;
	/** True when `since` is an approximation (host first sighting, or a reply's lastMessageAt). Draw "~". */
	sinceApprox?: boolean;
	source: InterfaceDetailSource;
	/** Approval kind, or the tool kind for a permission ("edit", "execute"). */
	subject?: string | null;
	/** Short target for the bubble, at most 40 chars:
	 *  - tool_call approval: derived from action.arguments by approvalToAsk (§3.2): the first two tokens of a
	 *    `command` / `cmd` string, the basename of `file_path` / `path` / `notebook_path`, or the host of `url`;
	 *    null when none of these is a string. The full arguments object is never exposed.
	 *  - permission: basename of locations[0].path.
	 *  Null when redacted. */
	target?: string | null;
	/** At most 80 chars: the ask itself, verbatim from the source where it has one
	 *  (a tool_call approval reads Core's question, "Can I run `shell.run` now?", apps/core/src/approvals/mod.rs:310-321).
	 *  Under privacy "redacted": kind words only. */
	text: string;
	/** Snapshot thread. A session-thread ask is lifted to its parent main thread.
	 *  threadId and agentId are both null only for workflow-level asks
	 *  (workflow_gate, heal_workflow rerun, workflow-target scheduled_run / trigger_run). */
	threadId: string | null;
}

// ── Activity: what a thread is doing right now ───────────────────────────
export type InterfaceActivityKind =
	| "read"
	| "edit"
	| "write"
	| "run"
	| "search"
	| "web"
	| "think"
	| "plan"
	| "delegate"
	| "ask"
	| "answer"
	| "tool";

export interface InterfaceActivity {
	kind: InterfaceActivityKind;
	/** At most 40 chars: "Editing snapshot.ts", "Running bun test", "Writing the answer". Never raw JSON.
	 *  Under privacy "redacted": the verb only ("Editing", "Running"). */
	label: string;
	observedAt: string;
	/** Kinds of the 5 most recent completed steps in this turn, oldest first. */
	recent?: InterfaceActivityKind[];
	/** RFC 3339 start of the current tool call (callProviderMetadata.ryu.startedAt). */
	since?: string | null;
	source: InterfaceDetailSource;
	/** File basename, first two tokens of a command, search pattern, or URL host. Null when redacted. */
	target?: string | null;
	/** Canonical tool name ("Edit", "Bash", "mcp__github__create_pull_request"). */
	tool?: string | null;
}

export interface InterfaceProgress {
	/** In-progress plan item, or the running workflow node. Null when redacted. */
	current?: string | null;
	done: number;
	/** plan = TodoWrite / ACP plan; workflow = data-ryu-workflow nodes;
	 *  estimate = (now - routineRun.firedAt) vs medianRunMs of ONE routine (only when thread.routineRun is set).
	 *  For an estimate, `done` and `total` are milliseconds (elapsed, capped, and the routine's median). */
	kind: "plan" | "workflow" | "estimate";
	/** First pending plan item: the honest "what's next". Null when redacted. */
	next?: string | null;
	source: InterfaceDetailSource;
	total: number;
}

export type InterfaceBlockerKind =
	| "error" // saved {type:"error",code,title,message} part with any code not mapped below, runState failed with no detail, or a live useChat error
	| "billing" // saved error code insufficient_credits / provider_payment_required / provider_usage_unavailable. Never has clearsAt.
	| "interrupted" // runState interrupted / Message.interrupted / saved code execution_paused (boot reconcile or Kill Switch; indistinguishable)
	| "command-failed" // last failed shell command in the last finished turn
	| "tool-failed" // last tool part in output-error
	| "rate-limited" // 1b: inferred from agent.limit (source "estimate"), clearsAt=resetsAt; 1c: live failover verdict wait / held / no_candidate
	| "auth" // saved error code auth_required / native_account_required / pi_account_required, or data-ryu-acp-auth-required (live)
	| "schedule-failed"; // a routine thread (persistent, or a linked per-firing agentrun_* thread): the job's newest past event failed

export interface InterfaceBlocker {
	/** RFC 3339 time of the failure, or null when unknown. NEVER conversation.updatedAt or a snapshot frame's
	 *  updated_at: both move with rename, pin, archive, folder, participants and similar writes
	 *  (apps/core/src/server/conversations.rs:2608, :2642, :2900, :2912, :2936, :6336), and an interrupted
	 *  status is written without touching updated_at (boot reconcile, conversations.rs:1240; Kill Switch,
	 *  :2487-2500).
	 *  - Summary failed: runEndedAt (exact), else null.
	 *  - Summary interrupted: the receipt time (Date.now()) of the frame that turned an id this session saw
	 *    running into interrupted, with atApprox: true; else null.
	 *  - 1b detail: the failing tool part's readToolTiming completedAt (exact), else the containing message's
	 *    timestamp with atApprox: true.
	 *  - schedule-failed: the event's end (exact). */
	at?: string | null;
	atApprox?: boolean;
	/** RFC 3339 time it clears by itself (usage resetsAt, live failover resets_at for THIS agent). */
	clearsAt?: string | null;
	/** At most 160 chars: error message, failed command, failover note. Null when redacted. */
	detail?: string | null;
	kind: InterfaceBlockerKind;
	/** "estimate" marks an inferred blocker (the limit-precedence rule, §3.2); renderers word it as likely. */
	source: InterfaceDetailSource;
	/** At most 40 chars: "Agent login expired", "Tests failed", "Plan limit hit". Under redaction: the kind word. */
	title: string;
}

export interface InterfaceOutcome {
	artifacts?: number;
	deletions?: number;
	/** Failed tool calls in that turn (Σ turn.tools[].failures). A failed shell command is one of them. */
	failures?: number;
	/** The following counts describe that turn only. Each is absent when the turn is not fully
	 *  inside the loaded message page. */
	filesChanged?: number;
	finishedAt?: string | null;
	/** Headline of the last FINISHED MissionTurn (status ok or failed): "Edited 3 files, ran 2 commands",
	 *  or "Answered". Null when redacted. */
	headline: string | null;
	insertions?: number;
	source: InterfaceDetailSource;
	/** First sentence of that turn's closing prose, at most 160 chars. Null when redacted. */
	summary?: string | null;
}

/** Spawned session threads (subagents), rolled up onto their parent main thread. */
export interface InterfaceHelpers {
	done: number;
	failed: number;
	running: number;
	/** Up to 3 running helper titles, newest first. Empty when redacted. */
	titles: string[];
}

/** An agent's subscription window, when the host has polled it. */
export interface InterfaceAgentLimit {
	blocked: boolean;
	/** Names the chosen window: the vendor's window label ("Weekly", "5h", "Opus"), plus " (<model>)" only
	 *  when the window's model differs from its label ("Spark weekly (GPT-5.3-Codex-Spark)"). */
	label: string;
	/** The window's model; null = account-wide. */
	model: string | null;
	resetsAt: string | null;
	usedPercent: number;
	/** The window's length in seconds, when the vendor reports it. */
	windowSeconds?: number | null;
}

export interface InterfaceAgent {
	avatarUrl: string | null;
	description: string;
	/** Host-chosen thread this agent is "about" now (agentActs priority, deduped across shared team threads). */
	focusThreadId?: string | null;
	id: string;
	/** Subscription window, when the host has polled it. undefined = never polled (unknown);
	 *  null = usage unknown: probe throttled or errored (reason rate_limited / error), or an at-100% per-model
	 *  window exists that the host cannot match to this agent (agent.model null). */
	limit?: InterfaceAgentLimit | null;
	model?: string | null;
	name: string;
	/** `working` while any of this agent's threads has a live run (including lifted helpers). */
	status: "idle" | "working";
}

export interface InterfaceThread {
	activity?: InterfaceActivity | null;
	agentIds: string[];
	/** Core run_status is awaiting_input. `running` stays false for it.
	 *  Never set by the desktop host until Phase 2(a): Core's conversations.run_status is only
	 *  running/completed/failed/interrupted (apps/core/src/server/conversations.rs:693); workflow
	 *  awaiting_input travels in the ryu-workflow frame, not /api/runs/stream. */
	awaitingInput?: boolean;
	blocker?: InterfaceBlocker | null;
	/** "summary" = list fields only; "detail" = the host read this thread's messages.
	 *  Under "summary", an absent activity/blocker/progress, or the absence of a question ask, means UNKNOWN, not none. */
	detail?: "summary" | "detail";
	helpers?: InterfaceHelpers | null;
	id: string;
	/** One flattened line of the newest message, when the host has it. */
	lastMessage: string | null;
	/** RFC 3339 created_at of the newest user/assistant message (preview-backed).
	 *  This is when that message STARTED. Core inserts the assistant row on the first text chunk or
	 *  checkpoint, and later content updates leave created_at as it is (apps/core/src/server/conversations.rs:4046-4048,
	 *  :3770-3778). It is NOT when the answer finished. */
	lastMessageAt?: string | null;
	lastMessageRole: "assistant" | "user" | null;
	/** RFC 3339 time the host last saw this RUNNING thread make progress: the newest saved part timing or
	 *  message timestamp (1b), or the newest live step (1c); runStartedAt when nothing has been saved since.
	 *  Absent under detail:"summary" (unknown). Feeds `stalled` only; never displayed as a clock time. */
	lastProgressAt?: string | null;
	messageCount: number;
	outcome?: InterfaceOutcome | null;
	pinned: boolean;
	progress?: InterfaceProgress | null;
	projectId: string | null;
	/** The CRON routine firing this run, set by the host only when the run demonstrably started at that
	 *  routine's fire time (§3.2). Absent for interactive turns in a routine's chat and for interval routines. */
	routineRun?: { jobId: string; firedAt: string } | null;
	/** RFC 3339 EXACT time the last run completed or failed. Set only from a `type:"run"` delta frame with
	 *  status completed or failed, for an id this session already saw as running; the value is that frame's
	 *  updated_at, which set_run_status writes as the completion time (conversations.rs:2395-2401).
	 *  Snapshot frames (the opening /api/runs/stream snapshot and every reconnect replay every conversation
	 *  with a non-null run_status, conversations.rs:3879-3912) never set it. Interrupted never sets it.
	 *  Null otherwise. */
	runEndedAt?: string | null;
	running: boolean;
	/** True when runStartedAt is only the first time the host saw "running" for this run (a lower bound). */
	runStartedApprox?: boolean;
	/** RFC 3339 start of the CURRENT run (reset on every new run, §3.1). */
	runStartedAt?: string | null;
	/**
	 * The host's last run outcome when it knows one. Optional so older hosts
	 * (and v1 snapshots) stay valid; `running` remains the live-run flag.
	 */
	runState?: ThreadRunState | null;
	teamId: string | null;
	title: string;
	/** Unread messages since the user last opened it (0 = seen). */
	unread?: number;
	/** RFC 3339 UTC timestamp of the latest activity (the sort key). */
	updatedAt: string;
	/** "<folder basename>@<branch>" when the run has a workspace. Null when redacted. */
	workspace?: string | null;
}

export type ThreadRunState = "completed" | "failed" | "interrupted" | "running";

export interface InterfaceGroup {
	id: string;
	kind: "project" | "team";
	memberAgentIds: string[];
	name: string;
}

/**
 * A scheduled agent or workflow run: a past execution or a projected one.
 * Hosts that run schedules (Ryu's routines) fill `events`; others omit it.
 */
export interface InterfaceEvent {
	/** The agent the run targets, when it targets one. */
	agentId: string | null;
	/**
	 * When set, this event stands for this many runs on the same day, for a
	 * schedule that fires too often to show one by one.
	 */
	count?: number | null;
	/** RFC 3339 UTC end of a past run, when known. */
	end?: string | null;
	/** Failure text of a past run (ExecRecord.error). Null when redacted. */
	error?: string | null;
	id: string;
	/** Routine (ScheduledJob) id, so per-routine medians and blockers never pool different routines. */
	jobId?: string | null;
	kind: "past" | "upcoming";
	/** A human schedule phrase, e.g. "Daily at 9 AM". */
	label: string | null;
	/** Outcome of a past run. */
	outcome?: "failure" | "success" | null;
	/** The routine waits for approval before it runs (ScheduledJob.require_approval). */
	requiresApproval?: boolean;
	/** RFC 3339 UTC start (past) or projected start (upcoming). */
	start: string;
	/** Thread the run belongs to, when it is a snapshot thread:
	 *  - persistent routine (agent target with `target.conversationId`): that id, for every past and
	 *    upcoming event, success or failure;
	 *  - per-firing routine, successful run: `ExecRecord.runId` (the `agentrun_<uuid>` conversation);
	 *  - per-firing routine, failed run: Core records run_id None (apps/core/src/scheduler/mod.rs:326-332),
	 *    but the `agentrun_<uuid>` conversation was already created before the turn
	 *    (apps/core/src/sidecar/agent_runner.rs:151-168; scheduler/mod.rs:494-522), and a failing turn writes
	 *    run_status failed to it (apps/core/src/sidecar/adapters/mod.rs:12641). The host links it by the
	 *    orphan-match rule in §3.2;
	 *  - workflow jobs: null. */
	threadId?: string | null;
	/** The routine's name. */
	title: string;
}

/** One movement on the account: spend (negative) or credit (positive). */
export interface InterfaceAccountTransaction {
	/** Signed amount in micro-units of the account currency (1e6 = 1 unit). */
	amount: number;
	/** RFC 3339 UTC time of the transaction. */
	at: string;
	/** Balance after this transaction, in micro-units, when known. */
	balanceAfter: number | null;
	id: string;
	inputTokens: number | null;
	kind: "credit" | "debit";
	/** What the transaction was for, in plain words. */
	label: string;
	model: string | null;
	outputTokens: number | null;
	provider: string | null;
	/** The snapshot thread this spend belongs to, when the host can tell. */
	threadId: string | null;
}

/**
 * The user's usage account: what is left to spend and recent movements.
 * Hosts with a billing wallet fill it; others omit it.
 */
export interface InterfaceAccount {
	/** Spendable balance in micro-units, or null when unknown. */
	balance: number | null;
	/** Where the balance comes from, in micro-units, when the host knows. */
	breakdown: {
		gift: number | null;
		plan: number | null;
		topup: number | null;
	} | null;
	/** ISO 4217 code, lower case (e.g. "usd"). */
	currency: string;
	/** Newest first. */
	transactions: InterfaceAccountTransaction[];
}

export interface InterfaceSnapshot {
	/**
	 * The usage account. Optional and additive: only hosts with a wallet fill
	 * it, and only for interfaces that show it.
	 */
	account?: InterfaceAccount;
	agents: InterfaceAgent[];
	/** Ask kinds this host cannot see for every thread. Desktop 1a: ["permission", "input", "question"];
	 *  1b drops "question" only under the coverage rule in §3.2 (running mains AND running helpers hydrated,
	 *  and the idle-thread sweep complete). */
	askBlindSpots?: InterfaceAskKind[];
	/** Everything waiting on the user, in compareAsks order. Omitted = the host has no ask sources.
	 *  Empty = the host looked and found nothing, EXCEPT for kinds in askBlindSpots. */
	asks?: InterfaceAsk[];
	/**
	 * Scheduled runs around now, oldest first. Optional and additive: a host
	 * without schedules (or a v1 snapshot) omits it, and renderers treat that
	 * as "no schedules".
	 */
	events?: InterfaceEvent[];
	groups: InterfaceGroup[];
	/** Host clock when built (RFC 3339). Renderers use it as "now" for data, plus their own 1 s tick for ages. */
	observedAt?: string;
	/** "redacted": the host has already removed message text, titles, names of routines, groups and
	 *  ledger tasks, descriptions and targets from this snapshot. Renderers show what they receive, and the
	 *  ask card offers Open only. */
	privacy?: "full" | "redacted";
	threads: InterfaceThread[];
	version: typeof INTERFACE_PROTOCOL_VERSION;
}

/**
 * The write side. A host implements it over its real chat engine; interfaces
 * never send through a second path.
 */
export interface InterfacePort {
	/** Answer an ask in place. Optional. Called only from the shared ask card, after its confirm step for
	 *  destructive choices, and never while privacy is "redacted". Without it the ask card shows Open only. */
	answerAsk?: (askId: string, choiceId: string) => Promise<void>;
	/** Leave the open thread and return to the interface's overview. */
	closeThread: () => void;
	/** Open the host's approvals inbox. Used by the ask card's Open when ask.threadId is null.
	 *  Optional: without it, an unowned ask's card has no Open button. */
	openInbox?: () => void;
	/** Show an existing thread in the canonical conversation surface. */
	openThread: (threadId: string) => void;
	/**
	 * Forget the user's settings for this interface, so its own defaults (and
	 * the params its contribution sets) apply again, as Settings → Appearance's
	 * reset does. The host re-renders the interface with the new params.
	 * Optional: without it a renderer's "restore defaults" saves its own
	 * defaults through `updateSettings` instead.
	 */
	resetSettings?: () => void;
	/**
	 * Start a new thread. A `prompt` is sent immediately, so only pass one that
	 * the user typed and submitted in the interface itself.
	 */
	startThread: (input: {
		agentId?: string;
		/** File the new thread under this project ({@link InterfaceGroup} id). */
		projectId?: string;
		prompt?: string;
		teamId?: string;
	}) => void;
	/**
	 * Save some of this interface's settings (keys of `interfaceSettingsFor`),
	 * as the user's own: a renderer's in-view toggle calls it so the choice
	 * persists and shows in Settings. The host re-renders the interface with
	 * the new params. Optional: without it a renderer keeps such a toggle in
	 * local state, as before.
	 */
	updateSettings?: (patch: Record<string, InterfaceSettingValue>) => void;
}

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

// ---------------------------------------------------------------------------
// Channels projection (Slack / Discord style)
// ---------------------------------------------------------------------------

export interface InterfaceChannel {
	agentIds: string[];
	id: string;
	kind: "agent" | "general" | "project" | "team";
	lastActivityAt: string | null;
	name: string;
	running: boolean;
	threadIds: string[];
}

export interface InterfaceChannelSection {
	channels: InterfaceChannel[];
	id: "channels" | "direct";
	label: string;
}

/** Lowercase, hyphenated channel handle (`#design-review`). */
export function channelHandle(name: string): string {
	const handle = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return handle || "channel";
}

function channelKeyFor(
	thread: InterfaceThread,
	params: ChannelsParams
): string {
	if (thread.teamId) {
		return `team:${thread.teamId}`;
	}
	if (params.groupBy === "project" && thread.projectId) {
		return `project:${thread.projectId}`;
	}
	const [agentId] = thread.agentIds;
	return agentId ? `agent:${agentId}` : "general";
}

/**
 * Group threads into channels: teams and projects are `#channels`, agents are
 * direct messages, and anything without an owner lands in `#general`. Every
 * agent gets a DM even with no threads yet, so it can be messaged.
 */
export function projectChannels(
	snapshot: InterfaceSnapshot,
	params: ChannelsParams
): InterfaceChannelSection[] {
	const channels = new Map<string, InterfaceChannel>();
	const ensure = (
		id: string,
		init: Omit<
			InterfaceChannel,
			"id" | "lastActivityAt" | "running" | "threadIds"
		>
	): InterfaceChannel => {
		const existing = channels.get(id);
		if (existing) {
			return existing;
		}
		const created: InterfaceChannel = {
			...init,
			id,
			lastActivityAt: null,
			running: false,
			threadIds: [],
		};
		channels.set(id, created);
		return created;
	};

	for (const agent of snapshot.agents) {
		ensure(`agent:${agent.id}`, {
			agentIds: [agent.id],
			kind: "agent",
			name: agent.name,
		});
	}
	for (const group of snapshot.groups) {
		if (group.kind === "team" || params.groupBy === "project") {
			ensure(`${group.kind}:${group.id}`, {
				agentIds: group.memberAgentIds,
				kind: group.kind,
				name: group.name,
			});
		}
	}

	for (const thread of [...snapshot.threads].sort(byRecency)) {
		const key = channelKeyFor(thread, params);
		const [kind, ...rest] = key.split(":");
		const refId = rest.join(":");
		const channel = ensure(key, {
			agentIds: thread.agentIds,
			kind:
				kind === "team" || kind === "project" || kind === "agent"
					? kind
					: "general",
			name: key === "general" ? "general" : refId,
		});
		channel.threadIds.push(thread.id);
		channel.running ||= thread.running;
		channel.lastActivityAt ??= thread.updatedAt;
	}

	const sorted = [...channels.values()].sort(
		(a, b) =>
			(b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") ||
			a.name.localeCompare(b.name)
	);
	return [
		{
			channels: sorted.filter((channel) => channel.kind !== "agent"),
			id: "channels",
			label: "Channels",
		},
		{
			channels: sorted.filter((channel) => channel.kind === "agent"),
			id: "direct",
			label: "Direct messages",
		},
	];
}

// ---------------------------------------------------------------------------
// Feed projection (X / social timeline style)
// ---------------------------------------------------------------------------

/** Post body length, matching the familiar short-post limit. */
export const FEED_EXCERPT_LIMIT = 280;

export interface FeedPost {
	authorAgentId: string | null;
	excerpt: string;
	pinned: boolean;
	/** Messages after the opening one: the thread's replies. */
	replyCount: number;
	running: boolean;
	threadId: string;
	title: string;
	updatedAt: string;
}

function excerpt(text: string | null): string {
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > FEED_EXCERPT_LIMIT
		? `${flat.slice(0, FEED_EXCERPT_LIMIT - 1).trimEnd()}…`
		: flat;
}

/** Every thread becomes a post; its conversation is the reply chain. */
export function projectFeed(
	snapshot: InterfaceSnapshot,
	params: FeedParams
): FeedPost[] {
	return [...snapshot.threads]
		.sort(
			(a, b) =>
				Number(b.pinned) - Number(a.pinned) ||
				(params.order === "active"
					? Number(b.running) - Number(a.running)
					: 0) ||
				byRecency(a, b)
		)
		.map((thread) => ({
			authorAgentId: thread.agentIds[0] ?? null,
			excerpt: excerpt(thread.lastMessage),
			pinned: thread.pinned,
			replyCount: Math.max(0, thread.messageCount - 1),
			running: thread.running,
			threadId: thread.id,
			title: thread.title,
			updatedAt: thread.updatedAt,
		}));
}

// ---------------------------------------------------------------------------
// World projection (2D and 3D game worlds share one layout)
// ---------------------------------------------------------------------------

export interface WorldPoint {
	x: number;
	y: number;
}

export interface WorldEntity extends WorldPoint {
	agentId: string;
	name: string;
	status: InterfaceAgent["status"];
	threadCount: number;
}

export interface WorldLayout {
	entities: WorldEntity[];
	height: number;
	spawn: WorldPoint;
	width: number;
}

const WORLD_SPACING = 4;
const WORLD_MARGIN = 3;
const WORLD_MIN_SIZE = 13;
/** Agents beyond this are left out of the world rather than crowding it. */
export const MAX_WORLD_ENTITIES = 64;

/**
 * Place agents on a tile grid, ordered by name. Placement depends only on who
 * the agents are, never on their live status or activity, so an agent keeps
 * its spot while it works and the 2D and 3D worlds (and every reload) agree on
 * where each agent stands.
 */
export function layoutWorld(snapshot: InterfaceSnapshot): WorldLayout {
	const threadCounts = new Map<string, number>();
	for (const thread of snapshot.threads) {
		for (const agentId of thread.agentIds) {
			threadCounts.set(agentId, (threadCounts.get(agentId) ?? 0) + 1);
		}
	}
	const agents = [...snapshot.agents]
		.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
		.slice(0, MAX_WORLD_ENTITIES);
	const perRow = Math.max(1, Math.ceil(Math.sqrt(agents.length)));
	const rows = Math.max(1, Math.ceil(agents.length / perRow));
	const width = Math.max(
		WORLD_MIN_SIZE,
		WORLD_MARGIN * 2 + (perRow - 1) * WORLD_SPACING + 1
	);
	// Two extra rows leave a plaza in front of the agents for the player.
	const height = Math.max(
		WORLD_MIN_SIZE,
		WORLD_MARGIN * 2 + (rows - 1) * WORLD_SPACING + 3
	);
	const offsetX = Math.floor((width - ((perRow - 1) * WORLD_SPACING + 1)) / 2);
	const entities = agents.map((agent, index) => ({
		agentId: agent.id,
		name: agent.name,
		status: agent.status,
		threadCount: threadCounts.get(agent.id) ?? 0,
		x: offsetX + (index % perRow) * WORLD_SPACING,
		y: WORLD_MARGIN + Math.floor(index / perRow) * WORLD_SPACING,
	}));
	return {
		entities,
		height,
		spawn: { x: Math.floor(width / 2), y: height - 2 },
		width,
	};
}

/** The entity within `radius` tiles (Chebyshev) of `point`, nearest first. */
export function nearestWorldEntity(
	layout: WorldLayout,
	point: WorldPoint,
	radius = 1
): WorldEntity | null {
	let best: WorldEntity | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const entity of layout.entities) {
		const distance = Math.max(
			Math.abs(entity.x - point.x),
			Math.abs(entity.y - point.y)
		);
		if (distance <= radius && distance < bestDistance) {
			best = entity;
			bestDistance = distance;
		}
	}
	return best;
}

export type WorldDirection = "down" | "left" | "right" | "up";

const STEP: Record<WorldDirection, WorldPoint> = {
	down: { x: 0, y: 1 },
	left: { x: -1, y: 0 },
	right: { x: 1, y: 0 },
	up: { x: 0, y: -1 },
};

/**
 * Move one tile. The world edge and agents' tiles block movement, so the
 * player walks up to an agent rather than through it.
 */
export function stepWorldPlayer(
	layout: WorldLayout,
	from: WorldPoint,
	direction: WorldDirection
): WorldPoint {
	const next = { x: from.x + STEP[direction].x, y: from.y + STEP[direction].y };
	return isWorldTileFree(layout, next) ? next : from;
}

/** Inside the world and not an agent's tile. */
export function isWorldTileFree(
	layout: WorldLayout,
	point: WorldPoint
): boolean {
	const inside =
		point.x >= 0 &&
		point.y >= 0 &&
		point.x < layout.width &&
		point.y < layout.height;
	return (
		inside &&
		!layout.entities.some(
			(entity) => entity.x === point.x && entity.y === point.y
		)
	);
}

// ---------------------------------------------------------------------------
// Thread status: one classification shared by Board, Inbox, Arena, Messenger
// ---------------------------------------------------------------------------

/**
 * Where a thread stands from the user's point of view, most urgent first:
 * - `attention`: the last run failed or was interrupted;
 * - `your-turn`: an agent replied last and nothing is running;
 * - `working`: a run is live;
 * - `waiting`: you wrote last and no run is live yet;
 * - `quiet`: nothing has been said.
 */
export type ThreadStatus =
	| "attention"
	| "quiet"
	| "waiting"
	| "working"
	| "your-turn";

export const THREAD_STATUS_ORDER: readonly ThreadStatus[] = [
	"attention",
	"your-turn",
	"working",
	"waiting",
	"quiet",
];

export const THREAD_STATUS_LABELS: Record<ThreadStatus, string> = {
	attention: "Needs attention",
	quiet: "Not started",
	waiting: "Waiting on agent",
	working: "Working",
	"your-turn": "Your turn",
};

export function threadStatus(thread: InterfaceThread): ThreadStatus {
	if (thread.running) {
		return "working";
	}
	// Core run_status awaiting_input (Phase 2(a)); older hosts never send it.
	if (thread.awaitingInput === true) {
		return "your-turn";
	}
	if (thread.runState === "failed" || thread.runState === "interrupted") {
		return "attention";
	}
	if (thread.lastMessageRole === "assistant") {
		return "your-turn";
	}
	if (thread.lastMessageRole === "user") {
		return "waiting";
	}
	return "quiet";
}

function pinnedThenRecent(a: InterfaceThread, b: InterfaceThread): number {
	return Number(b.pinned) - Number(a.pinned) || byRecency(a, b);
}

/** Agent ids normalized for `@handle` lookups: lowercase, letters and digits. */
function handleKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Longest `@handle` an interface displays for an agent name. */
export const AGENT_HANDLE_MAX_LENGTH = 24;

/** The handle shown for a name with no ASCII letters or digits. */
export const FALLBACK_AGENT_HANDLE = "agent";

/**
 * The handle text interfaces display for an agent name (without the `@`):
 * the normalized name, capped at {@link AGENT_HANDLE_MAX_LENGTH}, or
 * {@link FALLBACK_AGENT_HANDLE} when nothing survives normalization.
 * {@link resolveAgentHandle} accepts every value this returns.
 */
export function agentHandleText(name: string): string {
	return (
		handleKey(name).slice(0, AGENT_HANDLE_MAX_LENGTH) || FALLBACK_AGENT_HANDLE
	);
}

/**
 * Find an agent by `@handle`, name, or id (case and punctuation insensitive).
 * The displayed (possibly truncated, possibly fallback) handle from
 * {@link agentHandleText} resolves too, so every handle an interface shows or
 * tab-completes round-trips; an exact name or id still wins over a prefix.
 */
export function resolveAgentHandle(
	snapshot: InterfaceSnapshot,
	handle: string
): InterfaceAgent | undefined {
	const key = handleKey(handle.replace(/^@/, ""));
	if (!key) {
		return undefined;
	}
	return (
		snapshot.agents.find((agent) => handleKey(agent.name) === key) ??
		snapshot.agents.find((agent) => handleKey(agent.id) === key) ??
		snapshot.agents.find((agent) => agentHandleText(agent.name) === key)
	);
}

// ---------------------------------------------------------------------------
// Board projection (Kanban)
// ---------------------------------------------------------------------------

export interface BoardColumn {
	/** Set when grouping by agent. */
	agentId: string | null;
	/** Set when grouping by project. */
	groupId: string | null;
	id: string;
	label: string;
	/** Set when grouping by status. */
	status: ThreadStatus | null;
	threadIds: string[];
}

/**
 * Narrow the board to matching threads. Each field is a set of accepted
 * values (empty means "any"); a thread must match every non-empty field.
 */
export interface BoardFilter {
	/** Threads with any of these agents. */
	agentIds: readonly string[];
	/** Threads in any of these teams or projects. */
	groupIds: readonly string[];
	statuses: readonly ThreadStatus[];
}

export const EMPTY_BOARD_FILTER: BoardFilter = {
	agentIds: [],
	groupIds: [],
	statuses: [],
};

export function isBoardFilterEmpty(filter: BoardFilter): boolean {
	return (
		filter.agentIds.length === 0 &&
		filter.groupIds.length === 0 &&
		filter.statuses.length === 0
	);
}

/** Whether a thread passes a {@link BoardFilter}. */
export function matchesBoardFilter(
	thread: InterfaceThread,
	filter: BoardFilter
): boolean {
	if (
		filter.statuses.length > 0 &&
		!filter.statuses.includes(threadStatus(thread))
	) {
		return false;
	}
	if (
		filter.agentIds.length > 0 &&
		!thread.agentIds.some((id) => filter.agentIds.includes(id))
	) {
		return false;
	}
	if (filter.groupIds.length > 0) {
		const inGroup = [thread.projectId, thread.teamId].some(
			(id) => id !== null && filter.groupIds.includes(id)
		);
		if (!inGroup) {
			return false;
		}
	}
	return true;
}

function byNameThenId(
	a: { id: string; name: string },
	b: { id: string; name: string }
): number {
	return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

function emptyColumn(
	id: string,
	label: string,
	keys: Partial<Pick<BoardColumn, "agentId" | "groupId" | "status">>
): BoardColumn {
	return {
		agentId: keys.agentId ?? null,
		groupId: keys.groupId ?? null,
		id,
		label,
		status: keys.status ?? null,
		threadIds: [],
	};
}

/**
 * File threads into keyed columns, with a trailing catch-all column that is
 * kept only when something lands in it.
 */
function fileByKey(
	threads: InterfaceThread[],
	columns: BoardColumn[],
	keyOf: (column: BoardColumn) => string | null,
	threadKey: (thread: InterfaceThread) => string | null,
	rest: BoardColumn
): BoardColumn[] {
	const byKey = new Map(columns.map((column) => [keyOf(column), column]));
	for (const thread of threads) {
		const column = byKey.get(threadKey(thread)) ?? rest;
		column.threadIds.push(thread.id);
	}
	return rest.threadIds.length > 0 ? [...columns, rest] : columns;
}

/**
 * Groups of thread cards, used as Kanban columns and as list sections.
 * - By status the groups follow urgency; an empty "Not started" group is
 *   dropped, and a status filter keeps only the statuses it names.
 * - By agent every agent gets a group (so a new thread can be started from
 *   it), plus "Unassigned" when needed.
 * - By project every project gets a group, plus "No project" when needed.
 *
 * Within a group, pinned threads come first, then the most recent.
 */
export function projectBoard(
	snapshot: InterfaceSnapshot,
	params: Pick<BoardParams, "groupBy"> & { filter?: BoardFilter }
): BoardColumn[] {
	const filter = params.filter ?? EMPTY_BOARD_FILTER;
	const threads = snapshot.threads
		.filter((thread) => matchesBoardFilter(thread, filter))
		.sort(pinnedThenRecent);
	if (params.groupBy === "agent") {
		const agents = [...snapshot.agents].sort(byNameThenId);
		return fileByKey(
			threads,
			agents.map((agent) =>
				emptyColumn(`agent:${agent.id}`, agent.name, { agentId: agent.id })
			),
			(column) => column.agentId,
			(thread) => thread.agentIds[0] ?? null,
			emptyColumn("unassigned", "Unassigned", {})
		);
	}
	if (params.groupBy === "project") {
		const projects = snapshot.groups
			.filter((group) => group.kind === "project")
			.sort(byNameThenId);
		return fileByKey(
			threads,
			projects.map((project) =>
				emptyColumn(`project:${project.id}`, project.name, {
					groupId: project.id,
				})
			),
			(column) => column.groupId,
			(thread) => thread.projectId,
			emptyColumn("no-project", "No project", {})
		);
	}
	const columns = THREAD_STATUS_ORDER.map((status) =>
		emptyColumn(`status:${status}`, THREAD_STATUS_LABELS[status], { status })
	);
	for (const thread of threads) {
		const status = threadStatus(thread);
		columns[THREAD_STATUS_ORDER.indexOf(status)]?.threadIds.push(thread.id);
	}
	return columns.filter((column) => {
		if (filter.statuses.length > 0) {
			return column.status !== null && filter.statuses.includes(column.status);
		}
		return column.status !== "quiet" || column.threadIds.length > 0;
	});
}

// ---------------------------------------------------------------------------
// Inbox projection (triage)
// ---------------------------------------------------------------------------

export interface InboxSection {
	id: ThreadStatus;
	label: string;
	threadIds: string[];
}

/** Threads grouped by urgency, most urgent section first; empty ones omitted. */
export function projectInbox(snapshot: InterfaceSnapshot): InboxSection[] {
	return projectBoard(snapshot, { groupBy: "status" })
		.filter((column) => column.status && column.threadIds.length > 0)
		.map((column) => ({
			id: column.status as ThreadStatus,
			label: column.label,
			threadIds: column.threadIds,
		}));
}

// ---------------------------------------------------------------------------
// Graph projection (who works with whom)
// ---------------------------------------------------------------------------

export interface GraphNode {
	id: string;
	kind: "agent" | "project" | "team" | "you";
	label: string;
	/** Agent, team, or project id; null for the "you" hub. */
	refId: string | null;
	status: "idle" | "working";
	threadCount: number;
	x: number;
	y: number;
}

export interface GraphEdge {
	id: string;
	/** `talks`: you ↔ agent; `member`: group → agent; `collaborates`: agent ↔ agent. */
	kind: "collaborates" | "member" | "talks";
	source: string;
	target: string;
	/** Threads behind the edge (at least 1 for talks/collaborates). */
	weight: number;
}

export interface InterfaceGraph {
	edges: GraphEdge[];
	nodes: GraphNode[];
}

/**
 * A radial map: you at the center, agents on an inner ring (by name), teams
 * and projects on an outer ring next to their members. Positions are a pure
 * function of the snapshot so the map never jumps between renders.
 */
export function projectGraph(snapshot: InterfaceSnapshot): InterfaceGraph {
	const agents = [...snapshot.agents].sort(
		(a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
	);
	const threadsByAgent = new Map<string, InterfaceThread[]>();
	for (const thread of snapshot.threads) {
		for (const agentId of thread.agentIds) {
			const list = threadsByAgent.get(agentId) ?? [];
			list.push(thread);
			threadsByAgent.set(agentId, list);
		}
	}
	const innerRadius = Math.max(220, agents.length * 32);
	const angles = new Map<string, number>();
	const nodes: GraphNode[] = [
		{
			id: "you",
			kind: "you",
			label: "You",
			refId: null,
			status: snapshot.agents.some((agent) => agent.status === "working")
				? "working"
				: "idle",
			threadCount: snapshot.threads.length,
			x: 0,
			y: 0,
		},
	];
	const edges: GraphEdge[] = [];
	agents.forEach((agent, index) => {
		const angle =
			(index / Math.max(1, agents.length)) * Math.PI * 2 - Math.PI / 2;
		angles.set(agent.id, angle);
		const threadCount = threadsByAgent.get(agent.id)?.length ?? 0;
		nodes.push({
			id: `agent:${agent.id}`,
			kind: "agent",
			label: agent.name,
			refId: agent.id,
			status: agent.status,
			threadCount,
			x: Math.round(Math.cos(angle) * innerRadius),
			y: Math.round(Math.sin(angle) * innerRadius),
		});
		if (threadCount > 0) {
			edges.push({
				id: `talks:${agent.id}`,
				kind: "talks",
				source: "you",
				target: `agent:${agent.id}`,
				weight: threadCount,
			});
		}
	});

	const outerRadius = innerRadius + 200;
	const groups = [...snapshot.groups].sort(
		(a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
	);
	groups.forEach((group, index) => {
		const members = group.memberAgentIds.filter((id) => angles.has(id));
		const projectAgents =
			group.kind === "project"
				? [
						...new Set(
							snapshot.threads
								.filter((thread) => thread.projectId === group.id)
								.flatMap((thread) => thread.agentIds)
								.filter((id) => angles.has(id))
						),
					]
				: [];
		const linked = [...new Set([...members, ...projectAgents])];
		// Sit next to the members (circular mean); spread unanchored groups evenly.
		const angle =
			linked.length > 0
				? Math.atan2(
						linked.reduce((sum, id) => sum + Math.sin(angles.get(id) ?? 0), 0),
						linked.reduce((sum, id) => sum + Math.cos(angles.get(id) ?? 0), 0)
					) + (index % 2 === 0 ? 0.12 : -0.12)
				: (index / Math.max(1, groups.length)) * Math.PI * 2;
		const nodeId = `${group.kind}:${group.id}`;
		const threadCount = snapshot.threads.filter((thread) =>
			group.kind === "team"
				? thread.teamId === group.id
				: thread.projectId === group.id
		).length;
		nodes.push({
			id: nodeId,
			kind: group.kind,
			label: group.name,
			refId: group.id,
			status: linked.some(
				(id) =>
					snapshot.agents.find((agent) => agent.id === id)?.status === "working"
			)
				? "working"
				: "idle",
			threadCount,
			x: Math.round(Math.cos(angle) * outerRadius),
			y: Math.round(Math.sin(angle) * outerRadius),
		});
		for (const agentId of linked) {
			edges.push({
				id: `member:${nodeId}:${agentId}`,
				kind: "member",
				source: nodeId,
				target: `agent:${agentId}`,
				weight: 1,
			});
		}
	});

	const pairs = new Map<string, number>();
	for (const thread of snapshot.threads) {
		const ids = [...new Set(thread.agentIds)]
			.filter((id) => angles.has(id))
			.sort();
		for (let i = 0; i < ids.length; i++) {
			for (let j = i + 1; j < ids.length; j++) {
				const key = `${ids[i]}|${ids[j]}`;
				pairs.set(key, (pairs.get(key) ?? 0) + 1);
			}
		}
	}
	for (const [key, weight] of [...pairs].sort(([a], [b]) =>
		a.localeCompare(b)
	)) {
		const [a, b] = key.split("|");
		edges.push({
			id: `collaborates:${key}`,
			kind: "collaborates",
			source: `agent:${a}`,
			target: `agent:${b}`,
			weight,
		});
	}
	return { edges, nodes };
}

// ---------------------------------------------------------------------------
// Timeline projection
// ---------------------------------------------------------------------------

export interface TimelineDay {
	/** Local calendar day, `YYYY-MM-DD`. */
	key: string;
	/** Most recent first. */
	threadIds: string[];
}

export interface InterfaceTimeline {
	days: TimelineDay[];
	/** Threads older than the week view (always 0 for the day scale). */
	earlierCount: number;
}

/** Local `YYYY-MM-DD` for a date, in the runtime's time zone. */
export function localDayKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Day scale: every day with activity, newest first. Week scale: the seven
 * days ending today (oldest first, empty days included) plus a count of
 * older threads.
 */
export function projectTimeline(
	snapshot: InterfaceSnapshot,
	params: TimelineParams,
	now: Date
): InterfaceTimeline {
	const byDay = new Map<string, string[]>();
	for (const thread of [...snapshot.threads].sort(byRecency)) {
		const at = new Date(thread.updatedAt);
		if (Number.isNaN(at.getTime())) {
			continue;
		}
		const key = localDayKey(at);
		const list = byDay.get(key) ?? [];
		list.push(thread.id);
		byDay.set(key, list);
	}
	if (params.scale === "day") {
		return {
			days: [...byDay.keys()]
				.sort((a, b) => b.localeCompare(a))
				.map((key) => ({ key, threadIds: byDay.get(key) ?? [] })),
			earlierCount: 0,
		};
	}
	const days: TimelineDay[] = [];
	for (let offset = 6; offset >= 0; offset--) {
		const date = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate() - offset
		);
		const key = localDayKey(date);
		days.push({ key, threadIds: byDay.get(key) ?? [] });
	}
	const shown = new Set(days.map((day) => day.key));
	const earlierCount = [...byDay]
		.filter(([key]) => !shown.has(key) && key < (days[0]?.key ?? ""))
		.reduce((sum, [, ids]) => sum + ids.length, 0);
	return { days, earlierCount };
}

// ---------------------------------------------------------------------------
// Arena projection (live agent wall)
// ---------------------------------------------------------------------------

export interface ArenaCard {
	agentId: string;
	counts: Record<ThreadStatus, number>;
	/** The live thread if one is running, else the most recent one. */
	focusThreadId: string | null;
	lastActivityAt: string | null;
	name: string;
	status: InterfaceAgent["status"];
	threadCount: number;
}

function emptyCounts(): Record<ThreadStatus, number> {
	return { attention: 0, quiet: 0, waiting: 0, working: 0, "your-turn": 0 };
}

/** One card per agent: working first, then those needing you, then by name. */
export function projectArena(snapshot: InterfaceSnapshot): ArenaCard[] {
	const cards = snapshot.agents.map((agent): ArenaCard => {
		const threads = snapshot.threads
			.filter((thread) => thread.agentIds.includes(agent.id))
			.sort(byRecency);
		const counts = emptyCounts();
		for (const thread of threads) {
			counts[threadStatus(thread)] += 1;
		}
		const focus = threads.find((thread) => thread.running) ?? threads[0];
		return {
			agentId: agent.id,
			counts,
			focusThreadId: focus?.id ?? null,
			lastActivityAt: threads[0]?.updatedAt ?? null,
			name: agent.name,
			status: agent.status,
			threadCount: threads.length,
		};
	});
	return cards.sort(
		(a, b) =>
			Number(b.status === "working") - Number(a.status === "working") ||
			b.counts.attention +
				b.counts["your-turn"] -
				(a.counts.attention + a.counts["your-turn"]) ||
			a.name.localeCompare(b.name) ||
			a.agentId.localeCompare(b.agentId)
	);
}

// ---------------------------------------------------------------------------
// Messenger projection (agents as contacts)
// ---------------------------------------------------------------------------

export interface MessengerContact {
	agentId: string;
	lastActivityAt: string | null;
	lastMessage: string | null;
	lastMessageRole: InterfaceThread["lastMessageRole"];
	/** The agent's most recent thread, opened when the contact is selected. */
	lastThreadId: string | null;
	name: string;
	status: InterfaceAgent["status"];
	threadIds: string[];
	/** Threads where the agent replied last and is waiting on you. */
	unread: number;
}

/** Contacts by most recent conversation; agents never messaged go last by name. */
export function projectContacts(
	snapshot: InterfaceSnapshot
): MessengerContact[] {
	return snapshot.agents
		.map((agent): MessengerContact => {
			const threads = snapshot.threads
				.filter((thread) => thread.agentIds.includes(agent.id))
				.sort(byRecency);
			const latest = threads[0];
			return {
				agentId: agent.id,
				lastActivityAt: latest?.updatedAt ?? null,
				lastMessage: latest?.lastMessage ?? null,
				lastMessageRole: latest?.lastMessageRole ?? null,
				lastThreadId: latest?.id ?? null,
				name: agent.name,
				status: agent.status,
				threadIds: threads.map((thread) => thread.id),
				unread: threads.filter((thread) => threadStatus(thread) === "your-turn")
					.length,
			};
		})
		.sort(
			(a, b) =>
				(b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") ||
				a.name.localeCompare(b.name)
		);
}

// ---------------------------------------------------------------------------
// Terminal command language
// ---------------------------------------------------------------------------

export type TerminalCommand =
	| { kind: "agents" }
	| { kind: "clear" }
	| { kind: "close" }
	| { kind: "empty" }
	| { kind: "help" }
	| { filter: ThreadStatus | "all"; kind: "list" }
	| { agentHandle: string | null; kind: "new"; prompt: string }
	| { kind: "open"; target: string }
	| { input: string; kind: "unknown" };

const LIST_FILTERS: Record<string, ThreadStatus | "all"> = {
	all: "all",
	attention: "attention",
	failed: "attention",
	mine: "your-turn",
	quiet: "quiet",
	running: "working",
	turn: "your-turn",
	waiting: "waiting",
	working: "working",
	"your-turn": "your-turn",
};

/** Commands the Terminal interface understands, for `help` output. */
export const TERMINAL_HELP: readonly { usage: string; summary: string }[] = [
	{
		summary: "List threads (all, working, your-turn, waiting, attention)",
		usage: "ls [filter]",
	},
	{ summary: "Open a thread by its list number or id", usage: "open <n|id>" },
	{
		summary: "Start a thread, optionally with an agent",
		usage: "new [@agent] <message>",
	},
	{ summary: "Shorthand for new", usage: "@agent <message>" },
	{ summary: "List agents and what they are doing", usage: "agents" },
	{ summary: "Close the open thread", usage: "close" },
	{ summary: "Clear the screen", usage: "clear" },
	{ summary: "Show this help", usage: "help" },
];

/** Parse one line typed into the Terminal interface. Pure and total. */
export function parseTerminalCommand(input: string): TerminalCommand {
	const line = input.trim();
	if (!line) {
		return { kind: "empty" };
	}
	if (line.startsWith("@")) {
		const [handle = "", ...rest] = line.split(/\s+/);
		return {
			agentHandle: handle.slice(1) || null,
			kind: "new",
			prompt: rest.join(" "),
		};
	}
	const [rawVerb = "", ...args] = line.split(/\s+/);
	const verb = rawVerb.toLowerCase();
	switch (verb) {
		case "help":
		case "?":
			return { kind: "help" };
		case "ls":
		case "list": {
			const filter = LIST_FILTERS[(args[0] ?? "all").toLowerCase()];
			return filter
				? { filter, kind: "list" }
				: { input: line, kind: "unknown" };
		}
		case "agents":
		case "who":
			return { kind: "agents" };
		case "open":
		case "cd":
			return args[0]
				? { kind: "open", target: args[0] }
				: { input: line, kind: "unknown" };
		case "new": {
			const [first, ...rest] = args;
			if (first?.startsWith("@")) {
				return {
					agentHandle: first.slice(1) || null,
					kind: "new",
					prompt: rest.join(" "),
				};
			}
			return { agentHandle: null, kind: "new", prompt: args.join(" ") };
		}
		case "close":
		case "back":
		case "exit":
			return { kind: "close" };
		case "clear":
		case "cls":
			return { kind: "clear" };
		default:
			return { input: line, kind: "unknown" };
	}
}

// ---------------------------------------------------------------------------
// Desk projection (help-desk views: views rail, list, conversation + details)
// ---------------------------------------------------------------------------

export interface DeskView {
	id: string;
	kind: "agent" | "all" | "pinned" | "project" | "status" | "team";
	label: string;
	/** The agent, team, or project the view belongs to. */
	refId: string | null;
	/** Most recent first, pinned first within each view. */
	threadIds: string[];
}

export interface DeskViewSection {
	id: "groups" | "inboxes" | "views";
	label: string;
	views: DeskView[];
}

/**
 * The views rail: shared views (all, needs you, working, waiting, pinned),
 * one inbox per agent, and one view per team and project. Every agent gets
 * an inbox even when it is empty, so it can be messaged from there.
 */
export function projectDeskViews(
	snapshot: InterfaceSnapshot
): DeskViewSection[] {
	const threads = [...snapshot.threads].sort(pinnedThenRecent);
	const ids = (predicate: (thread: InterfaceThread) => boolean) =>
		threads.filter(predicate).map((thread) => thread.id);
	const shared: DeskView[] = [
		{
			id: "all",
			kind: "all",
			label: "All conversations",
			refId: null,
			threadIds: ids(() => true),
		},
		{
			id: "needs-you",
			kind: "status",
			label: "Needs you",
			refId: null,
			threadIds: ids((thread) => {
				const status = threadStatus(thread);
				return status === "attention" || status === "your-turn";
			}),
		},
		{
			id: "working",
			kind: "status",
			label: "Working",
			refId: null,
			threadIds: ids((thread) => threadStatus(thread) === "working"),
		},
		{
			id: "waiting",
			kind: "status",
			label: "Waiting on agent",
			refId: null,
			threadIds: ids((thread) => threadStatus(thread) === "waiting"),
		},
		{
			id: "pinned",
			kind: "pinned",
			label: "Pinned",
			refId: null,
			threadIds: ids((thread) => thread.pinned),
		},
	];
	const inboxes = [...snapshot.agents]
		.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
		.map(
			(agent): DeskView => ({
				id: `agent:${agent.id}`,
				kind: "agent",
				label: agent.name,
				refId: agent.id,
				threadIds: ids((thread) => thread.agentIds.includes(agent.id)),
			})
		);
	const groups = [...snapshot.groups]
		.sort(
			(a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
		)
		.map(
			(group): DeskView => ({
				id: `${group.kind}:${group.id}`,
				kind: group.kind,
				label: group.name,
				refId: group.id,
				threadIds: ids((thread) =>
					group.kind === "team"
						? thread.teamId === group.id
						: thread.projectId === group.id
				),
			})
		);
	const sections: DeskViewSection[] = [
		{ id: "views", label: "Views", views: shared },
		{ id: "inboxes", label: "Agent inboxes", views: inboxes },
	];
	if (groups.length > 0) {
		sections.push({ id: "groups", label: "Teams & projects", views: groups });
	}
	return sections;
}

// ---------------------------------------------------------------------------
// Useful state: shared pure helpers (acts, ordering, wording, timing)
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A blocker counts (alarm, "failed") when it is this recent, or its thread is unread. */
const COUNTED_BLOCKER_MS = DAY_MS;
/** A reply older than this does not walk to the tray; it waits as an unread mark. */
const DELIVER_WALK_MS = DAY_MS;
/** A hydrated running thread with no progress for this long reads as stalled. */
const STALLED_MS = 10 * MINUTE_MS;
/** An ask with this little time left is "expiring". */
const EXPIRING_MS = 2 * MINUTE_MS;
const FRESH_MS = 5 * MINUTE_MS;
const ESTIMATE_CAP = 0.94;
const MAX_ARIA_RISK_TAGS = 2;
const DEFAULT_SHORT_LINE_WORDS = 5;
const WORKING_TITLE_WORDS = 2;

export type InterfaceAct =
	| "asking" // carries a blocking ask that holdsRun, or any blocking ask while the agent has no running thread → walks to the you-spot
	| "working" // a running thread (including lifted helpers); blocking asks it does not carry are "parked" (see agentActs)
	| "blocked" // focus counted blocker: error / billing / command-failed / tool-failed / auth / interrupted / schedule-failed
	| "limited" // agent.limit.blocked, or a counted rate-limited blocker (clearsAt when known)
	| "delivering" // an unread reply ask (≤ 24 h) → one walk; the item is that thread's single deliverable
	| "waiting" // the user spoke last and nothing is running ("Sent, not picked up")
	| "idle";

/** Non-blocking asks other than replies: async/deferred question, heal_fix, skill_synthesis. */
export function isSuggestion(ask: InterfaceAsk): boolean {
	return !ask.blocking && ask.kind !== "reply";
}

export interface InterfaceAgentAct {
	act: InterfaceAct;
	agentId: string;
	/** InterfaceAgent.name, for ordering and labels. */
	agentName: string;
	/** Full accessible sentence built by the template table below. Used for agent rows and plates only;
	 *  ask controls use askAriaLabel, blocker controls use blockerAriaLabel. */
	ariaLabel: string;
	ask: InterfaceAsk | null; // the ask this villager carries (asking / delivering)
	/** Counted blockers of this agent, newest `at` first (null `at` last). The focus one is first when act is blocked/limited.
	 *  The objects are the threads' own `blocker` references, so `thread.blocker === blocker` finds the thread. */
	blockers: InterfaceBlocker[];
	bubble: {
		text: string;
		tone: "ask" | "error" | "limit" | "work" | "done" | "wait";
		partial: boolean;
	} | null;
	carry: InterfaceActivityKind | "approval" | "question" | "deliverable" | null;
	/** waitLabel(runStartedAt) for a working act whose runStartedApprox !== true; null otherwise (a first-seen time is only a lower bound). */
	elapsed: string | null;
	helpers: InterfaceHelpers | null;
	longerThanUsual: boolean; // running > 2× the routine's medianRunMs, only when thread.routineRun is set
	next: string | null; // "Next: write tests" | "Next run tomorrow 09:00" | null (never invented)
	/** EVERY blocking ask of this agent that the villager does not carry, whatever the act, in compareAsks
	 *  order (working: all its blocking asks that do not hold a run; asking: its other blocking asks;
	 *  any other act: none can exist, because a blocking ask makes the act asking or working).
	 *  Each is placed at the you-spot as a NoticePost by youSpotSlots, or counted in its overflow. */
	parkedAsks: InterfaceAsk[];
	/** Other threads/asks that need an object at the station or the you-spot while the villager is away.
	 *  asks = parkedAsks.length; blocked = counted blockers other than the focus one; old = blockers too old
	 *  to count; unread = unread reply asks other than the carried one; suggestions = suggestions.length. */
	pending: {
		asks: number;
		blocked: number;
		old: number;
		unread: number;
		suggestions: number;
	};
	progress: InterfaceProgress | null;
	/** The focus running thread is hydrated (detail:"detail") and its lastProgressAt is more than 10 min
	 *  before nowMs. The run may have ended without Core saying so (§3.3), so a stalled act is never worded
	 *  as live work (template below) and is counted as `stalled`, not `working`, in actTotals. */
	stalled: boolean;
	/** waitLabel(lastProgressAt, {long:true}) when stalled; null otherwise. */
	stalledFor: string | null;
	/** This agent's suggestions, in compareAsks order. Shown as a SuggestionNote at the station. */
	suggestions: InterfaceAsk[];
	threadId: string | null;
	timer: {
		since: string | null;
		approx: boolean;
		until: string | null;
		untilApprox: boolean;
	} | null;
}

export interface ClockOptions {
	locale?: string;
	timeZone?: string;
}

function parseMs(iso: string | null | undefined): number | null {
	if (!iso) {
		return null;
	}
	const value = Date.parse(iso);
	return Number.isFinite(value) ? value : null;
}

function compareNullableAsc(a: number | null, b: number | null): number {
	if (a === null || b === null) {
		return Number(a === null) - Number(b === null);
	}
	return a - b;
}

/** Blocking first; then asks with a deadline before asks without one, with the earliest `expiresAt` first;
 *  then the oldest `since` (null last); then id. Pure and time-independent: no `nowMs`, so the order only
 *  changes when asks arrive or leave. */
export function compareAsks(a: InterfaceAsk, b: InterfaceAsk): number {
	if (a.blocking !== b.blocking) {
		return a.blocking ? -1 : 1;
	}
	return (
		compareNullableAsc(parseMs(a.expiresAt), parseMs(b.expiresAt)) ||
		compareNullableAsc(parseMs(a.since), parseMs(b.since)) ||
		a.id.localeCompare(b.id)
	);
}

/** "expiring" when untilMs is set and ≤ 2 min remain (so a fresh 600 s question or permission is NOT
 *  expiring when it appears); otherwise by age: fresh < 5 m, waiting < 1 h, long < 1 d, stale ≥ 1 d;
 *  unknown when since is null. */
export function waitBand(
	sinceMs: number | null,
	nowMs: number,
	untilMs?: number | null
): "fresh" | "waiting" | "long" | "stale" | "expiring" | "unknown" {
	if (
		untilMs !== undefined &&
		untilMs !== null &&
		untilMs - nowMs <= EXPIRING_MS
	) {
		return "expiring";
	}
	if (sinceMs === null) {
		return "unknown";
	}
	const age = Math.max(0, nowMs - sinceMs);
	if (age < FRESH_MS) {
		return "fresh";
	}
	if (age < HOUR_MS) {
		return "waiting";
	}
	return age < DAY_MS ? "long" : "stale";
}

/**
 * A duration in whole minutes, hours or days. Ages round down (never
 * overstate a wait); countdowns round up (an upper bound stays one).
 */
function formatDuration(ms: number, long: boolean, roundUp: boolean): string {
	const round = roundUp ? Math.ceil : Math.floor;
	const minutes = round(Math.max(0, ms) / MINUTE_MS);
	if (minutes < 1) {
		return long ? "less than a minute" : "<1m";
	}
	const minutesPerDay = DAY_MS / MINUTE_MS;
	const minutesPerHour = HOUR_MS / MINUTE_MS;
	let value = minutes;
	let unit = "minute";
	if (minutes >= minutesPerDay) {
		value = round(minutes / minutesPerDay);
		unit = "day";
	} else if (minutes >= minutesPerHour) {
		// A countdown of 119 minutes reads "within 2 hours", never "1 hour".
		const hours = round(minutes / minutesPerHour);
		value = hours >= 24 ? 1 : hours;
		unit = hours >= 24 ? "day" : "hour";
	}
	if (!long) {
		return `${value}${unit[0]}`;
	}
	return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

/** Short: "14m" | "3h" | "2d"; "~" prefix when approx; "in 4m" for a countdown, "≤ 4m" when untilApprox.
 *  long: true → "14 minutes" | "3 hours" | "2 days" (for aria text). */
export function waitLabel(
	since: string | null,
	nowMs: number,
	opts?: {
		approx?: boolean;
		until?: string | null;
		untilApprox?: boolean;
		long?: boolean;
	}
): string | null {
	const long = opts?.long === true;
	const until = parseMs(opts?.until);
	if (until !== null) {
		const left = formatDuration(until - nowMs, long, true);
		if (opts?.untilApprox) {
			return long ? `within ${left}` : `≤ ${left}`;
		}
		return `in ${left}`;
	}
	const start = parseMs(since);
	if (start === null) {
		return null;
	}
	const age = formatDuration(nowMs - start, long, false);
	if (!opts?.approx) {
		return age;
	}
	return long ? `about ${age}` : `~${age}`;
}

function calendarDay(ms: number, timeZone: string | undefined): number {
	const parts = new Intl.DateTimeFormat("en-CA", {
		day: "numeric",
		month: "numeric",
		timeZone,
		year: "numeric",
	}).formatToParts(new Date(ms));
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((entry) => entry.type === type)?.value ?? 0);
	return Date.UTC(part("year"), part("month") - 1, part("day")) / DAY_MS;
}

/** Clock time for clearsAt, limit resets and NextSign. Same calendar day as nowMs → time only ("15:10");
 *  next day → "tomorrow 09:00"; within 6 days → short weekday ("Mon 09:00"); otherwise short date
 *  ("12 Nov 09:00"). Uses Intl.DateTimeFormat(locale, {hour:"2-digit", minute:"2-digit"}) plus
 *  {weekday:"short"} / {day:"numeric", month:"short"}; the day comparison uses opts.timeZone.
 *  Tests and the story harness pin { locale: "en-GB", timeZone: "UTC" }. */
export function clockLabel(
	iso: string,
	nowMs: number,
	opts?: ClockOptions
): string {
	const at = parseMs(iso);
	if (at === null) {
		return iso;
	}
	const { locale, timeZone } = opts ?? {};
	const time = new Intl.DateTimeFormat(locale, {
		hour: "2-digit",
		minute: "2-digit",
		timeZone,
	}).format(at);
	const days = calendarDay(at, timeZone) - calendarDay(nowMs, timeZone);
	if (days === 0) {
		return time;
	}
	if (days === 1) {
		return `tomorrow ${time}`;
	}
	if (days > 1 && days <= 6) {
		const weekday = new Intl.DateTimeFormat(locale, {
			timeZone,
			weekday: "short",
		}).format(at);
		return `${weekday} ${time}`;
	}
	const date = new Intl.DateTimeFormat(locale, {
		day: "numeric",
		month: "short",
		timeZone,
	}).format(at);
	return `${date} ${time}`;
}

const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const BACKTICKS = /`+/g;
// Bold or underline markers around whole words only, so dunder file names,
// starred identifiers and recursive globs keep every character.
const EMPHASIS = /(^|[\s(])(\*\*|__)(?=\S)(.+?)(?<=\S)\2(?=$|[\s),!?:;])/g;
const LINE_MARKERS = /^\s{0,3}(?:#{1,6}|>|[-*+])\s+/gm;
const WHITESPACE = /\s+/g;
const ENDS_WITH_STOP = /[.?!…]$/;
const TRAILING_STOP = /[.\s]+$/;

/** Text without backticks or markdown, on one line. */
function plainText(text: string | null | undefined): string {
	return (text ?? "")
		.replace(MARKDOWN_LINK, "$1")
		.replace(BACKTICKS, "")
		.replace(LINE_MARKERS, "")
		.replace(EMPHASIS, "$1$3")
		.replace(WHITESPACE, " ")
		.trim();
}

/** `text` closed with a full stop unless it already ends a sentence. */
function closed(text: string): string {
	return ENDS_WITH_STOP.test(text) ? text : `${text}.`;
}

/** Lowercase the first letter of a word, but leave acronyms ("API key") alone. */
function lowerFirst(text: string): string {
	const second = text.charAt(1);
	if (second && second !== second.toLowerCase()) {
		return text;
	}
	return text.charAt(0).toLowerCase() + text.slice(1);
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Canonical tool names a label may lead with, and the verb a bubble uses instead. */
const TOOL_VERBS = new Map<string, string>([
	["Bash", "Running"],
	["Edit", "Editing"],
	["Glob", "Finding"],
	["Grep", "Searching"],
	["MultiEdit", "Editing"],
	["NotebookEdit", "Editing"],
	["Read", "Reading"],
	["Task", "Delegating"],
	["TodoWrite", "Planning"],
	["WebFetch", "Fetching"],
	["WebSearch", "Searching"],
	["Write", "Writing"],
]);

function clampWords(words: string[], maxWords: number): string {
	const limit = Math.max(1, Math.floor(maxWords));
	if (words.length <= limit) {
		return words.join(" ");
	}
	return `${words.slice(0, limit).join(" ")}…`;
}

/** Clamp to maxWords (default 5) with a verb-first rewrite for tool labels.
 *  The rewrite applies only to a "Tool: target" label ("Bash: bun test" →
 *  "Running bun test"); any other text, an ask or a blocker title, is only
 *  clamped, so "Write tests first?" keeps its first word. */
export function shortLine(
	text: string,
	maxWords = DEFAULT_SHORT_LINE_WORDS
): string {
	const words = plainText(text).split(" ").filter(Boolean);
	const lead = words[0];
	const verb =
		lead?.endsWith(":") && words.length > 1
			? TOOL_VERBS.get(lead.slice(0, -1))
			: undefined;
	if (verb) {
		words[0] = verb;
	}
	return clampWords(words, maxWords);
}

/** An activity label for a bubble: a bare canonical tool name leading the
 *  label ("Edit snapshot.ts") reads as its verb ("Editing snapshot.ts"). */
function toolLabelLine(label: string): string {
	const words = plainText(label).split(" ").filter(Boolean);
	const lead = words[0]?.replace(/:$/, "");
	const verb = lead === undefined ? undefined : TOOL_VERBS.get(lead);
	if (verb && words.length > 1) {
		words[0] = verb;
	}
	return clampWords(words, DEFAULT_SHORT_LINE_WORDS);
}

/** The redacted wording of an ask: what kind of thing waits, with no content. */
export function askKindWords(ask: InterfaceAsk): string {
	if (isSuggestion(ask)) {
		return "Suggestion";
	}
	switch (ask.kind) {
		case "approval":
			return "Needs approval";
		case "question":
			return "Question for you";
		case "permission":
			return "Needs permission";
		case "input":
			return "Needs input";
		default:
			return "Reply ready";
	}
}

const BLOCKER_KIND_WORDS: Record<InterfaceBlockerKind, string> = {
	auth: "Login needed",
	billing: "Billing",
	"command-failed": "Failed",
	error: "Failed",
	interrupted: "Interrupted",
	"rate-limited": "Limit hit",
	"schedule-failed": "Routine failed",
	"tool-failed": "Failed",
};

/** The redacted title of a blocker: its kind in plain words. */
export function blockerKindWord(kind: InterfaceBlockerKind): string {
	return BLOCKER_KIND_WORDS[kind];
}

function isToolCallWithTarget(ask: InterfaceAsk): boolean {
	return (
		ask.kind === "approval" &&
		ask.subject === "tool_call" &&
		Boolean(ask.target)
	);
}

/** Templated bubble words for an ask. A tool_call approval with a target reads "Run <target>?"
 *  ("Run deploy.sh?"); otherwise shortLine(text). The snapshot is already redacted by the host; `privacy`
 *  is a belt-and-braces check that forces kind words ("Needs approval"). */
export function askBubble(
	ask: InterfaceAsk,
	privacy?: "full" | "redacted"
): string {
	if (privacy === "redacted") {
		return askKindWords(ask);
	}
	if (isToolCallWithTarget(ask)) {
		return shortLine(`Run ${plainText(ask.target)}?`);
	}
	return shortLine(ask.text) || askKindWords(ask);
}

/** Display form of a Core risk tag: replaces `_` / `-` runs with a space ("force_push" → "force push").
 *  Moved here from apps/desktop/src/components/inbox/InboxCenter.tsx:130 (`tagLabel`); InboxCenter imports it. */
export function riskTagLabel(tag: string): string {
	return tag.replace(/[_-]+/g, " ");
}

function askText(ask: InterfaceAsk, redacted: boolean): string {
	return redacted
		? askKindWords(ask)
		: plainText(ask.text) || askKindWords(ask);
}

/** " Waited 14 minutes." / " Waiting about 1 day.", or "" with no start. */
function waitedClause(ask: InterfaceAsk, nowMs: number, verb: string): string {
	const wait = waitLabel(ask.since, nowMs, {
		approx: ask.sinceApprox === true,
		long: true,
	});
	return wait ? ` ${verb} ${wait}.` : "";
}

function expiryClause(ask: InterfaceAsk, nowMs: number): string {
	if (!ask.expiresAt) {
		return "";
	}
	const left = waitLabel(null, nowMs, {
		long: true,
		until: ask.expiresAt,
		untilApprox: ask.expiresApprox === true,
	});
	return left ? ` Expires ${left}.` : "";
}

function riskClause(ask: InterfaceAsk): string {
	const tags = (ask.riskTags ?? [])
		.slice(0, MAX_ARIA_RISK_TAGS)
		.map(riskTagLabel)
		.filter(Boolean);
	return tags.length > 0 ? ` Risk: ${tags.join(", ")}.` : "";
}

/** Accessible name of ONE ask, for every AskQueueList button, notice plate, parked-ask post, suggestion note,
 *  tray item and "Answer" control. Backticks and markdown are stripped from text; "Waiting about …" /
 *  "Waited about …" when sinceApprox. Under redaction text is the kind words and there is no Target clause.
 *  - blocking: "<Agent> asks: <text>. Target: <target>. Waited <long>. Expires in <long>. Risk: <tag>, <tag>."
 *    (Target clause only for a tool_call approval with a target; "Expires within <long>." when expiresApprox);
 *    agentName null → "Inbox asks: …".
 *  - reply: "<Agent> has an answer ready: <text>. Waiting <long>."
 *  - async question: "<Agent> has a question when you have time: <text>. Waiting <long>."
 *  - heal_fix / skill_synthesis: "<Agent> suggests: <text>. Waiting <long>." ("Inbox suggests: …"). */
export function askAriaLabel(
	ask: InterfaceAsk,
	agentName: string | null,
	nowMs: number,
	privacy?: "full" | "redacted"
): string {
	const redacted = privacy === "redacted";
	const who = agentName ?? "Inbox";
	const text = closed(askText(ask, redacted));
	const waiting = waitedClause(ask, nowMs, "Waiting");
	// Redacted, the lead already says what kind of thing waits; no echo.
	if (ask.kind === "reply") {
		return redacted
			? `${who} has an answer ready.${waiting}`
			: `${who} has an answer ready: ${text}${waiting}`;
	}
	if (!ask.blocking) {
		if (ask.kind === "question") {
			return redacted
				? `${who} has a question when you have time.${waiting}`
				: `${who} has a question when you have time: ${text}${waiting}`;
		}
		return redacted
			? `${who} has a suggestion.${waiting}`
			: `${who} suggests: ${text}${waiting}`;
	}
	const target =
		!redacted && isToolCallWithTarget(ask)
			? ` Target: ${closed(plainText(ask.target))}`
			: "";
	return `${who} asks: ${text}${target}${waitedClause(ask, nowMs, "Waited")}${expiryClause(ask, nowMs)}${riskClause(ask)}`;
}

function blockerTitle(blocker: InterfaceBlocker, redacted: boolean): string {
	if (redacted) {
		return blockerKindWord(blocker.kind);
	}
	return (
		plainText(blocker.title).replace(TRAILING_STOP, "") ||
		blockerKindWord(blocker.kind)
	);
}

/** Accessible name of ONE blocker, for AskQueueList blocker buttons and alarm plates, same phrasing as the
 *  blocked row of the ariaLabel template: "<Agent> stopped: <title>, <at> ago." (+ " Clears <clock>.").
 *  A blocker with source "estimate" reads "<Agent> stopped, likely <title>, …". */
export function blockerAriaLabel(
	blocker: InterfaceBlocker,
	agentName: string,
	nowMs: number,
	privacy?: "full" | "redacted",
	clock?: ClockOptions
): string {
	const title = blockerTitle(blocker, privacy === "redacted");
	const head =
		blocker.source === "estimate"
			? `${agentName} stopped, likely ${lowerFirst(title)}`
			: `${agentName} stopped: ${title}`;
	const ago = waitLabel(blocker.at ?? null, nowMs, { long: true });
	const when = ago ? `, ${blocker.atApprox ? "about " : ""}${ago} ago` : "";
	const clears = blocker.clearsAt
		? ` Clears ${clockLabel(blocker.clearsAt, nowMs, clock)}.`
		: "";
	return `${head}${when}.${clears}`;
}

const TOOL_STEP_KINDS = new Map<string, InterfaceActivityKind>([
	["acp-plan", "plan"],
	["agent", "delegate"],
	["askuserquestion", "ask"],
	["bash", "run"],
	["bashoutput", "run"],
	["edit", "edit"],
	["glob", "read"],
	["grep", "search"],
	["killshell", "run"],
	["ls", "read"],
	["multiedit", "edit"],
	["notebookedit", "edit"],
	["notebookread", "read"],
	["question", "ask"],
	["read", "read"],
	["reasoning", "think"],
	["task", "delegate"],
	["text", "answer"],
	["thinking", "think"],
	["todowrite", "plan"],
	["webfetch", "web"],
	["websearch", "search"],
	["write", "write"],
]);

const ACP_STEP_KINDS = new Map<string, InterfaceActivityKind>([
	["delete", "edit"],
	["edit", "edit"],
	["execute", "run"],
	["fetch", "web"],
	["move", "edit"],
	["read", "read"],
	["search", "search"],
	["think", "think"],
]);

const DELEGATE_TOOL = /(?:^|[._])(?:create_thread|send_message_to_thread)$/;
const BROWSER_MCP_TOOL = /^mcp__.*browser/i;

/** Canonical tool name / ACP kind → activity kind. Unknown → "tool". */
export function stepKindForTool(
	tool: string | null,
	acpKind?: string | null
): InterfaceActivityKind {
	if (tool) {
		const direct = TOOL_STEP_KINDS.get(tool.toLowerCase());
		if (direct) {
			return direct;
		}
		if (DELEGATE_TOOL.test(tool)) {
			return "delegate";
		}
		if (BROWSER_MCP_TOOL.test(tool)) {
			return "web";
		}
	}
	return (
		(acpKind ? ACP_STEP_KINDS.get(acpKind.toLowerCase()) : undefined) ?? "tool"
	);
}

function medianOf(values: readonly number[]): number | null {
	if (values.length === 0) {
		return null;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const upper = sorted[middle] ?? 0;
	return sorted.length % 2 === 0
		? ((sorted[middle - 1] ?? upper) + upper) / 2
		: upper;
}

/** Median length (ms) of finished past runs (kind "past", end > start) matching the filter. Null without
 *  history. No floor, clamp, default or cross-filter fallback. `jobId` restricts to one routine (used by
 *  estimateProgress / longerThanUsual); `agentId` alone pools an agent's routines (kept for the existing
 *  kitchen / rides callers, whose behaviour must not change). */
export function medianRunMs(
	events: readonly InterfaceEvent[] | undefined,
	filter: { agentId?: string; jobId?: string }
): number | null {
	const lengths: number[] = [];
	for (const event of events ?? []) {
		if (event.kind !== "past") {
			continue;
		}
		if (filter.jobId !== undefined && event.jobId !== filter.jobId) {
			continue;
		}
		if (filter.agentId !== undefined && event.agentId !== filter.agentId) {
			continue;
		}
		const start = parseMs(event.start);
		const end = parseMs(event.end);
		if (start !== null && end !== null && end > start) {
			lengths.push(end - start);
		}
	}
	return medianOf(lengths);
}

/** Estimate progress: (now - thread.routineRun.firedAt) / medianRunMs(events, {jobId: routineRun.jobId}),
 *  capped at 0.94. Always kind "estimate". Null when thread.routineRun is absent or the median is null.
 *  `done` and `total` are milliseconds: elapsed (capped at 0.94 × median) and the median. */
export function estimateProgress(
	thread: InterfaceThread,
	nowMs: number,
	events?: readonly InterfaceEvent[]
): InterfaceProgress | null {
	const run = thread.routineRun;
	const firedAt = parseMs(run?.firedAt);
	if (!run || firedAt === null) {
		return null;
	}
	const median = medianRunMs(events, { jobId: run.jobId });
	if (median === null) {
		return null;
	}
	const elapsed = Math.max(0, nowMs - firedAt);
	return {
		current: null,
		done: Math.min(elapsed, median * ESTIMATE_CAP),
		kind: "estimate",
		next: null,
		source: "estimate",
		total: median,
	};
}

/**
 * The one agent each thread's blockers, replies and asks are counted for (the
 * arena pickFocus rule with its `claimed` set): agents in snapshot order claim
 * their threads newest first; a thread another agent already claimed gives
 * way. A running thread still counts as running for EVERY member (a live run
 * always wins), so a shared run never leaves a working member idle.
 * Renderers use it to put a thread's blockers and replies at one agent.
 */
export function threadClaims(snapshot: InterfaceSnapshot): Map<string, string> {
	const claims = new Map<string, string>();
	const threads = [...snapshot.threads].sort(newestThreadFirst);
	for (const agent of snapshot.agents) {
		for (const thread of threads) {
			if (!claims.has(thread.id) && thread.agentIds.includes(agent.id)) {
				claims.set(thread.id, agent.id);
			}
		}
	}
	return claims;
}

function askOwnerId(
	ask: InterfaceAsk,
	agentIds: ReadonlySet<string>,
	claims: ReadonlyMap<string, string>
): string | null {
	if (ask.agentId && agentIds.has(ask.agentId)) {
		return ask.agentId;
	}
	return ask.threadId ? (claims.get(ask.threadId) ?? null) : null;
}

/** Asks that resolve to no agent present in snapshot.agents (workflow gates, unknown agentId with no
 *  thread owner), in compareAsks order. Every ask in snapshot.asks is either owned or in this list.
 *  Unowned suggestions are included; renderers route them to the suggestions group, not the you-spot. */
export function unownedAsks(snapshot: InterfaceSnapshot): InterfaceAsk[] {
	const agentIds = new Set(snapshot.agents.map((agent) => agent.id));
	const claims = threadClaims(snapshot);
	return (snapshot.asks ?? [])
		.filter((ask) => askOwnerId(ask, agentIds, claims) === null)
		.sort(compareAsks);
}

interface BlockerEntry {
	blocker: InterfaceBlocker;
	counted: boolean;
	thread: InterfaceThread;
}

/** Counted: `at` within 24 h, or the thread is unread, or no `at` and the thread moved within 24 h. */
function isCountedBlocker(
	blocker: InterfaceBlocker,
	thread: InterfaceThread,
	nowMs: number
): boolean {
	const at = parseMs(blocker.at);
	if (at !== null && nowMs - at <= COUNTED_BLOCKER_MS) {
		return true;
	}
	if ((thread.unread ?? 0) > 0) {
		return true;
	}
	// updatedAt only gates counting a blocker with no time; it is never shown.
	const updated = parseMs(thread.updatedAt);
	return (
		at === null && updated !== null && nowMs - updated <= COUNTED_BLOCKER_MS
	);
}

function newestBlockerFirst(a: BlockerEntry, b: BlockerEntry): number {
	const negated = (entry: BlockerEntry) => {
		const at = parseMs(entry.blocker.at);
		return at === null ? null : -at;
	};
	return (
		compareNullableAsc(negated(a), negated(b)) ||
		a.thread.id.localeCompare(b.thread.id)
	);
}

function newestThreadFirst(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

function nextLabel(
	agentId: string,
	progress: InterfaceProgress | null,
	snapshot: InterfaceSnapshot,
	nowMs: number,
	clock: ClockOptions | undefined
): string | null {
	const step = snapshot.privacy === "redacted" ? "" : plainText(progress?.next);
	if (step) {
		return `Next: ${step.replace(TRAILING_STOP, "")}`;
	}
	let soonest: number | null = null;
	for (const event of snapshot.events ?? []) {
		const start = parseMs(event.start);
		if (
			event.kind === "upcoming" &&
			event.agentId === agentId &&
			start !== null &&
			start >= nowMs &&
			(soonest === null || start < soonest)
		) {
			soonest = start;
		}
	}
	return soonest === null
		? null
		: `Next run ${clockLabel(new Date(soonest).toISOString(), nowMs, clock)}`;
}

function firstWords(text: string, count: number): string {
	return plainText(text).split(" ").filter(Boolean).slice(0, count).join(" ");
}

interface ActDraft {
	act: InterfaceAct;
	carried: InterfaceAsk | null;
	focusBlocker: BlockerEntry | null;
	focusThread: InterfaceThread | undefined;
	parked: InterfaceAsk[];
}

interface AgentInputs {
	agent: InterfaceAgent;
	blocking: InterfaceAsk[];
	counted: BlockerEntry[];
	/** Every thread the agent is a member of, newest first. */
	member: InterfaceThread[];
	/** The threads this agent claims (blockers and replies count here). */
	owned: InterfaceThread[];
	replies: InterfaceAsk[];
	running: InterfaceThread[];
}

/** First match wins: asking, working, blocked, limited, delivering, waiting, idle. */
function draftAct(
	inputs: AgentInputs,
	nowMs: number,
	threadById: ReadonlyMap<string, InterfaceThread>
): ActDraft {
	const { agent, blocking, counted, member, owned, replies, running } = inputs;
	const holding = blocking.filter((ask) => ask.holdsRun === true);
	const carriedBlocking = running.length > 0 ? holding[0] : blocking[0];
	if (carriedBlocking) {
		return {
			act: "asking",
			carried: carriedBlocking,
			focusBlocker: null,
			focusThread: carriedBlocking.threadId
				? threadById.get(carriedBlocking.threadId)
				: undefined,
			parked: blocking.filter((ask) => ask !== carriedBlocking),
		};
	}
	if (running[0]) {
		return {
			act: "working",
			carried: null,
			focusBlocker: null,
			focusThread: running[0],
			parked: blocking,
		};
	}
	const failure = counted.find(
		(entry) => entry.blocker.kind !== "rate-limited"
	);
	if (failure) {
		return {
			act: "blocked",
			carried: null,
			focusBlocker: failure,
			focusThread: failure.thread,
			parked: [],
		};
	}
	const limit = counted.find((entry) => entry.blocker.kind === "rate-limited");
	if (limit || agent.limit?.blocked) {
		return {
			act: "limited",
			carried: null,
			focusBlocker: limit ?? null,
			focusThread: limit?.thread ?? owned[0] ?? member[0],
			parked: [],
		};
	}
	const walk = replies
		.filter((ask) => {
			const since = parseMs(ask.since);
			return since !== null && nowMs - since <= DELIVER_WALK_MS;
		})
		.sort((a, b) => (parseMs(b.since) ?? 0) - (parseMs(a.since) ?? 0))[0];
	if (walk) {
		return {
			act: "delivering",
			carried: walk,
			focusBlocker: null,
			focusThread: walk.threadId ? threadById.get(walk.threadId) : undefined,
			parked: [],
		};
	}
	const newest = owned[0];
	const waiting = newest !== undefined && threadStatus(newest) === "waiting";
	return {
		act: waiting ? "waiting" : "idle",
		carried: null,
		focusBlocker: null,
		// An agent whose threads are all claimed by others repeats the newest.
		focusThread: newest ?? member[0],
		parked: [],
	};
}

function workBubble(
	thread: InterfaceThread | undefined,
	progress: InterfaceProgress | null,
	redacted: boolean
): InterfaceAgentAct["bubble"] {
	if (!thread) {
		return null;
	}
	if (redacted && !thread.activity?.label) {
		return {
			partial: thread.detail !== "detail",
			text: "Working",
			tone: "work",
		};
	}
	if (thread.activity?.label) {
		return {
			partial: false,
			text: toolLabelLine(thread.activity.label),
			tone: "work",
		};
	}
	const current = plainText(progress?.current);
	if (
		thread.detail === "detail" &&
		current &&
		(progress?.kind === "plan" || progress?.kind === "workflow")
	) {
		return {
			partial: false,
			text: shortLine(`Step ${progress.done}/${progress.total}: ${current}`),
			tone: "work",
		};
	}
	return {
		partial: thread.detail !== "detail",
		text: shortLine(
			`Working on ${firstWords(thread.title, WORKING_TITLE_WORDS)}`
		),
		tone: "work",
	};
}

function limitClearsAt(draft: ActDraft, agent: InterfaceAgent): string | null {
	return draft.focusBlocker?.blocker.clearsAt ?? agent.limit?.resetsAt ?? null;
}

interface ActDetail {
	agent: InterfaceAgent;
	clock: ClockOptions | undefined;
	draft: ActDraft;
	elapsedLong: string | null;
	longerThanUsual: boolean;
	nowMs: number;
	pending: InterfaceAgentAct["pending"];
	progress: InterfaceProgress | null;
	redacted: boolean;
	stalledFor: string | null;
}

function bubbleFor(detail: ActDetail): InterfaceAgentAct["bubble"] {
	const { agent, clock, draft, nowMs, progress, redacted } = detail;
	switch (draft.act) {
		case "asking":
			return draft.carried
				? {
						partial: false,
						text: askBubble(draft.carried, redacted ? "redacted" : "full"),
						tone: "ask",
					}
				: null;
		case "working":
			return detail.stalledFor === null
				? workBubble(draft.focusThread, progress, redacted)
				: null;
		case "blocked":
			return draft.focusBlocker
				? {
						partial: false,
						text: shortLine(blockerTitle(draft.focusBlocker.blocker, redacted)),
						tone: "error",
					}
				: null;
		case "limited": {
			const likely = draft.focusBlocker?.blocker.source === "estimate";
			const head = likely ? "Likely limit" : "Limit hit";
			const clearsAt = limitClearsAt(draft, agent);
			const text = clearsAt
				? `${head}, back ${clockLabel(clearsAt, nowMs, clock)}`
				: head;
			return { partial: false, text, tone: "limit" };
		}
		case "delivering": {
			const files = draft.focusThread?.outcome?.filesChanged ?? 0;
			const text =
				files > 0 ? `${plural(files, "file")} edited` : "Answer ready";
			return { partial: false, text, tone: "done" };
		}
		case "waiting":
			return { partial: false, text: "Picking this up", tone: "wait" };
		default:
			return null;
	}
}

function carryFor(draft: ActDraft): InterfaceAgentAct["carry"] {
	switch (draft.act) {
		case "asking":
			if (draft.carried?.kind === "question") {
				return "question";
			}
			return draft.carried?.kind === "approval" ||
				draft.carried?.kind === "permission"
				? "approval"
				: null;
		case "working":
			return draft.focusThread?.activity?.kind ?? null;
		case "delivering":
			return "deliverable";
		default:
			return null;
	}
}

function timerFor(
	draft: ActDraft,
	agent: InterfaceAgent
): InterfaceAgentAct["timer"] {
	if (draft.act === "asking" && draft.carried) {
		return {
			approx: draft.carried.sinceApprox === true,
			since: draft.carried.since,
			until: draft.carried.expiresAt ?? null,
			untilApprox: draft.carried.expiresApprox === true,
		};
	}
	if (draft.act === "limited") {
		return {
			approx: false,
			since: null,
			until: limitClearsAt(draft, agent),
			untilApprox: false,
		};
	}
	return null;
}

function parkedClause(
	parked: readonly InterfaceAsk[],
	redacted: boolean
): string {
	const first = parked[0];
	if (!first) {
		return "";
	}
	const more = parked.length > 1 ? ` +${parked.length - 1} more.` : "";
	return redacted
		? ` Ask waiting.${more}`
		: ` Ask waiting: ${closed(askText(first, false))}${more}`;
}

function progressClause(progress: InterfaceProgress | null): string {
	if (!progress) {
		return "";
	}
	return progress.kind === "estimate"
		? ", progress estimated"
		: `, step ${progress.done} of ${progress.total}`;
}

/** The progress clause as its own sentence, for a stalled act. */
function stalledProgress(progress: InterfaceProgress | null): string {
	if (!progress) {
		return "";
	}
	return progress.kind === "estimate"
		? " Progress estimated."
		: ` Step ${progress.done} of ${progress.total}.`;
}

function baseSentence(detail: ActDetail): string {
	const { agent, clock, draft, nowMs, progress, redacted } = detail;
	const name = agent.name;
	const ask = draft.carried;
	switch (draft.act) {
		case "asking": {
			if (!ask) {
				return `${name} is idle.`;
			}
			const head = redacted
				? `${name}: ${closed(askKindWords(ask))}`
				: `${name} asks: ${closed(askText(ask, false))}`;
			const target =
				!redacted && isToolCallWithTarget(ask)
					? ` Target: ${closed(plainText(ask.target))}`
					: "";
			return `${head}${target}${waitedClause(ask, nowMs, "Waited")}${expiryClause(ask, nowMs)}${riskClause(ask)}${parkedClause(draft.parked, redacted)}`;
		}
		case "working": {
			if (detail.stalledFor !== null) {
				return `${name} shows no progress for ${detail.stalledFor}; the run may have stopped.${stalledProgress(progress)}${parkedClause(draft.parked, redacted)}`;
			}
			const thread = draft.focusThread;
			const label = plainText(thread?.activity?.label).replace(
				TRAILING_STOP,
				""
			);
			let doing = "is working";
			if (!redacted && label) {
				doing = `is ${lowerFirst(label)}`;
			} else if (!redacted && thread) {
				doing = `is working on ${plainText(thread.title)}`;
			}
			const elapsed = detail.elapsedLong
				? `, running ${detail.elapsedLong}`
				: "";
			const longer = detail.longerThanUsual ? ", longer than usual" : "";
			return `${name} ${doing}${progressClause(progress)}${elapsed}${longer}.${parkedClause(draft.parked, redacted)}`;
		}
		case "blocked":
			return draft.focusBlocker
				? blockerAriaLabel(
						draft.focusBlocker.blocker,
						name,
						nowMs,
						redacted ? "redacted" : "full",
						clock
					)
				: `${name} is idle.`;
		case "limited": {
			const window = agent.limit?.label ? ` (${agent.limit.label})` : "";
			const clearsAt = limitClearsAt(draft, agent);
			const back = clearsAt
				? `back ${clockLabel(clearsAt, nowMs, clock)}`
				: "no reset time";
			return `${name} hit a usage limit${window}, ${back}.`;
		}
		case "delivering": {
			if (redacted || !ask) {
				return `${name} has an answer ready.`;
			}
			const files = draft.focusThread?.outcome?.filesChanged;
			const changed =
				files !== undefined && files > 0
					? ` ${plural(files, "file")} changed.`
					: "";
			return `${name} has an answer ready: ${closed(askText(ask, false))}${changed}`;
		}
		case "waiting":
			return `${name} has your message and has not started.`;
		default:
			return `${name} is idle.`;
	}
}

function pendingSentence(
	pending: InterfaceAgentAct["pending"],
	parkedNamed: boolean
): string {
	const terms: string[] = [];
	if (!parkedNamed && pending.asks > 0) {
		terms.push(plural(pending.asks, "more ask"));
	}
	if (pending.blocked > 0) {
		terms.push(plural(pending.blocked, "failed thread"));
	}
	if (pending.unread > 0) {
		terms.push(plural(pending.unread, "unread answer"));
	}
	if (pending.suggestions > 0) {
		terms.push(plural(pending.suggestions, "suggestion"));
	}
	if (pending.old > 0) {
		terms.push(plural(pending.old, "older failure"));
	}
	return terms.length > 0 ? ` Also: ${terms.join(", ")}.` : "";
}

function helpersSentence(helpers: InterfaceHelpers | null): string {
	if (!helpers) {
		return "";
	}
	// Template: " {n} helpers running." (+ ", {n} failed"), only while some run.
	if (helpers.running <= 0) {
		return "";
	}
	const failed = helpers.failed > 0 ? `, ${helpers.failed} failed` : "";
	return ` ${plural(helpers.running, "helper")} running${failed}.`;
}

/** One act per agent, first match wins:
 *  1. asking: a blocking ask owned by this agent with holdsRun === true, or any blocking ask while
 *     the agent has no running thread (compareAsks picks the carried one; the rest go to parkedAsks);
 *  2. working: any running thread. All its blocking asks go to parkedAsks;
 *  3. blocked: a counted blocker whose kind is not rate-limited (the newest `at` is the focus);
 *  4. limited: agent.limit.blocked, or a counted rate-limited blocker;
 *  5. delivering: an unread reply ask with since ≤ 24 h;
 *  6. waiting; 7. idle.
 *  Suggestions never change the act; they only fill `suggestions` / pending.suggestions.
 *  "Counted" blocker: `at` within 24 h of nowMs, or its thread has unread > 0, or (`at` is null and the
 *  thread's updatedAt is within 24 h; updatedAt is used only as this gate and is never displayed).
 *  Other blockers go to pending.old (a station mark only, not counted anywhere).
 *  Owner of an ask: ask.agentId if that agent is in snapshot.agents, else threadById(ask.threadId)?.agentIds
 *  [first one present in snapshot.agents]. An ask with no such owner is UNOWNED (see unownedAsks).
 *  Shared team threads go to one agent (arena pickFocus rule, `claimed` set): the first of the thread's
 *  agentIds present in snapshot.agents claims it. */
export function agentActs(
	snapshot: InterfaceSnapshot,
	nowMs: number,
	locale?: ClockOptions
): Map<string, InterfaceAgentAct> {
	const redacted = snapshot.privacy === "redacted";
	const agentIds = new Set(snapshot.agents.map((agent) => agent.id));
	const threadById = new Map(
		snapshot.threads.map((thread) => [thread.id, thread])
	);
	const claims = threadClaims(snapshot);
	const threadsByOwner = new Map<string, InterfaceThread[]>();
	for (const thread of snapshot.threads) {
		const owner = claims.get(thread.id);
		if (owner) {
			const list = threadsByOwner.get(owner) ?? [];
			list.push(thread);
			threadsByOwner.set(owner, list);
		}
	}
	const asksByOwner = new Map<string, InterfaceAsk[]>();
	for (const ask of snapshot.asks ?? []) {
		const owner = askOwnerId(ask, agentIds, claims);
		if (owner) {
			const list = asksByOwner.get(owner) ?? [];
			list.push(ask);
			asksByOwner.set(owner, list);
		}
	}
	const acts = new Map<string, InterfaceAgentAct>();
	for (const agent of snapshot.agents) {
		const owned = [...(threadsByOwner.get(agent.id) ?? [])].sort(
			newestThreadFirst
		);
		// Every member's thread, for live runs and for an unclaimed agent's focus.
		const member = snapshot.threads
			.filter((thread) => thread.agentIds.includes(agent.id))
			.sort(newestThreadFirst);
		const asks = [...(asksByOwner.get(agent.id) ?? [])].sort(compareAsks);
		const entries = owned.flatMap((thread): BlockerEntry[] =>
			thread.blocker
				? [
						{
							blocker: thread.blocker,
							counted: isCountedBlocker(thread.blocker, thread, nowMs),
							thread,
						},
					]
				: []
		);
		const counted = entries
			.filter((entry) => entry.counted)
			.sort(newestBlockerFirst);
		const replies = asks.filter((ask) => ask.kind === "reply");
		const suggestions = asks.filter(isSuggestion);
		const draft = draftAct(
			{
				agent,
				blocking: asks.filter((ask) => ask.blocking),
				counted,
				member,
				owned,
				replies,
				running: member.filter((thread) => thread.running),
			},
			nowMs,
			threadById
		);
		const focusThread = draft.focusThread;
		const progress = focusThread?.running
			? (focusThread.progress ??
				estimateProgress(focusThread, nowMs, snapshot.events))
			: null;
		const working = draft.act === "working" && focusThread !== undefined;
		const exactStart =
			working && focusThread.runStartedApprox !== true
				? (focusThread.runStartedAt ?? null)
				: null;
		const routine = working ? focusThread.routineRun : null;
		const median = routine
			? medianRunMs(snapshot.events, { jobId: routine.jobId })
			: null;
		const firedAt = parseMs(routine?.firedAt);
		const lastProgress =
			working && focusThread.detail === "detail"
				? parseMs(focusThread.lastProgressAt)
				: null;
		const stalled = lastProgress !== null && nowMs - lastProgress > STALLED_MS;
		const blockers = draft.focusBlocker
			? [
					draft.focusBlocker,
					...counted.filter((entry) => entry !== draft.focusBlocker),
				]
			: counted;
		const pending: InterfaceAgentAct["pending"] = {
			asks: draft.parked.length,
			blocked: counted.length - (draft.focusBlocker ? 1 : 0),
			old: entries.length - counted.length,
			unread: replies.filter((ask) => ask !== draft.carried).length,
			suggestions: suggestions.length,
		};
		const detail: ActDetail = {
			agent,
			clock: locale,
			draft,
			elapsedLong: exactStart
				? waitLabel(exactStart, nowMs, { long: true })
				: null,
			longerThanUsual:
				median !== null && firedAt !== null && nowMs - firedAt > 2 * median,
			nowMs,
			pending,
			progress,
			redacted,
			stalledFor:
				stalled && focusThread
					? waitLabel(focusThread.lastProgressAt ?? null, nowMs, { long: true })
					: null,
		};
		const helpers = focusThread?.helpers ?? null;
		const next = nextLabel(agent.id, progress, snapshot, nowMs, locale);
		const ariaLabel = `${baseSentence(detail)}${pendingSentence(pending, draft.parked.length > 0)}${helpersSentence(helpers)}${next ? ` ${closed(next)}` : ""}`;
		acts.set(agent.id, {
			act: draft.act,
			agentId: agent.id,
			agentName: agent.name,
			ariaLabel,
			ask: draft.carried,
			blockers: blockers.map((entry) => entry.blocker),
			bubble: bubbleFor(detail),
			carry: carryFor(draft),
			elapsed: exactStart ? waitLabel(exactStart, nowMs) : null,
			helpers,
			longerThanUsual: detail.longerThanUsual,
			next,
			parkedAsks: draft.parked,
			pending,
			progress,
			stalled,
			stalledFor: detail.stalledFor,
			suggestions,
			threadId: focusThread?.id ?? draft.carried?.threadId ?? null,
			timer: timerFor(draft, agent),
		});
	}
	return acts;
}

// ── Redaction ─────────────────────────────────────────────────────────────

function redactedActivityLabel(label: string): string {
	return plainText(label).split(" ")[0] ?? "";
}

function redactThread(thread: InterfaceThread): InterfaceThread {
	const redacted: InterfaceThread = {
		...thread,
		lastMessage: null,
		title: "Conversation",
	};
	if (thread.workspace !== undefined) {
		redacted.workspace = null;
	}
	if (thread.activity) {
		redacted.activity = {
			...thread.activity,
			label: redactedActivityLabel(thread.activity.label),
			target: null,
		};
	}
	if (thread.outcome) {
		redacted.outcome = { ...thread.outcome, headline: null, summary: null };
	}
	if (thread.progress) {
		redacted.progress = { ...thread.progress, current: null, next: null };
	}
	if (thread.helpers) {
		redacted.helpers = { ...thread.helpers, titles: [] };
	}
	if (thread.blocker) {
		redacted.blocker = {
			...thread.blocker,
			detail: null,
			title: blockerKindWord(thread.blocker.kind),
		};
	}
	return redacted;
}

function redactAsk(ask: InterfaceAsk): InterfaceAsk {
	// Choices go too: option labels can be content, and a redacted card offers Open only.
	const { choices: _choices, ...rest } = ask;
	return { ...rest, reason: null, target: null, text: askKindWords(ask) };
}

/** The snapshot with every piece of user content removed (spec §3.2 "Redaction"): message text, thread
 *  titles, routine names and errors, group names, agent descriptions, ledger labels, ask text / reason /
 *  target, activity targets, outcome and progress text, helper titles and blocker detail. Ids, kinds,
 *  numbers, times, risk tags, agent names, schedule phrases and limit window names stay. Idempotent. */
export function redactSnapshot(snapshot: InterfaceSnapshot): InterfaceSnapshot {
	const redacted: InterfaceSnapshot = {
		...snapshot,
		agents: snapshot.agents.map((agent) => ({ ...agent, description: "" })),
		groups: snapshot.groups.map((group) => ({
			...group,
			name: group.kind === "team" ? "Team" : "Project",
		})),
		privacy: "redacted",
		threads: snapshot.threads.map(redactThread),
	};
	if (snapshot.asks) {
		redacted.asks = snapshot.asks.map(redactAsk);
	}
	if (snapshot.events) {
		redacted.events = snapshot.events.map((event) => ({
			...event,
			error: event.error === undefined ? undefined : null,
			title: "Routine",
		}));
	}
	if (snapshot.account) {
		redacted.account = {
			...snapshot.account,
			transactions: snapshot.account.transactions.map((transaction) => ({
				...transaction,
				label: "Usage",
			})),
		};
	}
	return redacted;
}
