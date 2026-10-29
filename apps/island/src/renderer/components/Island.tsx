import { GlassScrimCard } from "@ryu/ui/components/glasscn/glass-scrim-card.tsx";
import { Logo as RyuLogo } from "@ryu/ui/components/logo.tsx";
import { AnimatePresence, motion } from "motion/react";
import { type CSSProperties, type ReactNode, useEffect } from "react";
import {
	IslandComposerProvider,
	useIslandComposerContext,
} from "../context/island-composer-context.tsx";
import { useActiveContext } from "../hooks/use-active-context.ts";
import { useCommandSummon } from "../hooks/use-command-summon.ts";
import { useComposerShortcutBindings } from "../hooks/use-composer-shortcut-bindings.ts";
import { useContentHeight } from "../hooks/use-content-height.ts";
import { useDevStateSwitcher } from "../hooks/use-dev-state-switcher.ts";
import { useDictation } from "../hooks/use-dictation.ts";
import { useEyeCursor } from "../hooks/use-eye-cursor.ts";
import { useIslandAppearance } from "../hooks/use-island-appearance.ts";
import { useIslandMaterialMask } from "../hooks/use-island-material-mask.ts";
import { useIslandPlacement } from "../hooks/use-island-placement.ts";
import { useIslandTheme } from "../hooks/use-island-theme.ts";
import { useMeetingDetect } from "../hooks/use-meeting-detect.ts";
import { useNotch } from "../hooks/use-notch.ts";
import { useQuestDetect } from "../hooks/use-quest-detect.ts";
import { useSuggestionQueue } from "../hooks/use-suggestion-queue.ts";
import { useVoiceAgent } from "../hooks/use-voice-agent.ts";
import { useVoiceInput } from "../hooks/use-voice-input.ts";
import { useVoiceMode } from "../hooks/use-voice-mode.ts";
import { useVoiceModeShortcuts } from "../hooks/use-voice-mode-shortcuts.ts";
import { useWindowDrag } from "../hooks/use-window-drag.ts";
import type { IslandState } from "../store/island-state.ts";
import { useIslandState } from "../store/island-state.ts";
import { IslandContent } from "./IslandContent.tsx";
import {
	ACTION_CIRCLE,
	ACTION_PILL_HEIGHT,
	ACTION_PILL_WIDTH,
	CONTENT_SPRING,
	DETAIL_SIZES,
	EXPANDED_COMPACT_MAX_H,
	EXPANDED_COMPACT_MIN_H,
	EXPANDED_COMPACT_RADIUS,
	EXPANDED_COMPACT_VPAD,
	EXPANDED_COMPACT_WIDTH,
	ISLAND_SPRING,
	type IslandSize,
	islandMaterialContours,
	LOGO_CIRCLE,
	pillHeight,
	pillOverflows,
	placementAlignClass,
	SPLIT_GAP,
	SUGGESTION_STACK_GAP,
	TRANSLUCENT_INSET_STYLE,
} from "./island-config.ts";

// Keep one Island surface and add the top scrim as an overlay inside its shape.
// Translucent mode keeps its CSS glass blur; acrylic/mica keep the OS material
// supplied by the existing window underneath the same surface.
interface IslandGeometryStyle extends CSSProperties {
	"--island-gap"?: string;
	"--island-row-offset"?: string;
	"--island-stack-offset"?: string;
	"--island-surface-height"?: string;
	"--island-surface-radius"?: string;
	"--island-surface-width"?: string;
}
const actionRowGeometryStyle: IslandGeometryStyle = {
	"--island-gap": `${SPLIT_GAP}px`,
	"--island-row-offset": `${LOGO_CIRCLE.width + SPLIT_GAP}px`,
	"--island-stack-offset": `${SUGGESTION_STACK_GAP}px`,
};
const actionPillGeometryStyle: IslandGeometryStyle = {
	"--island-surface-height": `${ACTION_PILL_HEIGHT}px`,
};
const groupGeometryStyle: IslandGeometryStyle = {
	"--island-gap": `${SPLIT_GAP}px`,
};
const notchSurfaceGeometryStyle: IslandGeometryStyle = {
	"--island-surface-radius": "0 0 24px 24px",
};
const circleGeometryStyle: IslandGeometryStyle = {
	"--island-surface-width": `${LOGO_CIRCLE.width}px`,
	"--island-surface-height": `${LOGO_CIRCLE.height}px`,
	"--island-surface-radius": `${LOGO_CIRCLE.radius}px`,
};

