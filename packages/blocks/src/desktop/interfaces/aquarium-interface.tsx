import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { AnimatePresence } from "motion/react";
import {
	type KeyboardEvent,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { TankFilling } from "./aquarium-filling.tsx";
import { useThemeColors, useWebGLSupport } from "./aquarium-hooks.ts";
import { useAquariumActs } from "./aquarium-interface-acts.ts";
import { AquariumFooter } from "./aquarium-interface-footer.tsx";
import { AquariumHeader } from "./aquarium-interface-header.tsx";
import {
	AquariumEmptyTank,
	AquariumNoWebGL,
} from "./aquarium-interface-overlays.tsx";
import { escapeIsFree, summaryParts } from "./aquarium-interface-summary.ts";
import { buildCreatures, tankSummary } from "./aquarium-model.ts";
import { cssColor, tankPalette } from "./aquarium-palette.ts";
import {
	AquariumPanel,
	AquariumPanelActs,
	type AquariumPanelView,
} from "./aquarium-panel.tsx";
import { AquariumTank, CreatureList } from "./aquarium-tank.tsx";
import { ensureGameDisplayFont } from "./game-font.ts";
import { GameShell, gameSheetCover } from "./game-shell.tsx";
import { actSummaryLine } from "./game3d-acts.ts";
import { useIsoView } from "./game3d-stage.tsx";
import { ActAnnouncer, AskQueueList } from "./interface-ask-card.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/** Creature hues in the art palette (both moods have the same count). */
const HUE_COUNT = 8;

type Selection =
	| { agentId: string; kind: "agent" }
	| { kind: "unassigned" }
	| null;

/**
 * Aquarium: a glass reef tank on the game kit's island (aquarium-diorama.tsx).
 * Each agent is a toon creature (reef fish, angelfish, jellyfish, sea turtle
 * or manta ray, picked from its id) in its own colors, swimming around its
 * own spot: high with a bubble trail while it works, low over the reef when
 * idle, carrying a pearl when a thread needs attention. Its kit name plate
 * (or Tab and Enter on the creature list) opens its card beside the tank,
 * with its threads and a composer that messages it. An open thread is the
 * host's own conversation, shown in the same panel.
 */
export function AquariumInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["aquarium"]>) {
	const tl = useLiteralMessages();
	const panelId = useId();
	const reduceMotion = useReducedMotion();
	const rootRef = useRef<HTMLDivElement>(null);
	const theme = useThemeColors(rootRef);
	const palette = useMemo(() => tankPalette(theme), [theme]);
	const webgl = useWebGLSupport();
	const creatures = useMemo(
		() => (loading ? [] : buildCreatures(snapshot, HUE_COUNT)),
		[loading, snapshot]
	);
	const summary = useMemo(() => tankSummary(snapshot), [snapshot]);
	const [selection, setSelection] = useState<Selection>(null);
	const isoView = useIsoView();
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const [rootWidth, setRootWidth] = useState(0);
	useEffect(() => {
		ensureGameDisplayFont();
	}, []);
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root) {
			return;
		}
		const measure = () => setRootWidth(root.clientWidth);
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(root);
		return () => observer.disconnect();
	}, []);
	/** The 3D scene has drawn its first frame (its chunk and shaders are ready). */
	const [rendered, setRendered] = useState(false);
	const [announcement, setAnnouncement] = useState("");
	const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
	const headingRef = useRef<HTMLHeadingElement>(null);
	const focusHeading = useRef(false);
	const returnFocusTo = useRef<string | null>(null);

	const threadOpen = threadView !== null;
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const selectedCreature =
		selection?.kind === "agent"
			? creatures.find((creature) => creature.id === selection.agentId)
			: undefined;
	// The open thread belongs to the agent it was opened from, else its first agent.
	const contextCreature =
		selectedCreature ??
		creatures.find((creature) => creature.id === activeThread?.agentIds[0]);

	let view: AquariumPanelView | null = null;
	if (threadOpen) {
		view = { creature: contextCreature, kind: "thread", thread: activeThread };
	} else if (selectedCreature) {
		view = { creature: selectedCreature, kind: "agent" };
	} else if (selection?.kind === "unassigned") {
		view = { kind: "unassigned" };
	}
	const highlightId =
		view && view.kind !== "unassigned" ? (view.creature?.id ?? null) : null;
	const viewKey = view
		? `${view.kind}:${highlightId ?? ""}:${activeThreadId ?? ""}`
		: "";

	// Move focus into the panel when the user opens or switches it, so
	// keyboard users land on what they asked for.
	useLayoutEffect(() => {
		if (!(viewKey && focusHeading.current)) {
			return;
		}
		focusHeading.current = false;
		headingRef.current?.focus();
	}, [viewKey]);

	// Closing the panel removes whatever had focus inside it; return focus to
	// the creature it was about instead of dropping it to <body>.
	useLayoutEffect(() => {
		if (viewKey || !returnFocusTo.current) {
			return;
		}
		const target = buttonRefs.current.get(returnFocusTo.current);
		returnFocusTo.current = null;
		const active = document.activeElement;
		if (
			active &&
			active !== document.body &&
			rootRef.current?.contains(active)
		) {
			return;
		}
		target?.focus();
	}, [viewKey]);

	const selectAgent = (agentId: string) => {
		const creature = creatures.find((item) => item.id === agentId);
		if (threadOpen) {
			port.closeThread();
		}
		focusHeading.current = true;
		setSelection({ agentId, kind: "agent" });
		setAnnouncement(creature ? `${creature.name} selected` : "");
	};
	const openThread = (threadId: string) => {
		focusHeading.current = true;
		port.openThread(threadId);
	};
	const back = () => {
		port.closeThread();
		focusHeading.current = true;
		if (contextCreature) {
			setSelection({ agentId: contextCreature.id, kind: "agent" });
		} else if (selection?.kind !== "unassigned") {
			returnFocusTo.current = null;
			setSelection(null);
		}
	};
	const close = () => {
		returnFocusTo.current = highlightId;
		if (threadOpen) {
			port.closeThread();
		}
		setSelection(null);
		setAnnouncement("Panel closed");
	};
	const message = (agentId: string, prompt: string) => {
		focusHeading.current = true;
		setSelection({ agentId, kind: "agent" });
		port.startThread({ agentId, prompt });
	};
	/** A click in open water puts down the agent card (an open thread stays). */
	const dismiss = () => {
		if (threadOpen || !view) {
			return;
		}
		returnFocusTo.current = null;
		setSelection(null);
	};
	const openUnassigned = () => {
		if (threadOpen) {
			port.closeThread();
		}
		focusHeading.current = true;
		setSelection({ kind: "unassigned" });
	};

	/** Escape steps back out of a thread, then closes the panel. */
	const stepBack = (): boolean => {
		if (threadOpen) {
			back();
			return true;
		}
		if (view) {
			close();
			return true;
		}
		return false;
	};
	const stepBackRef = useRef(stepBack);
	stepBackRef.current = stepBack;

	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key !== "Escape" ||
			event.defaultPrevented ||
			!escapeIsFree(event.target)
		) {
			return;
		}
		if (stepBackRef.current()) {
			event.preventDefault();
		}
	};

	// Escape with nothing focused (after a click in the water) still closes.
	useEffect(() => {
		const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				event.target !== document.body
			) {
				return;
			}
			if (stepBackRef.current()) {
				event.preventDefault();
			}
		};
		document.addEventListener("keydown", onDocumentKeyDown);
		return () => document.removeEventListener("keydown", onDocumentKeyDown);
	}, []);

	const actsLayer = useAquariumActs({
		creatures,
		loading,
		port,
		reduceMotion,
		rootWidth,
		snapshot,
	});
	const {
		acts,
		actsOn,
		cards,
		clock,
		fallbackRef,
		nowMs,
		onAsk,
		onBlocker,
		listActs,
		sceneCreatures,
		sentence,
		tally,
		tankActs,
		unowned,
	} = actsLayer;

	const isEmpty = !loading && snapshot.agents.length === 0;
	const now = Date.now();
	const parts = summaryParts(summary, tl);
	// The HUD tightens on a narrow tank (a phone, or beside the open panel).
	const compactHud = view !== null || (rootWidth > 0 && rootWidth < 720);
	// The tank frames itself beside an open card, unless the card covers the
	// whole stage (a phone): then the tank keeps the stage, out of sight.
	const sheetCover = view ? gameSheetCover(rootWidth) : 0;
	const sheetFrame = sheetCover < rootWidth ? sheetCover : 0;
	let tankLabel = tl("Underwater reef with {parts}", {
		parts: parts.map((part) => part.text).join(", "),
	});
	if (loading) {
		tankLabel = "Aquarium, filling the tank";
	} else if (actsOn) {
		tankLabel = tl("Underwater reef: {summary}", {
			summary: actSummaryLine(tally),
		});
	}
	const webglMissing = webgl?.supported === false;
	// Until the reef has drawn (the 3D chunk loads and its shaders compile)
	// the water shows a filling state rather than an empty tank.
	const filling =
		loading || webgl === null || (webgl.supported && !rendered && !isEmpty);

	return (
		<GameShell
			accent="sky"
			busy={loading}
			data-mode={palette.mode}
			hud={
				<>
					<AquariumHeader
						actsLayer={actsLayer}
						loading={loading}
						parts={parts}
						port={port}
						rootWidth={rootWidth}
						snapshot={snapshot}
					/>
					<CreatureList
						actLayer={listActs}
						buttonRefs={buttonRefs}
						creatures={creatures}
						onFocusChange={setFocusedId}
						onSelect={selectAgent}
						palette={palette}
						panelId={panelId}
						sceneReady={webgl?.supported === true}
						selectedId={highlightId}
						view={isoView}
						webglMissing={webglMissing && !loading}
					/>
					{loading || isEmpty ? null : (
						<AquariumFooter
							actsLayer={actsLayer}
							compactHud={compactHud}
							isoView={isoView}
							openUnassigned={openUnassigned}
							summary={summary}
							webgl={webgl}
							webglMissing={webglMissing}
						/>
					)}
					<p aria-live="polite" className="sr-only">
						{announcement}
					</p>
					{actsOn ? <ActAnnouncer sentence={sentence} /> : null}
					{cards.element}
				</>
			}
			label="Aquarium"
			onKeyDown={onRootKeyDown}
			rootRef={rootRef}
			sheet={
				view ? (
					<AquariumPanelActs.Provider
						value={
							actsOn ? { acts, clock, nowMs, onAsk, onBlocker, snapshot } : null
						}
					>
						<AquariumPanel
							activeThreadId={activeThreadId}
							headingRef={headingRef}
							id={panelId}
							key="panel"
							now={now}
							onBack={back}
							onClose={close}
							onMessage={message}
							onOpen={openThread}
							palette={palette}
							snapshot={snapshot}
							threadView={threadView}
							view={view}
						/>
					</AquariumPanelActs.Provider>
				) : null
			}
			testId="interface-aquarium"
		>
			<h1 className="sr-only" ref={fallbackRef} tabIndex={-1}>
				Aquarium
			</h1>
			{actsOn ? (
				<>
					<p className="sr-only">
						{tl("Aquarium: {summary}.", { summary: actSummaryLine(tally) })}
					</p>
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
				</>
			) : null}
			<div
				aria-hidden="true"
				className="absolute inset-0"
				style={{
					// The water color shows while the scene loads (and without WebGL).
					background: `linear-gradient(to bottom, ${cssColor(palette.water.surface)}, ${cssColor(palette.water.mid)} 45%, ${cssColor(palette.water.deep)})`,
				}}
			/>
			<AquariumTank
				actLayer={tankActs}
				creatures={sceneCreatures}
				focusedId={focusedId}
				insets={{
					bottom: compactHud ? 72 : 96,
					left: 16,
					right: 16 + sheetFrame,
					top: compactHud ? 64 : 88,
				}}
				label={tankLabel}
				onDismiss={dismiss}
				onRendered={() => setRendered(true)}
				onSelect={selectAgent}
				palette={palette}
				reduced={reduceMotion}
				sceneReady={webgl?.supported === true}
				selectedId={highlightId}
				view={isoView}
				wallpaper={params?.wallpaper ?? "cream"}
			/>
			<AnimatePresence>
				{filling ? (
					<TankFilling
						count={loading ? 0 : creatures.length}
						key="loading"
						reduced={reduceMotion}
					/>
				) : null}
				{isEmpty ? (
					<AquariumEmptyTank
						key="empty"
						onStart={() => port.startThread({})}
						reduced={reduceMotion}
					/>
				) : null}
				{webglMissing && !loading && !isEmpty ? (
					<AquariumNoWebGL key="no-webgl" reduced={reduceMotion} />
				) : null}
			</AnimatePresence>
		</GameShell>
	);
}
