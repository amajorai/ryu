import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceParamsByRenderer,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";
import { AnimatePresence } from "motion/react";
import { useMemo, useRef, useState } from "react";
import {
	CardTableDrawer,
	DRAWER_OVERLAY_BELOW,
	drawerWidth,
} from "./card-table-drawer.tsx";
import { type CardFlight, PlayedCardFlight } from "./card-table-hand.tsx";
import { useCardTableActs } from "./card-table-interface-acts.tsx";
import {
	escapeCloses,
	useBottomEdge,
	useClippedScrollReset,
	useDrawerFocusReturn,
	useDrawerTracking,
	useElementWidth,
	useMinuteClock,
	useStageSize,
	useTableDocumentKeys,
} from "./card-table-interface-hooks.ts";
import { CardTableHud, type TableLayout } from "./card-table-interface-hud.tsx";
import {
	ACT_RAIL_TOP,
	COMPACT_HUD_BELOW,
	DEFAULT_ROOT_WIDTH,
	HAND_PEEK,
	labelPlacement,
	RAIL_INSET,
	railFit,
	roomInsets,
	tableSummary,
} from "./card-table-interface-layout.ts";
import { CardTableProviders } from "./card-table-interface-parts.tsx";
import { CardTableRoom } from "./card-table-interface-room.tsx";
import {
	CardTableSpreadFrame,
	CardTableStage,
} from "./card-table-interface-stage.tsx";
import {
	actCardVerdicts,
	actPotThreads,
	actSeatTone,
	type CardPose,
	dealActHand,
	dealHand,
	handLayout,
	handTop,
	MAX_SEATS,
	nextDeal,
	potThreads,
	seatAgents,
	seatByActs,
	tableGeometry,
	unseatedThreads,
} from "./card-table-model.ts";
import {
	cardRoomCloth,
	ROOM_BACKGROUND,
	ROOM_MODE,
	ROOM_VARS,
} from "./card-table-palette.ts";
import type { SpreadActions } from "./card-table-spread-deck-parts.tsx";
import { GameShell } from "./game-shell.tsx";
import { actSummaryLine, stageAgents } from "./game3d-acts.ts";
import { useGameKitSettings } from "./game3d-settings.tsx";
import { useGameNight, useIsoView } from "./game3d-stage.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import { ActAnnouncer, AskQueueList } from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";
import { useInterfaceSetting } from "./use-interface-setting.ts";

/*
 * The renderer is split by responsibility into card-table-interface-*.ts(x):
 * hooks (measurements, clock, keys), layout (placement maths and the HUD
 * summary), parts (providers, skeletons, empty and flat tables), acts (the
 * act layer's wiring), hud and stage (the play areas).
 */

type CardTableSettings = Required<InterfaceParamsByRenderer["card-table"]>;

/** The Card Table's own settings, resolved from its live params. */
export function cardTableSettings(
	params: InterfaceParamsByRenderer["card-table"] | undefined
): CardTableSettings {
	// SAFETY: resolveInterfaceParams fills every field (each falls back to
	// its default); only the declared type keeps them optional.
	return resolveInterfaceParams("card-table", params) as CardTableSettings;
}

/**
 * Card Table: your agents seated around a felt table in a card room, on the
 * shared game kits (game-shell.tsx, game3d-stage.tsx): the room is a 3D
 * diorama (card-table-diorama.tsx) under the hand. Working agents take the
 * first chairs (each with an action timer), chips in front of a seat count its
 * threads, the pot in the middle holds every live run, and the threads waiting
 * on you are dealt to you as a hand of cards. Playing a card opens the host's
 * real conversation in a drawer while the table stays in view; a seat's menu
 * deals a new thread with that agent.
 */
