import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type InterfaceParamsByRenderer,
	resolveInterfaceParams,
	type SeasonalParams,
} from "@ryuhq/protocol/interfaces";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { GameShell, gameSheetCover } from "./game-shell.tsx";
import { actTotals } from "./game3d-acts.ts";
import { islandFor } from "./game3d-ground.tsx";
import { useGameKitSettings } from "./game3d-settings.tsx";
import { useGameNight, useIsoView, useReducedMotion } from "./game3d-stage.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import { ActAnnouncer } from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { doorActs } from "./seasonal-acts.tsx";
import { useSeasonalActors } from "./seasonal-interface-actors.tsx";
import {
	COMPACT_BELOW,
	GIFT_INSET,
	GIFT_WIDTH,
	HUD_ACTS,
	HUD_GAP,
	HUD_TOP,
	HUD_TOP_COMPACT,
	ISLAND_RIM,
	type SidePanel,
} from "./seasonal-interface-constants.tsx";
import { useSeasonalDoorKeys } from "./seasonal-interface-door-keys.ts";
import {
	useElementSize,
	useHudBottom,
	useLocalDayNow,
	useOpenedDoors,
} from "./seasonal-interface-hooks.ts";
import { SeasonalHud } from "./seasonal-interface-hud.tsx";
import {
	seasonalDoorList,
	seasonalSheet,
} from "./seasonal-interface-sheet.tsx";
import { SeasonalStage } from "./seasonal-interface-stage.tsx";
import {
	buildBoard,
	DOOR_COUNT,
	doorLabel,
	doorOfThread,
	doorOrder,
	isSeason,
	resolveSeason,
	SEASON_COPY,
	type SeasonDoor,
	todayDoor,
} from "./seasonal-model.ts";
import { BoardSkeleton } from "./seasonal-parts.tsx";
import { layoutSeasonWorld } from "./seasonal-world.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";
import { useInterfaceSetting } from "./use-interface-setting.ts";

export { localDateChanged } from "./seasonal-interface-hooks.ts";

/**
 * Seasonal: the workspace as a seasonal board, on the shared game kits
 * (game-shell.tsx, game3d-stage.tsx): a diorama fills the interface and
 * the HUD carries the title, the season, Add and the legend. Advent is a
 * snowy village square round a big advent house with 24 numbered doors and
 * windows, Halloween a night pumpkin patch of 24 numbered pumpkins, Lunar
 * New Year a lantern festival street of 24 numbered lanterns. Each place
 * is a conversation, most urgent at the lowest numbers; opening one reveals
 * a gift card, and "Open conversation" hangs the host's conversation beside
 * the board on a gift tag.
 */
type SeasonalSettings = Required<InterfaceParamsByRenderer["seasonal"]>;

/** The Seasonal board's own settings, resolved from its live params. */
export function seasonalSettings(
	params: Partial<SeasonalParams> | undefined
): SeasonalSettings {
	// SAFETY: resolveInterfaceParams fills every field (each falls back to
	// its default); only the declared type keeps them optional.
	return resolveInterfaceParams("seasonal", params) as SeasonalSettings;
}