const SURFACE_BASE =
	"island-siri-border relative isolate shrink-0 overflow-hidden";
const TRANSLUCENT_SKIN = "text-foreground shadow-2xl backdrop-blur-2xl";
const ACRYLIC_SKIN = "text-foreground";

/**
 * The visible footprint (bounding box) of the island group for a given state.
 * The action islands (`dockWidth > 0`, text mode only) sit to the RIGHT of the
 * detail island, widening the row by a gap + the avatar stack. The suggestion
 * state instead splits a row of Accept/Snooze/Dismiss pills out BELOW, adding
 * height. Every other state is just the logo + detail row.
 */
function islandFootprint(
	showCircle: boolean,
	detail: IslandSize | null,
	state: IslandState,
	dockWidth: number
) {
	const circleWidth = showCircle ? LOGO_CIRCLE.width : 0;
	const detailWidth = detail ? detail.width : 0;
	const gap = showCircle && detail ? SPLIT_GAP : 0;
	const dockGap = dockWidth > 0 ? SPLIT_GAP : 0;
	const topRowWidth = circleWidth + gap + detailWidth + dockGap + dockWidth;
	const circleHeight = showCircle ? LOGO_CIRCLE.height : 0;
	const detailHeight = detail ? detail.height : 0;
	const dockHeight = dockWidth > 0 ? ACTION_CIRCLE.height : 0;
	const topRowHeight = Math.max(circleHeight, detailHeight, dockHeight);

	const belowHeight =
		state === "suggestion" ? SUGGESTION_STACK_GAP + ACTION_PILL_HEIGHT : 0;
	return {
		width: topRowWidth,
		height: topRowHeight + belowHeight,
	};
}

/** Drag/grab handle class for the detail island, by surface. */
function detailHandleClassFor(
	isTextPill: boolean,
	state: IslandState,
	scrolls: boolean
): string | null {
	if (isTextPill) {
		// Text pill: the whole surface drags + taps-to-collapse (just a label) —
		// unless the label grew past the cap and now scrolls, in which case a full
		// cover would eat the wheel. Fall back to the expanded panel's top strip so
		// the body stays scrollable (and the strip still drags + taps).
		return scrolls ? STRIP_HANDLE : COVER_HANDLE;
	}
	if (state === "suggestion") {
		// No strip, so the chip stays fully clickable; the user drags via the logo.
		return null;
	}
	if (state === "expanded") {
		// Keep the expanded grab strip above the page header, not over its controls.
		return EXPANDED_HANDLE;
	}
	// Compact non-text surfaces keep the wider strip as their drag handle.
	return STRIP_HANDLE;
}

/**
 * Inner-content layout class for the detail island, by surface. The pill surfaces
 * scroll only once their content outgrows `DETAIL_MAX_H` — while the shape is still
 * growing to fit, the container is mid-spring at the *old* height with the content
 * already at full size, so a standing `overflow-y-auto` would flash a scrollbar on
 * every grow and shrink. Centering an overflowing scroll container also clips both
 * ends (the top can never be scrolled to), so the same flag top-aligns it.
 */
function detailContentClassFor(
	isExpanded: boolean,
	state: IslandState,
	scrolls: boolean
): string {
	if (isExpanded) {
		return "flex h-full w-full items-stretch px-3 pt-4 pb-2";
	}
	const scroll = scrolls
		? "items-start overflow-y-auto"
		: "items-center overflow-hidden";
	if (state === "suggestion") {
		return `flex h-full w-full px-3 ${scroll}`;
	}
	return `flex h-full w-full justify-center px-4 ${scroll}`;
}

// Action mini-island skin. Each pill is a sibling shape of the detail island
// (so it sits outside the chip's clip and carries its own ring + shadow + blur),
// matching the glass look of the main shapes. The primary (Accept) pill gets the
// amber tint; the rest are a quieter dark glass.
const ACTION_PILL_BASE =
	"island-siri-border relative flex shrink-0 items-center justify-center overflow-hidden whitespace-nowrap rounded-full font-medium text-xs shadow-xl backdrop-blur-2xl";
