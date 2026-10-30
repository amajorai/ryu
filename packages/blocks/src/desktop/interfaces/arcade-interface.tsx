import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type InterfaceAgent,
	type InterfaceParamsByRenderer,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ArcadeActView } from "./arcade-acts.tsx";
import { SlotCabinet } from "./arcade-cabinet.tsx";
import { ArcadeComposer } from "./arcade-composer.tsx";
import { ARCADE_RIM, layoutHall } from "./arcade-diorama.tsx";
import {
	useArcadeMode,
	useElementSize,
	usePageVisible,
	useSpinFeedback,
} from "./arcade-hooks.ts";
import { useArcadeStageActs } from "./arcade-interface-acts.ts";
import { useArcadeEscape } from "./arcade-interface-escape.ts";
import { ArcadeFloorView } from "./arcade-interface-floor.tsx";
import { ArcadeHud } from "./arcade-interface-hud.tsx";
import {
	arcadeFloorGeometry,
	arcadeLights,
} from "./arcade-interface-layout.ts";
import { ArcadeSheet } from "./arcade-interface-sheet.tsx";
import { ArcadeHallStage } from "./arcade-interface-stage.tsx";
import {
	buildFloor,
	composeInput,
	type Machine,
	machineForThread,
	nextJackpot,
} from "./arcade-model.ts";
import { arcadePalette } from "./arcade-palette.ts";
import { ARCADE_KEYFRAMES, ReelDefs } from "./arcade-reels.tsx";
import { GameShell } from "./game-shell.tsx";
import { actTotals } from "./game3d-acts.ts";
import { islandFor } from "./game3d-ground.tsx";
import { useFocusOnOpen, useIsoView } from "./game3d-stage.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import {
	ActAnnouncer,
	AskQueueList,
	askOwners,
	openQueue,
	useActCards,
} from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

export { arcadeLights } from "./arcade-interface-layout.ts";

/** How long the reels spin after a message goes in, before the snapshot catches up. */
const FEEDBACK_SPIN_MS = 1600;
/** The composer key for a new game (no machine picked). */
const NEW_GAME = "new-game";

/**
 * Arcade: a casino floor. Every agent is a slot machine whose three reels
 * are its latest conversations (bell: your turn, seven: working, bar:
 * waiting, cherry: done, flame: a failed run). Working machines spin, a
 * reply waiting on you lights the jackpot topper and drops a ticket in the
 * payout tray, and a failed run tilts the machine. Pulling a lever opens a
 * play slip for that agent; cashing a ticket opens the host's own
 * conversation at the redemption counter. Projects and teams are the
 * video cabinets on the back wall: pressing one narrows the floor to its
 * machines.
 */
