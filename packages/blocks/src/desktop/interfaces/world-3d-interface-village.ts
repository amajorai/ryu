import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type InterfaceAgentAct,
	type InterfaceSnapshot,
	layoutWorld,
	type ThreadStatus,
	type WorldLayout,
	type WorldPoint,
} from "@ryuhq/protocol/interfaces";
import { type RefObject, useMemo } from "react";
import { keepsActOverlay } from "./act-settings.ts";
import {
	type ActTotals,
	actOverlays,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import { queuePlateText } from "./game3d-meters.tsx";
import { useGameKitSettings } from "./game3d-settings.tsx";
import { openQueue, type useActCards } from "./interface-ask-card.tsx";
import type { ActsView, useActClockOptions } from "./use-acts.ts";
import {
	type WorldActView,
	worldActorAt,
	worldYouSpot,
} from "./world-3d-acts.tsx";
import {
	agentUrgencies,
	askTrackerGoal,
	isUrgent,
	type TrackerGoal,
	trackerGoal,
} from "./world-3d-model.ts";
import { spreadVillage } from "./world-3d-spread.ts";
import { tileToWorld, worldToTile } from "./world-3d-theme.ts";
import { CHARACTER_LIFT } from "./world-3d-village-helpers.ts";
import { layoutVillage } from "./world-village.ts";

/**
 * The village the world draws and walks: the laid-out cottages (with acts,
 * an agent works only when its act says so), the act stage, the you-spot
 * queue, and the layout as you walk it.
 */
export function useWorldVillage(
	snapshot: InterfaceSnapshot,
	actsView: ActsView,
	reducedMotion: boolean
) {
	const { acts, enabled: withActs, unowned } = actsView;
	// With acts an agent works (lit windows, sparkles, plate dots, the
	// minimap's count) only when its act says so.
	// Keyed by who works, not by the acts map (a new one every second), so
	// the village only rebuilds when that changes.
	const workingKey = withActs
		? [...acts.values()]
				.filter((act) => act.act === "working")
				.map((act) => act.agentId)
				.sort()
				.join("|")
		: null;
	const layout = useMemo(() => {
		const laid = layoutWorld(snapshot);
		if (workingKey === null) {
			return laid;
		}
		const working = new Set(workingKey.split("|"));
		return {
			...laid,
			entities: laid.entities.map((entity) => {
				let status = entity.status;
				if (working.has(entity.agentId)) {
					status = "working";
				} else if (status === "working") {
					status = "idle";
				}
				return { ...entity, status };
			}),
		};
	}, [snapshot, workingKey]);
	const village = useMemo(() => layoutVillage(layout), [layout]);
	const spread = useMemo(
		() => spreadVillage(layout, village),
		[layout, village]
	);
	// The canvas act stage: every agent with a cottage is on stage.
	const placed = useMemo(
		() => new Set(layout.entities.map((entity) => entity.agentId)),
		[layout]
	);
	const staged = useMemo(() => {
		const inWorld = new Map(
			[...acts].filter(([agentId]) => placed.has(agentId))
		);
		return stageAgents(inWorld, Number.POSITIVE_INFINITY);
	}, [acts, placed]);
	const slots = useMemo(
		() =>
			youSpotSlots(
				acts,
				unowned,
				staged.onStage.map((act) => act.agentId)
			),
		[acts, staged, unowned]
	);
	// The village as you walk it: with acts an asking villager is drawn in
	// your queue, so you bump into, stand by and answer it there, not at its
	// empty cottage (see VillageScene's `members`).
	const actLayout = useMemo(() => {
		if (!withActs) {
			return layout;
		}
		const you = worldYouSpot(layout);
		return {
			...layout,
			entities: layout.entities.map((entity) => {
				const act = acts.get(entity.agentId);
				if (act?.act !== "asking") {
					return entity;
				}
				const at = worldActorAt(
					act,
					tileToWorld(layout, entity, CHARACTER_LIFT),
					you.points,
					slots.slots,
					reducedMotion
				);
				return { ...entity, ...worldToTile(layout, at) };
			}),
		};
	}, [acts, layout, reducedMotion, slots, withActs]);
	return { actLayout, layout, placed, slots, spread, staged, village };
}

/** Agents whose most urgent conversation (or act) asks for the user. */
export function useUrgentStatuses(
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	threads: InterfaceSnapshot["threads"],
	withActs: boolean
): ReadonlyMap<string, ThreadStatus> {
	return useMemo(() => {
		const statuses = new Map<string, ThreadStatus>();
		if (withActs) {
			// With acts the plates flag what the acts say: an ask, a stop.
			for (const act of acts.values()) {
				if (act.act === "asking") {
					statuses.set(act.agentId, "your-turn");
				} else if (
					act.act === "blocked" &&
					act.blockers[0]?.kind !== "interrupted"
				) {
					statuses.set(act.agentId, "attention");
				}
			}
			return statuses;
		}
		for (const [agentId, urgency] of agentUrgencies(threads)) {
			if (isUrgent(urgency.status)) {
				statuses.set(agentId, urgency.status);
			}
		}
		return statuses;
	}, [acts, threads, withActs]);
}

interface WorldGoalInput {
	layout: WorldLayout;
	loading: boolean;
	nowMs: number;
	placed: ReadonlySet<string>;
	player: WorldPoint;
	privacy: ActsView["privacy"];
	snapshot: InterfaceSnapshot;
	totals: ActTotals;
	withActs: boolean;
}

/** What the quest tracker points at, with or without the act layer. */
export function useWorldGoal({
	layout,
	loading,
	nowMs,
	placed,
	player,
	privacy,
	snapshot,
	totals,
	withActs,
}: WorldGoalInput): TrackerGoal {
	const tl = useLiteralMessages();
	// With acts the tracker leads to the first blocking ask, else it sums up.
	if (!withActs) {
		return trackerGoal({
			entities: layout.entities,
			loading,
			player,
			threads: snapshot.threads,
			tl,
		});
	}
	return (
		askTrackerGoal(
			snapshot.asks ?? [],
			snapshot.agents,
			privacy,
			(ask, name) =>
				queuePlateText(
					name,
					{
						approx: ask.sinceApprox,
						since: ask.since,
						until: ask.expiresAt ?? null,
						untilApprox: ask.expiresApprox,
					},
					nowMs
				).slice(name.length),
			placed
		) ?? {
			agentId: null,
			agentName: null,
			detail: "",
			status: null,
			// Asks nobody owns wait in the queue; the summary line beside it
			// already counts them, so the tracker never repeats it.
			title: (() => {
				if (loading) {
					return tl("Loading agents");
				}
				return totals.needYou > 0
					? tl("Open the queue to see what needs you")
					: tl("Nothing needs you right now");
			})(),
		}
	);
}

interface WorldActViewInput {
	actsView: ActsView;
	cards: Pick<ReturnType<typeof useActCards>, "openAsk" | "openBlocker">;
	clock: ReturnType<typeof useActClockOptions>;
	mapRef: RefObject<HTMLDivElement | null>;
	owners: ReadonlyMap<string, string>;
	queueOpener: RefObject<(() => void) | null>;
	reducedMotion: boolean;
	slots: ReturnType<typeof youSpotSlots>;
	snapshot: InterfaceSnapshot;
	staged: ReturnType<typeof stageAgents>;
	stageWidth: number;
	talking: boolean;
}

/** The canvas act layer's view: who is shown, their props and handlers. */
export function useWorldActView({
	actsView,
	cards,
	clock,
	mapRef,
	owners,
	queueOpener,
	reducedMotion,
	slots,
	snapshot,
	staged,
	stageWidth,
	talking,
}: WorldActViewInput): WorldActView | null {
	const { acts, enabled: withActs, nowMs, privacy } = actsView;
	// The kit settings (overlay density, work bubbles) for its own pieces too.
	const kitSettings = useGameKitSettings();
	const stageBudget = overlayBudget(stageWidth, { domTargets: false });
	const shownKey = withActs
		? [
				...stageBudget.fill(
					actOverlays(staged.onStage, slots, staged.offStage, null, {
						reduced: reducedMotion,
					}).filter((item) => keepsActOverlay(item, kitSettings))
				),
			]
				.sort()
				.join("|")
		: "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const { openAsk: openAskCard, openBlocker: openBlockerCard } = cards;
	return useMemo<WorldActView | null>(
		() =>
			withActs
				? {
						acts,
						clock,
						iconOnly: stageBudget.iconOnly,
						nowMs,
						offStage: staged.offStage,
						// Cards opened from the canvas return focus to the map.
						onAsk: (askId) => openAskCard(askId, mapRef.current ?? undefined),
						onBlocker: (threadId, agentName) =>
							openBlockerCard(threadId, agentName, mapRef.current ?? undefined),
						onQueue: () => openQueue(queueOpener),
						onStage: staged.onStage,
						owners,
						privacy,
						shown,
						slots,
						snapshot,
						talking,
					}
				: null,
		[
			acts,
			clock,
			nowMs,
			mapRef,
			openAskCard,
			openBlockerCard,
			owners,
			privacy,
			shown,
			slots,
			snapshot,
			staged,
			stageBudget.iconOnly,
			withActs,
			talking,
		]
	);
}
