import { Html } from "@react-three/drei";
import { cn } from "@ryu/ui/lib/utils";
import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceAsk,
	InterfaceBlocker,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { clockLabel, threadClaims } from "@ryuhq/protocol/interfaces";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	actHasBlocker,
	type NextRun,
	nextRunOf,
	type OffStage,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import {
	ALARM_STEP,
	type AlarmSide,
	AlarmStack,
	alarmSideFor,
	LimitCue,
} from "./game3d-alarm.tsx";
import { ApprenticeTally } from "./game3d-apprentice.tsx";
import type { LifeItem } from "./game3d-life.ts";
import { ActInk } from "./game3d-materials.tsx";
import {
	METER_TEXT_CLASS,
	type PipSkin,
	ProgressPips3D,
	progressText,
	RunCue,
	WaitTimer3D,
	type WaitTimerShape,
} from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { useGameKitSettings } from "./game3d-settings.tsx";
import {
	NextSign,
	NoticePost,
	offStageLabel,
	offStageText,
	overflowLabel,
	SuggestionNote,
	TallyPlate,
	TrayItem,
	UnreadMark,
} from "./game3d-signs.tsx";
import { useStageCramped, useStageQuality } from "./game3d-stage.tsx";

/**
 * The act layer's two reusable scene blocks, so a game passes positions and
 * a skin and the kit decides what to draw from the act and the overlay
 * budget:
 * - `ActStation`: everything at one agent's station (progress pips, next
 *   sign, run cue, alarms with old marks, limit clock, unread mark,
 *   suggestion note, apprentice tally), with its status words (limit,
 *   progress, elapsed, next, cue) stacked on one station board
 *   (`stationLines`) so they never overlap;
 * - `YouSpots`: the you-spot queue (notice posts, wait timers beside queued
 *   villagers, the "+N more" and off-stage tallies, the delivery tray).
 * `shown` is `overlayBudget(width, ...).fill(actOverlays(...))`; `iconOnly`
 * is the budget's `iconOnly`. Both blocks render inside an `IsoStage`.
 * `game3d-life-demo.tsx` is the reference wiring.
 */

/**
 * The reply asks waiting at an agent's station (not the one it carries),
 * newest first, owned as the protocol owns asks: a present `agentId`, else
 * the agent that claims the ask's thread (`threadClaims`).
 * Pass `claims` when drawing many stations, so it is computed once.
 */
export function unreadAsksOf(
	act: InterfaceAgentAct,
	snapshot: InterfaceSnapshot,
	claims: ReadonlyMap<string, string> = threadClaims(snapshot)
): InterfaceAsk[] {
	const present = new Set(snapshot.agents.map((agent) => agent.id));
	// The protocol's ask owner: a present agentId, else the thread's claimant.
	const ownerOf = (ask: InterfaceAsk) =>
		ask.agentId && present.has(ask.agentId)
			? ask.agentId
			: ask.threadId
				? (claims.get(ask.threadId) ?? null)
				: null;
	return (snapshot.asks ?? [])
		.filter(
			(ask) =>
				ask.kind === "reply" &&
				ask.id !== act.ask?.id &&
				ownerOf(ask) === act.agentId
		)
		.sort(
			(a, b) =>
				(Date.parse(b.since ?? "") || 0) - (Date.parse(a.since ?? "") || 0)
		);
}

/** An agent's failures too old to count, on threads it claims: dim marks only. */
export function oldBlockersOf(
	act: InterfaceAgentAct,
	snapshot: InterfaceSnapshot,
	claims: ReadonlyMap<string, string> = threadClaims(snapshot)
): InterfaceBlocker[] {
	return snapshot.threads
		.filter(
			(thread) =>
				claims.get(thread.id) === act.agentId &&
				thread.blocker &&
				!act.blockers.includes(thread.blocker)
		)
		.map((thread) => thread.blocker as InterfaceBlocker);
}

/**
 * The thread `blocker` (one of `act`'s alarms) stands for: the same object
 * on a thread the agent claims first, then a value match among its claimed
 * threads, so a copied blocker (stableActs, redaction) still finds its card
 * and two value-equal blockers each open their own.
 */