const ACTION_PILL_PRIMARY =
	"bg-warning/25 text-status-warning hover:bg-warning/40";
const ACTION_PILL_DEFAULT = "bg-card/70 text-foreground hover:bg-card/85";

const COVER_HANDLE =
	"absolute inset-0 z-10 cursor-grab bg-transparent active:cursor-grabbing";
const STRIP_HANDLE =
	"absolute inset-x-0 top-0 z-10 h-9 w-full cursor-grab bg-transparent active:cursor-grabbing";
const EXPANDED_HANDLE =
	"absolute inset-x-0 top-0 z-10 h-3 w-full cursor-grab bg-transparent active:cursor-grabbing";

/**
 * Content holder for the detail island. On the pill surfaces it is the *measured*
 * node: an auto-height wrapper whose natural height drives the shape's height (see
 * `useContentHeight` — measuring anything the island itself sizes would feed the
 * animated height straight back in). The expanded panel sizes itself from the
 * composer, so it renders its children bare and is never observed.
 */
function PillBody({
	children,
	isExpanded,
	measureRef,
	state,
}: {
	children: ReactNode;
	isExpanded: boolean;
	measureRef: (node: HTMLElement | null) => void;
	state: IslandState;
}) {
	if (isExpanded) {
		return children;
	}
	// The suggestion chip lays itself out full-width; the text/recording pills are
	// centered in the shape, so the wrapper has to re-center them.
	const layout =
		state === "suggestion" ? "w-full" : "flex w-full justify-center";
	return (
		<div className={layout} ref={measureRef}>
			{children}
		</div>
	);
}

interface SuggestionAction {
	key: string;
	label: string;
	onClick: () => void;
	primary?: boolean;
}

/**
 * The suggestion actions, drawn as a row of mini-islands that split out below
 * the chip. Each pill animates open with the same width-grow morph the long
 * island uses from idle (width 0 to a fixed target, staggered so they pop one by
 * one), and is aligned under the chip (offset past the logo + gap). Accept is the
 * primary (amber) action; Snooze/Dismiss are quieter. For a meeting prompt Snooze
 * maps to dismiss, matching the prior chip behaviour. Kept as its own component
 * so the actions array + map stay out of the Island render's complexity budget.
 */
function SuggestionActionPills({
	state,
	onAccept,
	onSnooze,
	onDismiss,
	onMaterialUpdate,
}: {
	state: IslandState;
	onAccept: () => void;
	onSnooze: () => void;
	onDismiss: () => void;
	onMaterialUpdate: () => void;
}) {
	// Rendered only while a suggestion is up, so other states keep their tight
	// footprint (nothing mounts below the group otherwise).
	if (state !== "suggestion") {
		return null;
	}
	const actions: SuggestionAction[] = [
		{ key: "accept", label: "Accept", onClick: onAccept, primary: true },
		{ key: "snooze", label: "Snooze", onClick: onSnooze },
		{ key: "dismiss", label: "Dismiss", onClick: onDismiss },
	];
	return (
		<div
			className="island-gap island-row-offset island-stack-offset flex"
			style={actionRowGeometryStyle}
		>
			{actions.map((action, index) => (
				<motion.button
					animate={{ width: ACTION_PILL_WIDTH, opacity: 1 }}
					className={`${ACTION_PILL_BASE} island-surface-height ${action.primary ? ACTION_PILL_PRIMARY : ACTION_PILL_DEFAULT}`}
					data-island-material-shape=""
					initial={{ width: 0, opacity: 0 }}
					key={action.key}
					onAnimationComplete={onMaterialUpdate}
					onClick={action.onClick}
					onUpdate={onMaterialUpdate}
					style={actionPillGeometryStyle}
					transition={{ ...ISLAND_SPRING, delay: index * 0.05 }}
					type="button"
				>
					{action.label}
				</motion.button>
			))}
		</div>
	);
}