export function CardTableInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["card-table"]>) {
	const tl = useLiteralMessages();
	const settings = cardTableSettings(params);
	const kitSettings = useGameKitSettings();
	// The Table/Cards switch keeps its choice (a setting), live from Settings.
	const [layout, setLayout] = useInterfaceSetting<TableLayout>(
		port,
		"layout",
		settings.layout
	);
	const { deck, felt } = settings;
	const look = useMemo(() => ({ deck, felt }), [deck, felt]);
	const cloth = useMemo(() => cardRoomCloth(felt, deck), [deck, felt]);
	const isSpread = layout === "spread";
	const stageRef = useRef<HTMLDivElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	useClippedScrollReset(rootRef);
	const cardRefs = useRef(new Map<string, HTMLButtonElement>());
	const closingRef = useRef(false);
	const reduceMotion = useReducedMotion();
	const { settled, size: stage } = useStageSize(stageRef);
	const { ready: rootReady, width: rootWidth } = useElementWidth(
		rootRef,
		DEFAULT_ROOT_WIDTH
	);
	const geometry = useMemo(() => tableGeometry(stage), [stage]);
	const night = useGameNight(rootRef);
	const isoView = useIsoView();
	const actsView = useActs(snapshot);
	const { acts, enabled: actsOn, nowMs, unowned } = actsView;
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const headingRef = useRef<HTMLHeadingElement>(null);
	// The act HUD (need you, queue, caption): the Cards layout starts below it.
	const actHudRef = useRef<HTMLDivElement>(null);
	const actHudBottom = useBottomEdge(actHudRef, actsOn && isSpread && !loading);
	// With acts the chairs go to the most urgent acts (stageAgents), never
	// the working-first sort, so a failure or an ask is never railed.
	const staged = useMemo(() => stageAgents(acts, MAX_SEATS), [acts]);
	const stageOrder = useMemo(
		() =>
			stageAgents(acts, Number.POSITIVE_INFINITY).onStage.map(
				(act) => act.agentId
			),
		[acts]
	);
	const { rail, seated } = useMemo(
		() =>
			actsOn
				? seatByActs(
						snapshot,
						stageOrder.slice(0, MAX_SEATS),
						stageOrder.slice(MAX_SEATS)
					)
				: seatAgents(snapshot),
		[actsOn, snapshot, stageOrder]
	);
	// With acts the cards read the acts: what is in your hand, each card's
	// suit and words, the pot (the working agents' threads).
	const verdicts = useMemo(
		() => (actsOn ? actCardVerdicts(snapshot, acts) : null),
		[acts, actsOn, snapshot]
	);
	const verdictContext = useMemo(
		() => (verdicts ? { nowMs, verdicts } : null),
		[nowMs, verdicts]
	);
	const hand = useMemo(
		() => (verdicts ? dealActHand(snapshot, verdicts) : dealHand(snapshot)),
		[snapshot, verdicts]
	);
	const running = useMemo(
		() => (actsOn ? actPotThreads(snapshot, acts) : potThreads(snapshot)),
		[acts, actsOn, snapshot]
	);
	const unseated = useMemo(() => unseatedThreads(snapshot), [snapshot]);
	const [cursorId, setCursorId] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const [flight, setFlight] = useState<CardFlight | null>(null);
	const now = useMinuteClock();
	const next = nextDeal(snapshot.events, actsOn ? nowMs : now);
	const panelOpen = threadView !== null;
	const tracking = useDrawerTracking(panelOpen);
	const overlay = rootWidth < DRAWER_OVERLAY_BELOW;
	const drawer = overlay ? rootWidth : drawerWidth(rootWidth);
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	// With acts the drawer's avatar rings from its lead agent's act.
	const leadId = activeThread?.agentIds[0];
	const leadAct = actsOn && leadId ? acts.get(leadId) : undefined;
	const isEmpty =
		!loading && snapshot.agents.length === 0 && snapshot.threads.length === 0;

	// The fan deals as many cards as stay readable; the rest are held back.
	const fan = handLayout(hand.cards.length, geometry, stage);
	const dealt = hand.cards.slice(0, fan.dealt);
	const heldThreads = useMemo(
		() => [...hand.cards.slice(fan.dealt), ...hand.heldThreads],
		[hand, fan.dealt]
	);
	const railLayout = railFit(
		geometry,
		stage,
		rail.length,
		actsOn ? ACT_RAIL_TOP : RAIL_INSET
	);
	const agentIds = useMemo(() => seated.map((seat) => seat.agent.id), [seated]);
	const { looks } = useVillagerLooks(agentIds, night);
	// Phones tuck the hand into a compact fan that peeks over the bottom
	// edge (rank, suit and status of every card); a tap opens it.
	const [handOpen, setHandOpen] = useState(false);
	const openTop = handTop(fan.dealt, geometry, stage, fan.spread);
	const handTuck =
		geometry.compact && dealt.length > 0
			? Math.max(
					0,
					Math.round(stage.height - geometry.card.height * HAND_PEEK - openTop)
				)
			: 0;
	const tucked = handOpen ? 0 : handTuck;
	// The room fits above the hand (or the empty hand's note), framed above
	// the tucked fan on phones so opening it never moves the camera.
	const handEdge = dealt.length > 0 ? openTop + handTuck : stage.height - 72;
	const insets = useMemo(
		() => roomInsets(stage.height, handEdge, geometry.compact, actsOn),
		[actsOn, geometry.compact, handEdge, stage.height]
	);

	const open = (threadId: string) => {
		const title = snapshot.threads
			.find((item) => item.id === threadId)
			?.title.trim();
		setAnnouncement(
			title ? tl("Opened {title}", { title }) : tl("Opened thread")
		);
		port.openThread(threadId);
	};
	const play = (threadId: string, pose: CardPose) => {
		setHandOpen(false);
		const thread = snapshot.threads.find((item) => item.id === threadId);
		const stageElement = stageRef.current;
		if (thread && stageElement && !reduceMotion) {
			const left = stageElement.offsetLeft;
			const top = stageElement.offsetTop;
			// Toward the drawer's edge (or the middle, when it covers the table).
			const edge = overlay ? rootWidth / 2 : rootWidth - drawer;
			setFlight({
				from: { ...pose, x: pose.x + left, y: pose.y + top },
				thread,
				to: {
					x: edge - geometry.card.width * 0.35,
					y: top + pose.y - geometry.card.height * 0.9,
				},
			});
		}
		open(threadId);
	};
	const deal = (agentId?: string) => {
		port.startThread(agentId ? { agentId } : {});
	};
	const close = () => {
		closingRef.current = true;
		port.closeThread();
	};

	const actions: SpreadActions = {
		activeThreadId,
		now,
		onDeal: deal,
		onOpen: open,
		snapshot,
	};

	useDrawerFocusReturn({ cardRefs, closingRef, cursorId, panelOpen, rootRef });

	useTableDocumentKeys({
		activeThreadId,
		cardRefs,
		close,
		cursorId,
		dealt,
		isSpread,
		panelOpen,
		rootRef,
		setCursorId,
	});

	const onRootKeyDown = escapeCloses(panelOpen, close);

	const tableActs = useCardTableActs({
		actsView,
		clock,
		dealer: next !== undefined,
		headingRef,
		kitSettings,
		looks,
		port,
		reduceMotion,
		seated,
		snapshot,
		staged,
		stageWidth: stage.width,
	});
	const { cards, railActs, roomActors, seatAct } = tableActs;
	const summary =
		actsOn && !loading
			? actSummaryLine(tableActs.totals)
			: tableSummary(
					loading
						? null
						: {
								agents: snapshot.agents.length,
								running: running.length,
								waiting: hand.cards.length + hand.held,
							},
					tl
				);

	const room = (
		<CardTableRoom
			actions={actions}
			actors={roomActors}
			actsOn={actsOn}
			clock={clock}
			cloth={cloth}
			geometry={geometry}
			insets={insets}
			isEmpty={isEmpty}
			isoView={isoView}
			looks={looks}
			next={next}
			night={night}
			now={now}
			nowMs={nowMs}
			onDeal={() => deal()}
			onOpen={open}
			reduceMotion={reduceMotion}
			running={running}
			seatAct={seatAct}
			seated={seated}
			snapshot={snapshot}
			stage={stage}
		/>
	);

	return (
		<GameShell
			accent="leaf"
			busy={loading}
			label="Card Table"
			onKeyDown={onRootKeyDown}
			rootRef={rootRef}
			testId="interface-card-table"
		>
			<CardTableProviders look={look} verdicts={verdictContext}>
				<div
					className={cn("absolute inset-0 flex", ROOM_MODE)}
					style={{ ...ROOM_VARS, backgroundImage: ROOM_BACKGROUND }}
				>
					<section
						aria-label="Card Table"
						className="relative flex min-h-0 min-w-0 flex-1 flex-col"
					>
						<CardTableHud
							actHudRef={actHudRef}
							actions={actions}
							acts={acts}
							actsOn={actsOn}
							clock={clock}
							compact={
								rootWidth - (panelOpen && !overlay ? drawer : 0) <
								COMPACT_HUD_BELOW
							}
							headingRef={headingRef}
							layout={layout}
							loading={loading}
							nowMs={nowMs}
							onDeal={() => deal()}
							onLayout={setLayout}
							rail={rail}
							railCollapsed={railLayout.collapsed}
							rootWidth={rootWidth}
							snapshot={snapshot}
							staged={staged}
							summary={summary}
							tableActs={tableActs}
							unowned={unowned}
							unseated={unseated}
						/>
						{actsOn && !loading ? (
							<AskQueueList
								acts={acts}
								clock={clock}
								fallbackFocus={headingRef}
								nowMs={nowMs}
								onAsk={tableActs.onAsk}
								onBlocker={tableActs.onBlocker}
								snapshot={snapshot}
								unowned={unowned}
							/>
						) : null}
						{isSpread ? (
							<CardTableSpreadFrame
								actHudBottom={actHudBottom}
								actions={actions}
								isEmpty={isEmpty}
								loading={loading}
								panelOpen={panelOpen}
								spreadActs={tableActs.spreadActs}
							/>
						) : (
							<CardTableStage
								actions={actions}
								actsOn={actsOn}
								animate={settled && !tracking}
								announcement={announcement}
								geometry={geometry}
								hand={{
									activeThreadId,
									cardRefs,
									cursorId,
									dealt,
									fan,
									held: heldThreads.length,
									heldThreads,
									label: labelPlacement(fan, geometry, stage),
									onCursor: setCursorId,
									onPlay: play,
									onTuck: handTuck > 0 ? setHandOpen : undefined,
									tucked,
								}}
								isEmpty={isEmpty}
								isoView={isoView}
								loading={loading}
								now={now}
								onDeal={() => deal()}
								rail={rail}
								railActs={railActs}
								railLayout={railLayout}
								railTop={actsOn ? ACT_RAIL_TOP : undefined}
								room={room}
								snapshot={snapshot}
								stage={stage}
								stageRef={stageRef}
								unseated={unseated}
							/>
						)}
					</section>
					<AnimatePresence initial={false}>
						{panelOpen ? (
							<CardTableDrawer
								actTone={leadAct ? actSeatTone(leadAct) : undefined}
								instant={!rootReady}
								key="drawer"
								now={now}
								onClose={close}
								overlay={overlay}
								snapshot={snapshot}
								thread={activeThread}
								threadView={threadView}
								width={drawer}
							/>
						) : null}
					</AnimatePresence>
					{flight && !isSpread ? (
						<PlayedCardFlight
							flight={flight}
							geometry={geometry}
							key={flight.thread.id}
							now={now}
							onDone={() => setFlight(null)}
							snapshot={snapshot}
						/>
					) : null}
				</div>
			</CardTableProviders>
			{actsOn ? <ActAnnouncer sentence={sentence} /> : null}
			{cards.element}
		</GameShell>
	);
}
