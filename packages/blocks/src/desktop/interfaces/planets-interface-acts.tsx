import { useLiteralMessages } from "@ryu/i18n/react";
import type {
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { useMemo, useRef } from "react";
import { keepsActOverlay } from "./act-settings.ts";
import {
	actOverlays,
	actSummaryLine,
	actTotals,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import type { GameKitSettings } from "./game3d-settings.tsx";
import {
	ActAnnouncer,
	AskQueueList,
	askOwners,
	NeedYouButton,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import type { PlanetsActView } from "./planets-acts.tsx";
import {
	type ActsView,
	useActAnnouncement,
	useActClockOptions,
} from "./use-acts.ts";

/**
 * The act layer's state for the Planets: the ask cards, the overlays the
 * stage has room for, and the scene's act view.
 */
export function usePlanetsActLayer({
	actsOn,
	actsView,
	kitSettings,
	port,
	reduced,
	sceneSize,
	snapshot,
}: {
	actsOn: boolean;
	actsView: ActsView;
	kitSettings: GameKitSettings;
	port: InterfacePort;
	reduced: boolean;
	sceneSize: { width: number };
	snapshot: InterfaceSnapshot;
}) {
	const { acts, nowMs, privacy, unowned } = actsView;
	const fallbackRef = useRef<HTMLHeadingElement>(null);
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: fallbackRef,
		nowMs,
		port,
		snapshot,
	});
	const { openAsk, openBlocker } = cards;
	const slots = useMemo(() => youSpotSlots(acts, unowned), [acts, unowned]);
	const tally = actTotals(snapshot, acts);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const staged = useMemo(
		() => stageAgents(acts, Number.POSITIVE_INFINITY),
		[acts]
	);
	const stageWidth = sceneSize.width || 1280;
	const budget = overlayBudget(stageWidth, { domTargets: false });
	const shownKey = [
		...budget.fill(
			actOverlays(
				staged.onStage,
				slots,
				staged.offStage,
				staged.onStage.find((item) => item.act === "working")?.agentId ?? null,
				{ reduced }
			).filter((item) => keepsActOverlay(item, kitSettings))
		),
	]
		.sort()
		.join("|");
	const overlays = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const onAsk = (askId: string, opener?: HTMLElement) => openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => openBlocker(threadId, agentName, opener);
	const queueOpener = useRef<(() => void) | null>(null);
	const onAskRef = useRef(onAsk);
	onAskRef.current = onAsk;
	const onBlockerRef = useRef(onBlocker);
	onBlockerRef.current = onBlocker;
	const sceneActs = useMemo(
		(): PlanetsActView | null =>
			actsOn
				? {
						acts,
						clock,
						iconOnly: budget.iconOnly,
						nowMs,
						offStage: staged.offStage,
						onAsk: (askId) => onAskRef.current(askId),
						onBlocker: (threadId, agentName) =>
							onBlockerRef.current(threadId, agentName),
						onQueue: () => queueOpener.current?.(),
						onStage: staged.onStage,
						owners,
						privacy,
						shown: overlays,
						slots,
						snapshot,
						width: stageWidth,
					}
				: null,
		[
			acts,
			actsOn,
			budget.iconOnly,
			clock,
			nowMs,
			overlays,
			owners,
			privacy,
			slots,
			snapshot,
			stageWidth,
			staged,
		]
	);
	/** An asking planet's plate answers its ask; the others visit. */
	const askOf = (planetId: string): string | null => {
		const act = actsOn ? acts.get(planetId) : undefined;
		return act?.act === "asking" && act.ask ? act.ask.id : null;
	};
	const actSummary = actSummaryLine(tally);
	return {
		actSummary,
		askOf,
		cards,
		clock,
		fallbackRef,
		onAsk,
		onBlocker,
		queueOpener,
		sceneActs,
		sentence,
		tally,
	};
}

export type PlanetsActLayer = ReturnType<typeof usePlanetsActLayer>;

/** The act layer's screen-reader pieces: heading, ask queue and announcer. */
export function PlanetsActA11y({
	actsView,
	layer,
	snapshot,
}: {
	actsView: ActsView;
	layer: PlanetsActLayer;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const { acts, nowMs, unowned } = actsView;
	const { actSummary, cards, clock, fallbackRef, onAsk, onBlocker, sentence } =
		layer;
	return (
		<>
			<h2 className="sr-only" ref={fallbackRef} tabIndex={-1}>
				{tl("Planets: {actSummary}.", { actSummary })}
			</h2>
			<AskQueueList
				acts={acts}
				clock={clock}
				fallbackFocus={fallbackRef}
				nowMs={nowMs}
				onAsk={onAsk}
				onBlocker={onBlocker}
				snapshot={snapshot}
				unowned={unowned}
			/>
			<ActAnnouncer sentence={sentence} />
			{cards.element}
		</>
	);
}

/** The act layer's HUD buttons: Need you and Queue. */
export function PlanetsActButtons({
	actsView,
	layer,
	phone,
	snapshot,
}: {
	actsView: ActsView;
	layer: PlanetsActLayer;
	phone: boolean;
	snapshot: InterfaceSnapshot;
}) {
	const { acts, nowMs, unowned } = actsView;
	const { clock, onAsk, onBlocker, queueOpener, tally } = layer;
	return (
		<>
			<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={tally} />
			<QueueButton
				acts={acts}
				clock={clock}
				narrow={phone}
				nowMs={nowMs}
				onAsk={onAsk}
				onBlocker={onBlocker}
				openRef={queueOpener}
				snapshot={snapshot}
				totals={tally}
				unowned={unowned}
			/>
		</>
	);
}