/*
 * Dynamic-island "split" shell. Unlike a single morphing pill, the island is two
 * physically separate shapes with a gap between them:
 *
 *   ( logo )      [  detail pill / panel  ]
 *
 * The leading **logo circle** is the resting shape and the tap target. Tapping it
 * splits the trailing **detail island** out beside it (the reverse of skiper-ui's
 * Skiper3, which splits out a small circle — here a long pill splits out). The
 * detail island carries the text label (`idle`/`context`), the suggestion chip,
 * or the full chat panel (`expanded`, where the circle steps aside for width).
 *
 * U4 wires the live data: the active-app context (which swaps the idle label for
 * the live app name) and the suggestion queue (which splits the suggestion chip
 * out on `suggestion:new`). The dev state switcher still works for manual QA.
 *
 * Attribution: split-morph approach adapted from Skiper UI's Skiper3 component
 * (https://skiper-ui.com, free tier). Re-implemented in-repo for the Ryu Island.
 */
export function Island() {
	return (
		<IslandComposerProvider>
			<IslandShell />
		</IslandComposerProvider>
	);
}

function IslandShell() {
	const { agentId, leftActions, sections } = useIslandComposerContext();
	const composerShortcuts = useComposerShortcutBindings();
	const state = useIslandState((store) => store.state);
	const setState = useIslandState((store) => store.setState);
	const openPanel = useIslandState((store) => store.openPanel);
	const expandedTall = useIslandState((store) => store.expandedTall);
	const composerHeight = useIslandState((store) => store.composerHeight);
	const toggleCollapse = useIslandState((store) => store.toggleCollapse);
	// A tap (press-release without drag) splits the logo circle out into the
	// detail pill, and folds it back. Drags still move the window. The toggle is a
	// no-op for the suggestion/expanded surfaces (those own their own controls).
	const drag = useWindowDrag();
	// The merged command bar: global-hotkey summon + blur dismiss + the
	// expanded-state mouse-capture gating that keeps the palette typeable.
	useCommandSummon();
	useDevStateSwitcher();
	// Drive the logo's gaze from the global cursor so the eyes track the pointer
	// anywhere on screen, not just while it is over the small island window.
	useEyeCursor();
	// Mirror the desktop's theme (preset + light/dark + radius), synced via Core.
	useIslandTheme();
	// Background treatment, synced via Core from the desktop's settings.
	const notch = useNotch();
	const background = useIslandAppearance();
	// `acrylic` and `mica` are both content-tracked native-material modes; only
	// `translucent` keeps the oversized transparent window + floating split shape.
	const material =
		notch === null && (background === "acrylic" || background === "mica");
	const surfaceClass = `${SURFACE_BASE} ${material ? ACRYLIC_SKIN : TRANSLUCENT_SKIN}`;
	const scheduleMaterialMask = useIslandMaterialMask(material);
	const placement = useIslandPlacement();

	const context = useActiveContext();
	const { active: suggestion, accept, dismiss, snooze } = useSuggestionQueue();
	// Auto-detected meetings and quest-completions surface on the same chip. A
	// proactive prompt (quest first, then meeting) takes precedence over an engine
	// suggestion, each with its own accept + dismiss; neither has a snooze, so
	// dismiss doubles for it.
	const quest = useQuestDetect();
	const meeting = useMeetingDetect();
	let proactive: {
		suggestion: typeof suggestion;
		accept: () => void;
		dismiss: () => void;
	} | null = null;
	if (quest.suggestion) {
		proactive = quest;
	} else if (meeting.suggestion) {
		proactive = meeting;
	}
	const activeSuggestion = proactive?.suggestion ?? suggestion;
	const onAccept = proactive ? proactive.accept : accept;
	const onDismiss = proactive ? proactive.dismiss : dismiss;
	const onSnooze = proactive ? proactive.dismiss : snooze;
	// Push-to-talk voice capture (global shortcut → waveform → transcript → chat).
	// `toggle` also drives the mic action island (a tap triggers voice mode, the
	// same as the shortcut); the recording state's waveform is the active indicator.
	const { levels: voiceLevels, error: voiceError } = useVoiceInput();
	// System-wide dictation on its own global shortcut: captures audio and types
	// the transcript straight into the focused native app (no chat, no focus steal).
	useDictation();
	// The routed agent that will take a dictated task, and whether Tab cycles it
	// (shown on the recording pill; rotated live via the global key hook).
	const { agentName: voiceAgentName, canCycle: voiceCanCycle } =
		useVoiceAgent();
	// Continuous voice mode (its own separate dock action — the mic above stays as
	// push-to-talk voice input). Closing it stops the session and collapses.
	const voiceMode = useVoiceMode({
		agentId: agentId.length > 0 ? agentId : undefined,
	});
	useVoiceModeShortcuts(voiceMode.active, sections, composerShortcuts);
	const handleVoiceClose = (): void => {
		voiceMode.stop();
		setState("collapsed");
	};

	// Context-driven label swap: while the pill is split out (idle), promote to
	// `context` when a live active app is available, and fall back when it goes
	// away. Never touches the collapsed/suggestion/expanded surfaces.
	const hasLiveContext = context.live && context.appName !== null;
	useEffect(() => {
		if (state === "idle" && hasLiveContext) {
			setState("context");
			return;
		}
		if (state === "context" && !hasLiveContext) {
			setState("idle");
		}
	}, [state, hasLiveContext, setState]);

	const isExpanded = state === "expanded";
	const isCollapsed = state === "collapsed";
	const isTextPill = state === "idle" || state === "context";
	// The logo circle leads the compact states. Once the chat is expanded it gives
	// the panel its own quiet header and close control, so a second circle beside
	// the card is unnecessary visual chrome.
	const showCircle = !isExpanded;
	// The expanded surface is a short composer bar until there is chat history, then
	// it grows to the full panel height. The compact bar's height tracks the
	// composer (so it stays tight on one row and grows as the draft wraps), clamped.
	const compactHeight = Math.min(
		EXPANDED_COMPACT_MAX_H,
		Math.max(EXPANDED_COMPACT_MIN_H, composerHeight + EXPANDED_COMPACT_VPAD)
	);
	const expandedSize: IslandSize = expandedTall
		? DETAIL_SIZES.expanded
		: {
				width: EXPANDED_COMPACT_WIDTH,
				height: compactHeight,
				radius: EXPANDED_COMPACT_RADIUS,
			};
	// Pill surfaces (idle/context/recording/suggestion) are sized by their content:
	// each state's `DETAIL_SIZES` height is the floor, the measured content grows the
	// shape past it, and `DETAIL_MAX_H` caps that — after which the content scrolls
	// inside the pill. The expanded panel keeps its own sizing (it already tracks the
	// composer), so it never reads the measurement.
	const pillContent = useContentHeight();
	const pillScrolls = !isExpanded && pillOverflows(pillContent.height);
	const detail =
		state === "collapsed"
			? null
			: state === "expanded"
				? expandedSize
				: {
						...DETAIL_SIZES[state],
						height: pillHeight(DETAIL_SIZES[state].height, pillContent.height),
					};

	// Report the visible footprint (logo + gap + detail bounding box, plus the
	// suggestion action row) to the main process. In the acrylic appearance the
	// window *is* the island, so main resizes the native-material window to match.
	// In either appearance, main uses the `expanded` flag to keep the expanded
	// panel on-screen (anchored to the resting island, flipped upward at the
	// bottom edge and clamped at the sides), then restores the resting position on
	// collapse — the translucent window keeps its fixed size and only moves.
	// The expanded chat is one quiet card. Attachments still live behind the
	// composer's + button, while voice and the command palette keep their global
	// shortcuts; separate action islands are reserved for compact suggestions.
	const dockWidth = 0;

	const floatingFootprint = islandFootprint(
		showCircle,
		detail,
		state,
		dockWidth
	);
	const footprintWidth = notch
		? Math.max(notch.width + 80, floatingFootprint.width)
		: floatingFootprint.width;
	const footprintHeight = notch
		? notch.height +
			(isCollapsed
				? 36
				: isExpanded
					? Math.max(220, floatingFootprint.height)
					: floatingFootprint.height)
		: floatingFootprint.height;
	const detailWidth = detail?.width ?? 0;
	const detailHeight = detail?.height ?? 0;
	const detailRadius = detail?.radius ?? 0;
	useEffect(() => {
		// Report nothing until both window facts are known: an early report would
		// size or mask the window for the wrong Background.
		if (notch === undefined || background === null) {
			return;
		}
		if (footprintWidth > 0 && footprintHeight > 0) {
			const detailContour =
				detailWidth > 0 && detailHeight > 0
					? {
							width: detailWidth,
							height: detailHeight,
							radius: detailRadius,
						}
					: null;
			window.island.win.setContentSize(
				footprintWidth,
				footprintHeight,
				isExpanded,
				notch ? [] : islandMaterialContours(showCircle, detailContour, state)
			);
			if (material) {
				scheduleMaterialMask();
			}
		}
	}, [
		notch,
		background,
		footprintWidth,
		footprintHeight,
		isExpanded,
		showCircle,
		detailWidth,
		detailHeight,
		detailRadius,
		state,
		material,
		scheduleMaterialMask,
	]);

	// Detail-island drag handle + inner layout vary by surface (see helpers).
	const detailHandleClass = detailHandleClassFor(
		isTextPill,
		state,
		pillScrolls
	);
	const detailContentClass = detailContentClassFor(
		isExpanded,
		state,
		pillScrolls
	);
	const circleLabel = isCollapsed ? "Expand Ryu island" : "Collapse Ryu island";
	const detailLabel = isTextPill ? "Open Ryu panel" : "Move island";
	// Tapping the text pill opens the full panel (chat + Store + Settings); the
	// logo circle still folds the pill back down. Other surfaces own their taps.
	const detailTap = isTextPill ? openPanel : undefined;

	if (notch === undefined || background === null) {
		return null;
	}
	if (notch) {
		const notchGeometryStyle: IslandGeometryStyle = {
			"--island-surface-height": `${notch.height}px`,
		};
		return (
			<div className="flex h-full w-full justify-center">
				<motion.div
					animate={{ width: footprintWidth, height: footprintHeight }}
					className="dark island-surface-radius flex flex-col overflow-hidden bg-black text-white"
					data-island-notch=""
					initial={false}
					onPointerEnter={drag.onPointerEnter}
					onPointerLeave={drag.onPointerLeave}
					style={notchSurfaceGeometryStyle}
					transition={ISLAND_SPRING}
				>
					<div
						aria-hidden="true"
						className="island-surface-height shrink-0"
						style={notchGeometryStyle}
					/>
					{isCollapsed || isTextPill ? (
						<button
							aria-label="Open Island"
							className="flex min-h-9 w-full flex-1 items-center justify-center gap-2 px-4 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
							onClick={openPanel}
							type="button"
						>
							<RyuLogo size="24px" variant="eyes" />
							{isCollapsed ? "" : (context.appName ?? "Ryu")}
						</button>
					) : (
						<div className="flex min-h-0 flex-1 flex-col px-3 pb-2">
							<PillBody
								isExpanded={isExpanded}
								measureRef={pillContent.ref}
								state={state}
							>
								<IslandContent
									composerControls={leftActions}
									context={context}
									onVoiceClose={handleVoiceClose}
									state={state}
									suggestion={activeSuggestion}
									voice={voiceMode}
									voiceAgentName={voiceAgentName}
									voiceCanCycle={voiceCanCycle}
									voiceError={voiceError}
									voiceLevels={voiceLevels}
									wrap={!isExpanded}
								/>
							</PillBody>
							<SuggestionActionPills
								onAccept={onAccept}
								onDismiss={onDismiss}
								onMaterialUpdate={scheduleMaterialMask}
								onSnooze={onSnooze}
								state={state}
							/>
						</div>
					)}
				</motion.div>
			</div>
		);
	}

	return (
		// The outer container fills the window; the island group is aligned to the
		// placement's anchor corner/edge (bottom-right docked -> bottom-right of the
		// window), so morphs grow away from the dock instead of from the center.
		// The flex alignment keeps the group's bounding box tight so the
		// mouse-capture region (set on the inner wrapper) does not blanket the
		// whole click-through window. In the acrylic appearance the window is
		// content-tracked, so the group sits flush with no inset.
		<div
			className={`flex h-full w-full ${placementAlignClass(placement)}`}
			style={material ? undefined : TRANSLUCENT_INSET_STYLE}
		>
			{/* Island column: the two-shape group on top + the action-pill row
			    beneath it (suggestion only). Pointer enter/leave lives on this
			    wrapper so the whole island (both shapes, the gap, and the pills)
			    captures clicks with no flicker as the pointer crosses between
			    shapes. Outside the suggestion state the row is unmounted, so the
			    captured box is exactly the group box and idle/collapsed keep their
			    tight footprint. */}
			<div
				className="flex flex-col items-start"
				onPointerEnter={drag.onPointerEnter}
				onPointerLeave={drag.onPointerLeave}
				ref={drag.hoverTarget}
			>
				<div className="island-gap flex items-start" style={groupGeometryStyle}>
					<AnimatePresence initial={false}>
						{showCircle ? (
							<motion.div
								animate={{ scale: 1, opacity: 1 }}
								className={`${surfaceClass} island-surface-width island-surface-height island-surface-radius`}
								data-island-material-shape=""
								exit={{ scale: 0.6, opacity: 0 }}
								initial={{ scale: 0.6, opacity: 0 }}
								key="logo"
								onAnimationComplete={scheduleMaterialMask}
								onUpdate={scheduleMaterialMask}
								style={circleGeometryStyle}
								transition={ISLAND_SPRING}
							>
								<GlassScrimCard
									appearance="island"
									className="h-full w-full"
									contour="round"
									material={material ? "native" : "glass"}
									surfaceClassName="h-full w-full"
								>
									<button
										aria-label={circleLabel}
										className={COVER_HANDLE}
										onPointerCancel={drag.onDragPointerCancel}
										onPointerDown={drag.onDragPointerDown}
										onPointerMove={drag.onDragPointerMove}
										onPointerUp={drag.makePointerUp(toggleCollapse)}
										type="button"
									/>
									<div className="relative z-[2] flex h-full w-full items-center justify-center">
										<RyuLogo size="34px" tone="inherit" variant="eyes" />
									</div>
								</GlassScrimCard>
							</motion.div>
						) : null}
					</AnimatePresence>

					<AnimatePresence initial={false}>
						{detail ? (
							<motion.div
								animate={{
									width: detail.width,
									height: detail.height,
									borderRadius: detail.radius,
									opacity: 1,
								}}
								className={`${surfaceClass} corner-squircle`}
								data-island-material-shape=""
								exit={{ width: 0, opacity: 0 }}
								initial={{ width: 0, opacity: 0 }}
								key="detail"
								onAnimationComplete={scheduleMaterialMask}
								onUpdate={scheduleMaterialMask}
								transition={ISLAND_SPRING}
							>
								<GlassScrimCard
									appearance="island"
									className="h-full w-full"
									contour="squircle"
									material={material ? "native" : "glass"}
									surfaceClassName="h-full w-full"
								>
									{/* Drag/grab region for the detail island (omitted for the
									    suggestion chip so the chip stays fully clickable). */}
									{detailHandleClass ? (
										<button
											aria-label={detailLabel}
											className={detailHandleClass}
											onPointerCancel={drag.onDragPointerCancel}
											onPointerDown={drag.onDragPointerDown}
											onPointerMove={drag.onDragPointerMove}
											onPointerUp={drag.makePointerUp(detailTap)}
											type="button"
										/>
									) : null}
									<AnimatePresence initial={false} mode="wait">
										<motion.div
											animate={{ opacity: 1, scale: 1, y: 0 }}
											className={detailContentClass}
											exit={{ opacity: 0, scale: 0.92, y: -6 }}
											initial={{ opacity: 0, scale: 0.92, y: 6 }}
											key={state}
											transition={CONTENT_SPRING}
										>
											<PillBody
												isExpanded={isExpanded}
												measureRef={pillContent.ref}
												state={state}
											>
												<IslandContent
													composerControls={leftActions}
													context={context}
													onVoiceClose={handleVoiceClose}
													state={state}
													suggestion={activeSuggestion}
													voice={voiceMode}
													voiceAgentName={voiceAgentName}
													voiceCanCycle={voiceCanCycle}
													voiceError={voiceError}
													voiceLevels={voiceLevels}
													wrap={!isExpanded}
												/>
											</PillBody>
										</motion.div>
									</AnimatePresence>
								</GlassScrimCard>
							</motion.div>
						) : null}
					</AnimatePresence>
				</div>

				{/* Action mini-islands split out below the chip (renders only in the
				    suggestion state, so other states keep their tight footprint). */}
				<SuggestionActionPills
					onAccept={onAccept}
					onDismiss={onDismiss}
					onMaterialUpdate={scheduleMaterialMask}
					onSnooze={onSnooze}
					state={state}
				/>
			</div>
		</div>
	);
}