export function ArcadeInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["arcade"]>) {
	const reduced = useReducedMotion();
	const tl = useLiteralMessages();
	const rootRef = useRef<HTMLDivElement>(null);
	const panelHeadingRef = useRef<HTMLHeadingElement>(null);
	const focusPanel = useRef(false);
	// The live settings (a bare `{}` resolves to the defaults).
	// SAFETY: resolveInterfaceParams fills every field (each falls back to
	// its default); only the declared type keeps them optional.
	const settings = resolveInterfaceParams("arcade", params) as Required<
		InterfaceParamsByRenderer["arcade"]
	>;
	const themeMode = useArcadeMode(rootRef);
	const mode = arcadeLights(settings.lights, themeMode);
	const visible = usePageVisible();
	const palette = arcadePalette(mode);
	const baseId = useId().replace(/:/g, "");
	const blurId = `arcade-blur-${baseId}`;
	const hintId = `arcade-hint-${baseId}`;
	const { spin, spinning } = useSpinFeedback(FEEDBACK_SPIN_MS);
	const floorRef = useRef<HTMLDivElement>(null);
	const floorSize = useElementSize(floorRef);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const actsView = useActs(snapshot);
	const { acts, enabled: withActs, nowMs, privacy, unowned } = actsView;
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: headingRef,
		nowMs,
		port,
		snapshot,
	});
	const queueOpener = useRef<(() => void) | null>(null);

	const [filterId, setFilterId] = useState<string | null>(null);
	/** The machine opened from its player in the hall (its cabinet sheet). */
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const isoView = useIsoView();
	const [composerFor, setComposerFor] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState("");
	/** The machine whose tray or reel the open ticket was cashed from. */
	const [cashedFrom, setCashedFrom] = useState<string | null>(null);

	const floor = useMemo(
		() => buildFloor(snapshot, filterId),
		[snapshot, filterId]
	);
	const wholeFloor = useMemo(() => buildFloor(snapshot, null), [snapshot]);
	const next = nextJackpot(floor);
	const threadOpen = threadView !== null;
	const openThread = activeThreadId
		? snapshot.threads.find((item) => item.id === activeThreadId)
		: undefined;
	const openMachine = threadOpen
		? machineForThread(wholeFloor, openThread, cashedFrom)
		: undefined;
	const composerMachine =
		composerFor && composerFor !== NEW_GAME
			? wholeFloor.machines.find((machine) => machine.id === composerFor)
			: undefined;
	const composerAgents: InterfaceAgent[] = floor.machines.map(
		(machine) => machine.agent
	);
	const selectedMachine = selectedId
		? floor.machines.find((machine) => machine.id === selectedId)
		: undefined;
	// Portrait stages (a phone) stack the rows taller: fewer cabinets each.
	const portraitFloor =
		floorSize.width > 0 && floorSize.width < floorSize.height;
	const hall = useMemo(
		() => layoutHall(floor.machines, portraitFloor, withActs),
		[floor.machines, portraitFloor, withActs]
	);
	const { budget, offStage, onStage, shown, slots } = useArcadeStageActs({
		acts,
		floor,
		floorSize,
		reduced,
		unowned,
		withActs,
	});
	const totals = actTotals(snapshot, acts);
	// Answers ready: the unread replies the act layer delivers.
	const answersReady = (snapshot.asks ?? []).filter(
		(ask) => ask.kind === "reply"
	).length;
	const owners = useMemo(() => askOwners(acts), [acts]);
	const shape = useMemo(
		() => islandFor(hall.halfWidth * 2, hall.halfDepth * 2, ARCADE_RIM),
		[hall]
	);
	const agentIds = useMemo(
		() => floor.machines.map((machine) => machine.agent.id),
		[floor.machines]
	);
	const night = mode === "dark";
	const { looks } = useVillagerLooks(agentIds, night);

	let viewKey = "";
	if (threadOpen) {
		viewKey = activeThreadId ?? "new";
	} else if (selectedMachine) {
		viewKey = `machine:${selectedMachine.id}`;
	}
	useLayoutEffect(() => {
		if (viewKey && focusPanel.current) {
			focusPanel.current = false;
			panelHeadingRef.current?.focus();
		}
	}, [viewKey]);

	const open = (threadId: string, machineId: string | null = null) => {
		focusPanel.current = true;
		setCashedFrom(machineId);
		setComposerFor(null);
		port.openThread(threadId);
	};
	const close = () => port.closeThread();
	const toggleFilter = (groupId: string) => {
		const nextId = filterId === groupId ? null : groupId;
		setFilterId(nextId);
		const group = snapshot.groups.find((item) => item.id === nextId);
		setAnnouncement(
			group
				? tl("Showing {name} machines", { name: group.name })
				: "Showing every machine"
		);
	};
	const clearFilter = () => {
		setFilterId(null);
		setAnnouncement("Showing every machine");
	};
	const newGame = () => setComposerFor(NEW_GAME);
	const selectMachine = (machineId: string) => {
		if (threadOpen) {
			close();
		}
		focusPanel.current = true;
		setSelectedId(machineId);
		const machine = floor.machines.find((item) => item.id === machineId);
		setAnnouncement(
			machine ? tl("{name}'s machine", { name: machine.name }) : ""
		);
	};
	const pull = (machine: Machine) => {
		setComposerFor(machine.id);
		setAnnouncement(tl("Lever pulled: message {name}", { name: machine.name }));
	};
	const submit = (input: { agentId?: string; prompt: string }) => {
		const machine =
			composerMachine ??
			floor.machines.find((item) => item.agent.id === input.agentId);
		setComposerFor(null);
		focusPanel.current = true;
		setCashedFrom(machine?.id ?? null);
		if (machine) {
			spin(machine.id);
			port.startThread(composeInput(machine, floor.filter, input.prompt));
			return;
		}
		port.startThread({
			agentId: input.agentId,
			projectId: floor.filter?.kind === "project" ? floor.filter.id : undefined,
			prompt: input.prompt,
			teamId: floor.filter?.kind === "team" ? floor.filter.id : undefined,
		});
	};

	/** Escape closes the play slip, then the open ticket, then the filter. */
	const stepBack = (): boolean => {
		if (composerFor !== null) {
			setComposerFor(null);
			return true;
		}
		if (threadOpen) {
			close();
			return true;
		}
		if (selectedId !== null) {
			setSelectedId(null);
			return true;
		}
		if (filterId !== null) {
			clearFilter();
			return true;
		}
		return false;
	};
	const onRootKeyDown = useArcadeEscape(rootRef, stepBack);

	const empty = !loading && floor.machines.length === 0;
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	const actView: ArcadeActView | null = withActs
		? {
				acts,
				clock,
				iconOnly: budget.iconOnly,
				nowMs,
				offStage,
				onAsk: (askId) => cards.openAsk(askId),
				onBlocker: (threadId, agentName) =>
					cards.openBlocker(threadId, agentName),
				onQueue: () => openQueue(queueOpener),
				owners,
				privacy,
				shown,
				slots,
				snapshot,
			}
		: null;
	// The sheet floats over the floor's right side; the HUD and the aisle
	// share what it leaves (on a narrow stage it covers everything).
	const { compact, filters, fit, hudWidth, sheetCover } = arcadeFloorGeometry({
		filterId,
		floor,
		floorSize,
		sheetOpen: Boolean(threadOpen || selectedMachine),
	});
	const cabinet = (machine: Machine, zoom: number, describedBy?: string) => (
		<SlotCabinet
			active={openMachine?.id === machine.id}
			activeThreadId={
				openMachine?.id === machine.id ? (activeThreadId ?? null) : null
			}
			actLabel={withActs ? acts.get(machine.agent.id)?.ariaLabel : undefined}
			agents={snapshot.agents}
			blurId={blurId}
			composing={composerFor === machine.id}
			describedBy={describedBy}
			feedback={spinning.has(machine.id)}
			machine={machine}
			onCompose={() => pull(machine)}
			onOpen={(threadId) => open(threadId, machine.id)}
			palette={palette}
			reduced={reduced}
			zoom={zoom}
		/>
	);
	const hud = (
		<ArcadeHud
			acts={acts}
			answersReady={answersReady}
			clearFilter={clearFilter}
			clock={clock}
			compact={compact}
			composerFor={composerFor}
			empty={empty}
			filterId={filterId}
			filters={filters}
			floor={floor}
			hudWidth={hudWidth}
			isoView={isoView}
			loading={loading}
			meters={settings.meters}
			newGame={newGame}
			next={next}
			nowMs={nowMs}
			onAsk={onAsk}
			onBlocker={onBlocker}
			open={open}
			palette={palette}
			queueOpener={queueOpener}
			snapshot={snapshot}
			toggleFilter={toggleFilter}
			totals={totals}
			unowned={unowned}
			withActs={withActs}
		/>
	);

	const floorView = (
		<ArcadeFloorView
			acts={acts}
			baseId={baseId}
			cabinet={cabinet}
			clearFilter={clearFilter}
			clock={clock}
			compact={compact}
			empty={empty}
			filters={filters}
			fit={fit}
			floor={floor}
			hintId={hintId}
			hudWidth={hudWidth}
			loading={loading}
			newGame={newGame}
			nowMs={nowMs}
			onAsk={onAsk}
			onBlocker={onBlocker}
			palette={palette}
			reduced={reduced}
			sheetCover={sheetCover}
			snapshot={snapshot}
			withActs={withActs}
		/>
	);
	// GameShell reads any non-null sheet as open: render one only when shown.
	const sheet =
		threadOpen || selectedMachine ? (
			<ArcadeSheet
				acts={acts}
				cabinet={cabinet}
				close={close}
				openMachine={openMachine}
				openThread={openThread}
				panelHeadingRef={panelHeadingRef}
				selectedMachine={selectedMachine}
				setSelectedId={setSelectedId}
				threadOpen={threadOpen}
				threadView={threadView}
				withActs={withActs}
			/>
		) : null;
	// The sheet's machine: the camera glides to its player when it opens.
	useFocusOnOpen(
		isoView,
		threadOpen ? (openMachine?.id ?? null) : (selectedMachine?.id ?? null)
	);
	return (
		<GameShell
			accent="grape"
			busy={loading}
			data-arcade-floor=""
			data-arcade-mode={mode}
			data-arcade-paused={visible ? undefined : "true"}
			hud={hud}
			label={
				floor.filter ? tl("{name} floor", { name: floor.filter.name }) : "Floor"
			}
			onKeyDown={onRootKeyDown}
			rootRef={rootRef}
			sheet={sheet}
			testId="interface-arcade"
		>
			<style>{ARCADE_KEYFRAMES}</style>
			{withActs ? (
				<>
					<h1 className="sr-only" ref={headingRef} tabIndex={-1}>
						Arcade
					</h1>
					<AskQueueList
						acts={acts}
						clock={clock}
						fallbackFocus={headingRef}
						nowMs={nowMs}
						onAsk={onAsk}
						onBlocker={onBlocker}
						snapshot={snapshot}
						unowned={unowned}
					/>
				</>
			) : null}
			<ReelDefs blurId={blurId} />
			<div className="absolute inset-0" ref={floorRef}>
				{loading || empty ? (
					floorView
				) : (
					<ArcadeHallStage
						actView={actView}
						compact={compact}
						filters={filters}
						floor={floor}
						floorView={floorView}
						hall={hall}
						isoView={isoView}
						looks={looks}
						mode={mode}
						next={next}
						night={night}
						onStage={onStage}
						open={open}
						portraitFloor={portraitFloor}
						reduced={reduced}
						selectedMachine={selectedMachine}
						selectMachine={selectMachine}
						shape={shape}
						sheetCover={sheetCover}
						withActs={withActs}
					/>
				)}
			</div>
			{composerFor ? (
				<ArcadeComposer
					agents={composerMachine ? undefined : composerAgents}
					key={composerFor}
					machineName={composerMachine?.name}
					onClose={() => setComposerFor(null)}
					onSubmit={submit}
					reduced={reduced}
				/>
			) : null}
			<p aria-live="polite" className="sr-only">
				{announcement}
			</p>
			{withActs ? <ActAnnouncer sentence={sentence} /> : null}
			{cards.element}
		</GameShell>
	);
}