export function blockerThread(
	act: InterfaceAgentAct,
	blocker: InterfaceBlocker,
	snapshot: InterfaceSnapshot,
	claims: ReadonlyMap<string, string> = threadClaims(snapshot)
): InterfaceSnapshot["threads"][number] | undefined {
	// The same object first (two blockers can be equal by value: two
	// "Interrupted" with no time, or redacted ones), then by value.
	const claimed = (thread: InterfaceSnapshot["threads"][number]) =>
		claims.get(thread.id) === act.agentId;
	const one = { agentId: act.agentId, blockers: [blocker] };
	return (
		snapshot.threads.find(
			(thread) => thread.blocker === blocker && claimed(thread)
		) ??
		snapshot.threads.find((thread) => thread.blocker === blocker) ??
		snapshot.threads.find((thread) => actHasBlocker(one, thread, claims)) ??
		snapshot.threads.find((thread) => actHasBlocker(one, thread))
	);
}

/**
 * The stage's CSS size (for `overlayBudget(width, { height })`), `initial`
 * until measured: a stage squeezed beside a thread view is short.
 */
export function useStageSize(
	ref: RefObject<HTMLElement | null>,
	initial: { height: number; width: number } = { height: 800, width: 1280 }
): { height: number; width: number } {
	const [size, setSize] = useState(initial);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(([entry]) => {
			if (entry) {
				setSize({
					height: entry.contentRect.height,
					width: entry.contentRect.width,
				});
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

/** The stage's CSS width (for `overlayBudget`), `initial` until measured. */
export function useStageWidth(
	ref: RefObject<HTMLElement | null>,
	initial = 1280
): number {
	const [width, setWidth] = useState(initial);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(([entry]) => {
			if (entry) {
				setWidth(entry.contentRect.width);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

/**
 * Where each station piece sits, as an offset from the station (world
 * units). The status words (limit, progress, elapsed, next, cue) are not
 * placed one by one: they stack in one column, the station board at
 * `board`, so they never cover each other, and the board joins plate
 * separation as a single plate. The props keep to their own corners: the
 * openers (alarms, unread, suggestion) on the right and front, the meshes
 * (next sign, limit clock) on the left.
 */
export interface StationLayout {
	/**
	 * Plate rows each further alarm climbs on screen (default: one with the
	 * default `alarmStep`, none with a game's own step, which is the whole
	 * climb); -1 drops a row per alarm.
	 */
	alarmRows?: -1 | 0 | 1;
	/**
	 * How the alarm plates hang (default "auto": right when `alarms` sits
	 * clearly screen-right of the figure, left when clearly left, else
	 * centred; see `alarmSideFor`).
	 */
	alarmSide?: AlarmSide;
	/** Each further alarm plate's climb (`AlarmStack` step). */
	alarmStep: Vec3;
	alarms: Vec3;
	/** The station board: the centre of its column of status words. */
	board: Vec3;
	cue: Vec3;
	/**
	 * Where the agent's figure stands, as an offset from the station
	 * (default [0, 0, 0]). The alarm side is measured from it, so a station
	 * whose figure is not at its origin (a chair beside the desk, a keeper
	 * in front of the stall, a dealer behind the chips) must set it, or set
	 * `alarmSide`.
	 */
	figure?: Vec3;
	limit: Vec3;
	next: Vec3;
	pips: Vec3;
	suggestion: Vec3;
	unread: Vec3;
}

/** The default arrangement, for stations about 2.5 units apart. */
export const STATION_LAYOUT: StationLayout = {
	// Screen-right of the figure at its depth; plates hang further right.
	alarms: [0.75, 0, -0.75],
	alarmStep: ALARM_STEP,
	board: [0, 0, 1.1],
	cue: [0, 0.02, 0],
	limit: [-0.9, 0, -0.3],
	next: [-0.9, 0, -0.9],
	pips: [0, 0.05, 0.75],
	suggestion: [-0.8, 0, 0.9],
	unread: [0.9, 0, 0.6],
};

/** One line of a station board: what it says and its budget kind. */
export interface StationLine {
	id: string;
	kind: "elapsed" | "limit" | "text";
	text: string;
}

/**
 * A game's limit wording ("86'd till 15:10", "INSERT COIN 15:10"), from the
 * act and the reset time as `clockLabel` shows it ("15:10", "tomorrow
 * 09:00"), or null when the reset is unknown. The kit adds "Likely " in
 * front when the limit is only estimated.
 */
export type LimitText = (
	act: InterfaceAgentAct,
	clearsAt: string | null
) => string;

/** The limit is estimated from usage, not reported: "Likely …". */
export function limitIsLikely(act: InterfaceAgentAct): boolean {
	const focus = act.blockers[0];
	return focus?.kind === "rate-limited" && focus.source === "estimate";
}

/**
 * A limited act's words: the game's `limitText` when given (with "Likely "
 * for an estimated limit), else the act's own ("Limit hit, back 15:10").
 * Null for any other act.
 */
export function limitWords(
	act: InterfaceAgentAct,
	{
		clock,
		limitText,
		nowMs = 0,
	}: { clock?: ClockOptions; limitText?: LimitText; nowMs?: number } = {}
): string | null {
	if (act.act !== "limited") {
		return null;
	}
	if (!limitText) {
		return act.bubble?.text ?? null;
	}
	const until = act.timer?.until ?? null;
	const text = limitText(act, until ? clockLabel(until, nowMs, clock) : null);
	return limitIsLikely(act) ? `Likely ${text}` : text;
}

/**
 * The status words a station shows for `act`, top to bottom, keeping only
 * the ones the overlay budget chose: the limit (`limitWords`), progress
 * ("3/7", "~"), elapsed ("12m"), next step and run cue ("stalled?",
 * "Longer than usual").
 */
export function stationLines(
	act: InterfaceAgentAct,
	shown: ReadonlySet<string>,
	words: {
		clock?: ClockOptions;
		/** A cramped stage (`useStageCramped`) drops the "Next:" line first. */
		cramped?: boolean;
		/**
		 * The game's overlay density (`useGameKitSettings`): `minimal` keeps
		 * the limit and cue lines only.
		 */
		density?: "full" | "minimal";
		limitText?: LimitText;
		nowMs?: number;
	} = {}
): StationLine[] {
	const id = act.agentId;
	const lines: StationLine[] = [];
	const add = (key: string, kind: StationLine["kind"], text: string | null) => {
		if (text && shown.has(`${key}:${id}`)) {
			lines.push({ id: `${key}:${id}`, kind, text });
		}
	};
	add("limit", "limit", limitWords(act, words));
	const minimal = words.density === "minimal";
	add("progress", "text", minimal ? null : progressText(act.progress));
	add("elapsed", "elapsed", minimal ? null : act.elapsed);
	add("next", "text", words.cramped || minimal ? null : act.next);
	let cue: string | null = null;
	if (act.stalled) {
		cue = "stalled?";
	} else if (act.longerThanUsual) {
		cue = act.elapsed
			? `Longer than usual · ${act.elapsed}`
			: "Longer than usual";
	}
	add("cue", "text", cue);
	return lines;
}

/**
 * The limit line's tone: the theme's warn (amber) plate, as limited acts
 * are amber everywhere. Games pass `limitTone` (class tokens from their
 * palette) to restyle it.
 */
export const LIMIT_TONE = "bg-(--gk-warn) text-(--gk-edge)";

/** A station's status words, one column centred on its anchor. */
function StationBoard({
	at,
	lines,
	limitTone = LIMIT_TONE,
}: {
	at: Vec3;
	limitTone?: string;
	lines: StationLine[];
}) {
	if (lines.length === 0) {
		return null;
	}
	return (
		<group position={at}>
			<Html center zIndexRange={[18, 0]}>
				<div
					aria-hidden="true"
					className="pointer-events-none flex flex-col items-center gap-0.5"
					data-iso-plate=""
					data-station-board=""
				>
					{lines.map((line) => (
						<span
							className={cn(
								METER_TEXT_CLASS,
								line.kind === "limit" && limitTone
							)}
							data-budgeted-overlay={line.kind}
							key={line.id}
						>
							{line.text}
						</span>
					))}
				</div>
			</Html>
		</group>
	);
}

const plus = (a: Vec3, b: Vec3): Vec3 => [
	a[0] + b[0],
	a[1] + b[1],
	a[2] + b[2],
];

/** What a game's own "next" prop gets (`ActStation renderNext`). */
export interface StationNext {
	/** Where the kit's NextSign would stand. */
	at: Vec3;
	/** The agent's next scheduled run, or null (never invented). */
	run: NextRun | null;
	/** The act's next words ("Next: write tests", "Next run tomorrow 09:00"). */
	text: string | null;
}

/** The longest headline a delivered item's tag shows. */
const HEADLINE_TAG_CHARS = 32;

/**
 * The headline tag for a delivering act's item: its thread's last turn
 * headline ("Edited 3 files, ran 2 commands"), cut to HEADLINE_TAG_CHARS;
 * null when there is none or the snapshot is redacted (never invented).
 */
export function trayHeadline(
	act: InterfaceAgentAct,
	snapshot: InterfaceSnapshot
): string | null {
	if (snapshot.privacy === "redacted") {
		return null;
	}
	const headline = snapshot.threads
		.find((thread) => thread.id === act.threadId)
		?.outcome?.headline?.trim();
	if (!headline) {
		return null;
	}
	return headline.length > HEADLINE_TAG_CHARS
		? `${headline.slice(0, HEADLINE_TAG_CHARS - 1).trimEnd()}…`
		: headline;
}

/** Everything one agent's station shows for its act. */
export function ActStation({
	act,
	at,
	clock,
	focusable = true,
	iconOnly,
	layout,
	limitText,
	limitTone,
	nowMs,
	onAsk,
	onBlocker,
	pipSkin,
	privacy = "full",
	reduced,
	renderNext,
	shown,
	snapshot,
}: {
	act: InterfaceAgentAct;
	/** The station's position. */
	at: Vec3;
	clock?: ClockOptions;
	/** False in list games, whose per-agent targets are list rows. */
	focusable?: boolean;
	/** The overlay budget's `iconOnly`. */
	iconOnly: boolean;
	/** Overrides for where the pieces sit. */
	layout?: Partial<StationLayout>;
	/** The game's limit wording (default: the act's "Limit hit, back 15:10"). */
	limitText?: LimitText;
	/** Class tokens for the limit line (default `LIMIT_TONE`, amber). */
	limitTone?: string;
	nowMs: number;
	onAsk: (askId: string) => void;
	/** Opens the blocker card for the thread that failed. */
	onBlocker: (threadId: string, agentName: string) => void;
	/** The game's pip colours (crops, credits...). */
	pipSkin?: PipSkin;
	privacy?: "full" | "redacted";
	reduced: boolean;
	/**
	 * The game's own "next" prop in place of the kit's NextSign (a door for
	 * tomorrow's run): given where it stands, the agent's next scheduled
	 * run (`nextRunOf`, null when none) and the act's next words.
	 */
	renderNext?: (next: StationNext) => ReactNode;
	/** The ids the overlay budget chose. */
	shown: ReadonlySet<string>;
	snapshot: InterfaceSnapshot;
}) {
	const place = { ...STATION_LAYOUT, ...layout };
	// A software rasterizer draws the station's small props without ink
	// outlines: each outline is a second draw call per mesh.
	const quality = useStageQuality();
	const claims = useMemo(() => threadClaims(snapshot), [snapshot]);
	// A stage squeezed beside a thread view keeps fewer words, and so does a
	// game the user set to minimal overlays.
	const cramped = useStageCramped();
	const { overlayDensity: density } = useGameKitSettings();
	return (
		<ActInk on={quality !== "low"}>
			<group>
				<ProgressPips3D
					at={plus(at, place.pips)}
					progress={act.progress}
					reducedMotion={reduced}
					showText={false}
					skin={pipSkin}
				/>
				{renderNext ? (
					renderNext({
						at: plus(at, place.next),
						run: nextRunOf(act.agentId, snapshot, nowMs, clock),
						text: act.next,
					})
				) : (
					<NextSign
						at={plus(at, place.next)}
						showText={false}
						text={act.next}
					/>
				)}
				<RunCue
					at={plus(at, place.cue)}
					elapsed={act.elapsed}
					longerThanUsual={act.longerThanUsual}
					reducedMotion={reduced}
					showText={false}
					stalled={act.stalled}
				/>
				<StationBoard
					at={plus(at, place.board)}
					limitTone={limitTone}
					lines={stationLines(act, shown, {
						clock,
						cramped,
						density,
						limitText,
						nowMs,
					})}
				/>
				<AlarmStack
					agentName={act.agentName}
					at={plus(at, place.alarms)}
					blockers={act.blockers}
					clock={clock}
					focusable={focusable}
					iconOnly={iconOnly}
					nowMs={nowMs}
					old={oldBlockersOf(act, snapshot, claims)}
					onOpen={(blocker) => {
						const thread = blockerThread(act, blocker, snapshot, claims);
						if (thread) {
							onBlocker(thread.id, act.agentName);
						}
					}}
					privacy={privacy}
					reducedMotion={reduced}
					rows={place.alarmRows}
					side={
						place.alarmSide && place.alarmSide !== "auto"
							? place.alarmSide
							: alarmSideFor([
									place.alarms[0] - (place.figure?.[0] ?? 0),
									place.alarms[1] - (place.figure?.[1] ?? 0),
									place.alarms[2] - (place.figure?.[2] ?? 0),
								])
					}
					step={place.alarmStep}
				/>
				{act.act === "limited" ? (
					<LimitCue
						at={plus(at, place.limit)}
						showText={false}
						text={limitWords(act, { clock, limitText, nowMs })}
					/>
				) : null}
				<UnreadMark
					asks={unreadAsksOf(act, snapshot, claims)}
					at={plus(at, place.unread)}
					focusable={focusable}
					iconOnly={iconOnly}
					nowMs={nowMs}
					onOpen={onAsk}
					ownerName={act.agentName}
					privacy={privacy}
					reducedMotion={reduced}
				/>
				<SuggestionNote
					asks={act.suggestions}
					at={plus(at, place.suggestion)}
					focusable={focusable}
					iconOnly={iconOnly}
					nowMs={nowMs}
					onOpen={onAsk}
					ownerName={act.agentName}
					privacy={privacy}
					reducedMotion={reduced}
				/>
				<ApprenticeTally helpers={act.helpers} station={at} />
			</group>
		</ActInk>
	);
}

/** Where the you-spot pieces sit. */
export interface YouSpotLayout {
	/** The off-stage agents' tally. */
	offStage: Vec3;
	/** Each queue point. */
	slots: Record<YouSlot, Vec3>;
	/** The "+N more" tally. */
	tally: Vec3;
	/** A queued villager's wait timer, as an offset from its slot (default [0.55, 0, 0.2]). */
	timer?: Vec3;
	/**
	 * The first tray item; the rest step along `trayStep`, at most
	 * `trayMax` to a row, further rows stepping along `trayRowStep`, so a
	 * busy tray stays in its own corner and never reaches the slots.
	 */
	tray: Vec3;
	/** Default 3. */
	trayMax?: number;
	/** Default [0, 0, -0.7]: away from the queue. */
	trayRowStep?: Vec3;
	/** Default [0.7, 0, 0]. */
	trayStep?: Vec3;
}

/** Where `count` tray items sit, wrapping every `trayMax` (see `YouSpotLayout.tray`). */
export function trayPositions(
	layout: Pick<YouSpotLayout, "tray" | "trayMax" | "trayRowStep" | "trayStep">,
	count: number
): Vec3[] {
	const step = layout.trayStep ?? [0.7, 0, 0];
	const rowStep = layout.trayRowStep ?? [0, 0, -0.7];
	const perRow = Math.max(1, Math.floor(layout.trayMax ?? 3));
	return Array.from({ length: count }, (_, index) => {
		const column = index % perRow;
		const row = Math.floor(index / perRow);
		return [
			layout.tray[0] + step[0] * column + rowStep[0] * row,
			layout.tray[1] + step[1] * column + rowStep[1] * row,
			layout.tray[2] + step[2] * column + rowStep[2] * row,
		];
	});
}

/** A game's look for the queue's wait timers (a shot clock, a fence post...). */
export interface TimerSkin {
	/** The timer's frame colour. */
	color?: string;
	/** The timer prop (default the hourglass; "candle" melts). */
	shape?: WaitTimerShape;
}

/** The you-spot queue, its tallies and the delivery tray. */
export function YouSpots({
	focusable = true,
	iconOnly,
	item,
	layout,
	nowMs,
	offStage,
	onAsk,
	onOpenQueue,
	onStage,
	owners,
	privacy = "full",
	reduced,
	shown,
	slots,
	snapshot,
	timerSkin,
	trayTag,
}: {
	focusable?: boolean;
	/** The overlay budget's `iconOnly`. */
	iconOnly: boolean;
	/** The game's deliverable (`ActSkin.deliverable`). */
	item: LifeItem;
	layout: YouSpotLayout;
	nowMs: number;
	offStage: OffStage;
	onAsk: (askId: string) => void;
	/** Opens the Queue sheet (`openQueue(openRef)`). */
	onOpenQueue: () => void;
	/** On-stage acts (`stageAgents(...).onStage`): delivering ones fill the tray. */
	onStage: readonly InterfaceAgentAct[];
	/** `askOwners(acts)`: who a notice's ask belongs to. */
	owners: ReadonlyMap<string, string>;
	privacy?: "full" | "redacted";
	reduced: boolean;
	shown: ReadonlySet<string>;
	/** `youSpotSlots(acts, unowned, onStageIds)`. */
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	snapshot: InterfaceSnapshot;
	timerSkin?: TimerSkin;
	/**
	 * "headline": each delivered item carries a tag with its answer's
	 * headline ("Edited 3 files"), when the snapshot has one (never under
	 * redaction). Default: no tag.
	 */
	trayTag?: "headline";
}) {
	const timer = layout.timer ?? [0.55, 0, 0.2];
	const delivering = onStage.filter(
		(act) => act.act === "delivering" && act.ask
	);
	const trays = trayPositions(layout, delivering.length);
	const quality = useStageQuality();
	return (
		<ActInk on={quality !== "low"}>
			<group>
				{slots.slots.map((slot) => {
					const at = layout.slots[slot.point];
					if (slot.carrier === "notice") {
						return (
							<NoticePost
								ask={slot.ask}
								at={at}
								focusable={focusable}
								key={slot.ask.id}
								nowMs={nowMs}
								onOpen={onAsk}
								ownerName={owners.get(slot.ask.id) ?? null}
								privacy={privacy}
								reducedMotion={reduced}
							/>
						);
					}
					return (
						<WaitTimer3D
							at={plus([at[0], 0, at[2]], timer)}
							color={timerSkin?.color}
							key={slot.ask.id}
							nowMs={nowMs}
							reducedMotion={reduced}
							shape={timerSkin?.shape}
							timer={{
								approx: slot.ask.sinceApprox,
								since: slot.ask.since,
								until: slot.ask.expiresAt ?? null,
								untilApprox: slot.ask.expiresApprox,
							}}
						/>
					);
				})}
				{slots.overflow > 0 && shown.has("tally:you") ? (
					<TallyPlate
						at={layout.tally}
						focusable={focusable}
						label={overflowLabel(slots.overflow)}
						onOpen={onOpenQueue}
						scope="you"
						text={`+${slots.overflow} more`}
					/>
				) : null}
				{offStage.count > 0 && shown.has("tally:off") ? (
					<TallyPlate
						at={layout.offStage}
						focusable={focusable}
						label={offStageLabel(offStage.count)}
						onOpen={onOpenQueue}
						scope="off"
						text={offStageText(offStage)}
					/>
				) : null}
				{delivering.map((act, index) => (
					<TrayItem
						ask={act.ask as InterfaceAsk}
						at={trays[index] ?? layout.tray}
						count={
							snapshot.threads.find((thread) => thread.id === act.threadId)
								?.outcome?.filesChanged ?? null
						}
						focusable={focusable}
						iconOnly={iconOnly}
						item={item}
						key={act.agentId}
						nowMs={nowMs}
						onOpen={onAsk}
						ownerName={act.agentName}
						privacy={privacy}
						reducedMotion={reduced}
						showCount={shown.has(`count:${act.agentId}`)}
						tag={trayTag === "headline" ? trayHeadline(act, snapshot) : null}
					/>
				))}
			</group>
		</ActInk>
	);
}
