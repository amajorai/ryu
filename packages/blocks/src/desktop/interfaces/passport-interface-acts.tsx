import { useMemo, useRef } from "react";
import { keepsActOverlay } from "./act-settings.ts";
import {
	actOverlays,
	actTotals,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import type { useGameKitSettings } from "./game3d-settings.tsx";
import type { useVillagerLooks } from "./game3d-villager.tsx";
import { askOwners, openQueue, useActCards } from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import {
	actOfficers,
	deskKeeps,
	deskPaths,
	PassportActProps,
	ROOMY_DESK,
} from "./passport-acts.tsx";
import type { DeskActors, DeskLayout } from "./passport-desk.tsx";
import type { ActsView, useActClockOptions } from "./use-acts.ts";

type RendererProps = InterfaceRendererProps<unknown>;

/**
 * The act layer on the desk: the ask and blocker cards, the overlays the
 * stage has room for, the officers and the desk props (the actors).
 */
export function usePassportActors({
	acts,
	actsOn,
	clock,
	headingRef,
	kitSettings,
	layout,
	looks,
	nowMs,
	port,
	reduceMotion,
	roomWidth,
	snapshot,
	unowned,
}: {
	acts: ActsView["acts"];
	actsOn: boolean;
	clock: ReturnType<typeof useActClockOptions>;
	headingRef: { current: HTMLHeadingElement | null };
	kitSettings: ReturnType<typeof useGameKitSettings>;
	layout: DeskLayout;
	looks: ReturnType<typeof useVillagerLooks>["looks"];
	nowMs: number;
	port: RendererProps["port"];
	reduceMotion: boolean;
	roomWidth: number;
	snapshot: RendererProps["snapshot"];
	unowned: ActsView["unowned"];
}) {
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: headingRef,
		nowMs,
		port,
		snapshot,
	});
	const queueOpener = useRef<(() => void) | null>(null);
	const actTotalsNow = actTotals(snapshot, acts);
	const { offStage, onStage } = useMemo(
		() => stageAgents(acts, Number.POSITIVE_INFINITY),
		[acts]
	);
	const slots = useMemo(
		() =>
			youSpotSlots(
				acts,
				unowned,
				onStage.map((act) => act.agentId)
			),
		[acts, onStage, unowned]
	);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const budget = overlayBudget(roomWidth, { domTargets: true });
	const roomy = roomWidth >= ROOMY_DESK;
	const shownKey = [
		...budget.fill(
			actOverlays(
				onStage,
				slots,
				offStage,
				onStage.find((act) => act.act === "working")?.agentId ?? null,
				{ reduced: reduceMotion }
			).filter(
				(item) =>
					deskKeeps(item, layout, { iconOnly: budget.iconOnly, roomy }) &&
					keepsActOverlay(item, kitSettings)
			)
		),
	]
		.sort()
		.join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const actPaths = useMemo(() => deskPaths(layout), [layout]);
	const openAsk = cards.openAsk;
	const officers = useMemo(
		() =>
			actOfficers({
				acts,
				layout,
				looks,
				narrow: budget.iconOnly,
				onAsk: (askId) => openAsk(askId),
				reduced: reduceMotion,
				shown,
			}),
		[acts, budget.iconOnly, layout, looks, openAsk, reduceMotion, shown]
	);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	const actors: DeskActors | undefined = actsOn
		? {
				iconOnly: budget.iconOnly,
				officers,
				paths: actPaths,
				props: (
					<PassportActProps
						acts={acts}
						clock={clock}
						iconOnly={budget.iconOnly}
						layout={layout}
						noteIcons={!roomy}
						nowMs={nowMs}
						offStage={offStage}
						onAsk={(askId) => cards.openAsk(askId)}
						onBlocker={(threadId, agentName) =>
							cards.openBlocker(threadId, agentName)
						}
						onQueue={() => openQueue(queueOpener)}
						onStage={onStage}
						owners={owners}
						paths={actPaths}
						reduced={reduceMotion}
						shown={shown}
						slots={slots}
						snapshot={snapshot}
					/>
				),
			}
		: undefined;
	return {
		actors,
		actTotalsNow,
		budget,
		cards,
		onAsk,
		onBlocker,
		queueOpener,
	};
}