export function SeasonalInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<SeasonalParams>) {
	const sceneId = `ss-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
	const giftId = `${sceneId}-gift`;
	const rootRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	const lastDoorRef = useRef<HTMLButtonElement | null>(null);
	const stage = useElementSize(stageRef);
	const reduceMotion = useReducedMotion() ?? false;
	const now = useLocalDayNow();

	const settings = seasonalSettings(params);
	const tl = useLiteralMessages();
	const kitSettings = useGameKitSettings();
	// The season picker keeps its choice (a setting), live from Settings.
	const [seasonSetting, setSeason] = useInterfaceSetting<
		SeasonalParams["season"]
	>(port, "season", settings.season);
	const season = resolveSeason(seasonSetting, new Date(now));
	const copy = SEASON_COPY[season];
	const today = useMemo(() => todayDoor(new Date(now), season), [now, season]);

	const actsView = useActs(snapshot);
	const { acts, enabled: actsOn, nowMs, unowned } = actsView;
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const totals = actTotals(snapshot, acts);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const queueOpener = useRef<(() => void) | null>(null);

	const [opened, updateOpened] = useOpenedDoors();
	// With acts, a door's mark follows its agent's act and it is opened once
	// its answers are read (thread.unread), not from this browser's storage.
	const marks = useMemo(
		() => (actsOn ? doorActs(snapshot, acts) : undefined),
		[acts, actsOn, snapshot]
	);
	const board = useMemo(
		() => buildBoard(snapshot, opened, today, marks),
		[snapshot, opened, today, marks]
	);

	const [gift, setGift] = useState<number | null>(null);
	const [side, setSide] = useState<SidePanel>(null);
	const [pickedAgent, setPickedAgent] = useState<string | undefined>();

	const threadOpen = threadView !== null && threadView !== undefined;
	const panelOpen = threadOpen || side !== null;
	const compact = stage.width > 0 && stage.width < COMPACT_BELOW;
	const activeDoor = threadOpen ? doorOfThread(board, activeThreadId) : null;
	const giftDoor = gift ? (board.doors[gift - 1] ?? null) : null;
	const hudRef = useRef<HTMLDivElement>(null);
	const hudBottom = useHudBottom(
		hudRef,
		stageRef,
		`${stage.width}x${stage.height}:${actsOn}:${loading}`
	);
	// With acts, the HUD's measured bottom and a gap below it; until it is
	// measured (and without acts), the usual room.
	const hudTop =
		actsOn && hudBottom > 0
			? hudBottom + HUD_GAP
			: (compact ? HUD_TOP_COMPACT : HUD_TOP) + (actsOn ? HUD_ACTS : 0);

	// The pumpkin patch is always at night; the others follow the theme.
	const themeNight = useGameNight(rootRef);
	const night = season === "halloween" || themeNight;
	const agentIds = useMemo(
		() => snapshot.agents.map((agent) => agent.id),
		[snapshot.agents]
	);
	const { looks } = useVillagerLooks(agentIds, night);
	const isoView = useIsoView();
	const world = useMemo(
		() => layoutSeasonWorld(season, actsOn, today),
		[actsOn, season, today]
	);
	const shape = useMemo(
		() =>
			islandFor(
				world.bounds.maxX - world.bounds.minX,
				world.bounds.maxZ - world.bounds.minZ,
				ISLAND_RIM
			),
		[world]
	);
	// The sheet floats over the right; the diorama refits beside it (on a
	// narrow stage the sheet covers it all).
	const cover = panelOpen && stage.width > 0 ? gameSheetCover(stage.width) : 0;
	const sheetCover = cover < stage.width ? cover : 0;
	const insets = useMemo(
		() => ({
			bottom: compact ? 64 : 80,
			left: 16,
			right: 16 + sheetCover,
			top: hudTop,
		}),
		[compact, hudTop, sheetCover]
	);

	// Close the gift card when the door it belongs to changes season or empties.
	useEffect(() => {
		if (gift && !board.doors[gift - 1]?.thread) {
			setGift(null);
		}
	}, [board.doors, gift]);

	const focusDoor = useCallback((number: number) => {
		const element = stageRef.current?.querySelector<HTMLButtonElement>(
			`[data-door="${number}"]`
		);
		element?.focus();
	}, []);

	const closeGift = useCallback(() => {
		setGift(null);
		lastDoorRef.current?.focus({ preventScroll: true });
	}, []);

	const compose = useCallback(() => {
		setGift(null);
		if (threadOpen) {
			port.closeThread();
		}
		setSide("compose");
	}, [port, threadOpen]);

	const showMore = useCallback(() => {
		setGift(null);
		if (threadOpen) {
			port.closeThread();
		}
		setSide((current) => (current === "more" ? null : "more"));
	}, [port, threadOpen]);

	const showList = useCallback(() => {
		setGift(null);
		if (threadOpen) {
			port.closeThread();
		}
		setSide((current) => (current === "all" ? null : "all"));
	}, [port, threadOpen]);

	const openThread = useCallback(
		(threadId: string) => {
			setGift(null);
			setSide(null);
			port.openThread(threadId);
		},
		[port]
	);

	const activate = useCallback(
		(number: number, element: HTMLButtonElement) => {
			lastDoorRef.current = element;
			const door = board.doors[number - 1];
			const thread = door?.thread;
			if (!(door && thread)) {
				compose();
				return;
			}
			if (gift === number) {
				setGift(null);
				return;
			}
			if (!(door.opened || actsOn)) {
				updateOpened((current) => ({
					...current,
					[thread.id]: thread.updatedAt,
				}));
			}
			setGift(number);
		},
		[actsOn, board.doors, compose, gift, updateOpened]
	);

	const reclose = useCallback(() => {
		const thread = giftDoor?.thread;
		if (thread) {
			updateOpened((current) => {
				const next = { ...current };
				delete next[thread.id];
				return next;
			});
		}
		closeGift();
	}, [closeGift, giftDoor, updateOpened]);

	const onDoorKeyDown = useSeasonalDoorKeys({
		closeGift,
		focusDoor,
		gift,
		setGift,
	});

	const closePanel = useCallback(() => {
		setSide(null);
		if (threadOpen) {
			port.closeThread();
		}
	}, [port, threadOpen]);

	// The gift card sits under the HUD, clear of it.
	const giftPosition = {
		left: GIFT_INSET,
		top: actsOn ? hudTop + HUD_GAP : hudTop + 8,
		width: Math.max(240, Math.min(GIFT_WIDTH, stage.width - GIFT_INSET * 2)),
	};
	const labelOf = (door: SeasonDoor) =>
		doorLabel(door, copy, today === door.number);
	const activeNumber = activeDoor?.number ?? null;

	const composeAgent =
		snapshot.agents.find((agent) => agent.id === pickedAgent)?.id ??
		snapshot.agents[0]?.id;

	const nextNumber =
		board.totals.threads < DOOR_COUNT ? board.totals.threads + 1 : null;

	const activeThread =
		snapshot.threads.find((item) => item.id === activeThreadId) ?? null;
	// The list reads most urgent first, the order the doors were handed out in.
	const filledDoors = doorOrder(today)
		.map((number) => board.doors[number - 1])
		.filter((door): door is SeasonDoor => Boolean(door?.thread));
	const doorList = seasonalDoorList({
		activeThreadId,
		actsOn,
		filledDoors,
		labelOf,
		now,
		openThread,
		snapshot,
		threadOpen,
	});
	const sheet = seasonalSheet({
		activeDoor,
		activeThread,
		activeThreadId,
		actsOn,
		board,
		closePanel,
		composeAgent,
		copy,
		doorList,
		nextNumber,
		now,
		openThread,
		port,
		setPickedAgent,
		setSide,
		side,
		snapshot,
		threadOpen,
		threadView,
		tl,
		totals,
	});

	const { actors, budget, cards, onAsk, onBlocker } = useSeasonalActors({
		acts,
		actsOn,
		board,
		clock,
		headingRef,
		kitSettings,
		looks,
		nowMs,
		port,
		queueOpener,
		reduceMotion,
		season,
		sheetCover,
		snapshot,
		stageWidth: stage.width,
		unowned,
		world,
	});

	const empty = !loading && board.totals.threads === 0;
	const pickSeason = (picked: unknown) => {
		if (picked === "auto" || isSeason(picked)) {
			setGift(null);
			setSeason(picked);
		}
	};

	const hud = (
		<SeasonalHud
			acts={acts}
			actsOn={actsOn}
			board={board}
			budget={budget}
			clock={clock}
			compact={compact}
			compose={compose}
			copy={copy}
			filledDoors={filledDoors}
			hudRef={hudRef}
			isoView={isoView}
			loading={loading}
			nowMs={nowMs}
			onAsk={onAsk}
			onBlocker={onBlocker}
			pickSeason={pickSeason}
			queueOpener={queueOpener}
			season={season}
			seasonSetting={seasonSetting}
			showList={showList}
			showMore={showMore}
			side={side}
			snapshot={snapshot}
			today={today}
			totals={totals}
			unowned={unowned}
		/>
	);

	return (
		<div
			className="ryu-seasonal relative flex size-full min-h-0"
			data-season={season}
			data-testid="interface-seasonal"
		>
			<GameShell
				accent="tomato"
				busy={loading}
				hud={hud}
				label={copy.board}
				rootRef={rootRef}
				sheet={sheet}
			>
				<main
					aria-label={copy.board}
					className="@container/seasonal absolute inset-0 flex min-h-0 flex-col"
				>
					{/* Focus lands here when an ask or blocker card closes on nothing. */}
					{actsOn ? (
						<h1 className="sr-only" ref={headingRef} tabIndex={-1}>
							{copy.board}
						</h1>
					) : (
						<h1 className="sr-only">{copy.board}</h1>
					)}
					{loading ? (
						<div
							className="flex min-h-0 flex-1 flex-col"
							style={{ paddingTop: hudTop }}
						>
							<BoardSkeleton />
						</div>
					) : (
						<SeasonalStage
							activate={activate}
							activeNumber={activeNumber}
							actors={actors}
							acts={acts}
							actsOn={actsOn}
							board={board}
							clock={clock}
							closeGift={closeGift}
							compose={compose}
							copy={copy}
							doorList={doorList}
							empty={empty}
							filledDoors={filledDoors}
							gift={gift}
							giftDoor={giftDoor}
							giftId={giftId}
							giftPosition={giftPosition}
							headingRef={headingRef}
							hudTop={hudTop}
							insets={insets}
							isoView={isoView}
							labelOf={labelOf}
							looks={looks}
							night={night}
							now={now}
							nowMs={nowMs}
							onAsk={onAsk}
							onBlocker={onBlocker}
							onDoorKeyDown={onDoorKeyDown}
							openThread={openThread}
							reclose={reclose}
							reduceMotion={reduceMotion}
							sceneId={sceneId}
							season={season}
							shape={shape}
							sheetCover={sheetCover}
							snapshot={snapshot}
							stageRef={stageRef}
							today={today}
							unowned={unowned}
							weather={settings.weather}
							world={world}
						/>
					)}
				</main>
				{actsOn ? <ActAnnouncer sentence={sentence} /> : null}
				{cards.element}
			</GameShell>
		</div>
	);
}
