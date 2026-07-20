import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import {
	IslandComposerProvider,
	useIslandComposerContext,
} from "../context/island-composer-context.tsx";
import { useActiveContext } from "../hooks/use-active-context.ts";
import { useCommandSummon } from "../hooks/use-command-summon.ts";
import { useDevStateSwitcher } from "../hooks/use-dev-state-switcher.ts";
import { useDictation } from "../hooks/use-dictation.ts";
import { useEyeCursor } from "../hooks/use-eye-cursor.ts";
import { useIslandAppearance } from "../hooks/use-island-appearance.ts";
import { useIslandTheme } from "../hooks/use-island-theme.ts";
import { useMeetingDetect } from "../hooks/use-meeting-detect.ts";
import { useQuestDetect } from "../hooks/use-quest-detect.ts";
import { useSuggestionQueue } from "../hooks/use-suggestion-queue.ts";
import { useVoiceAgent } from "../hooks/use-voice-agent.ts";
import { useVoiceInput } from "../hooks/use-voice-input.ts";
import { useVoiceMode } from "../hooks/use-voice-mode.ts";
import { useVoiceModeShortcuts } from "../hooks/use-voice-mode-shortcuts.ts";
import { useWindowDrag } from "../hooks/use-window-drag.ts";
import type { IslandState } from "../store/island-state.ts";
import { useIslandState } from "../store/island-state.ts";
import { type IslandAction, IslandActionDock } from "./IslandActionDock.tsx";
import { IslandContent } from "./IslandContent.tsx";
import { AttachIcon, CommandIcon, MicIcon, VoiceModeIcon } from "./icons.tsx";
import {
	ACTION_CIRCLE,
	ACTION_PILL_HEIGHT,
	ACTION_PILL_WIDTH,
	actionDockWidth,
	CONTENT_SPRING,
	DETAIL_SIZES,
	EXPANDED_COMPACT_MAX_H,
	EXPANDED_COMPACT_MIN_H,
	EXPANDED_COMPACT_RADIUS,
	EXPANDED_COMPACT_VPAD,
	EXPANDED_COMPACT_WIDTH,
	ISLAND_SPRING,
	type IslandSize,
	LOGO_CIRCLE,
	SPLIT_GAP,
	SUGGESTION_STACK_GAP,
} from "./island-config.ts";

// Shape styling is split into a layout base + a per-appearance "skin".
//   - translucent: a semi-transparent popover fill with an in-page blur. CSS
//     `backdrop-filter` cannot reach the desktop behind a transparent window, so
//     this is a tinted-glass look (blurs only layered island content), not a
//     true desktop blur — that is what the acrylic appearance is for.
//   - acrylic: a near-transparent fill so the window's native OS material
//     (Windows 11 acrylic / macOS vibrancy) shows through as real frosted glass.
const SHAPE_BASE =
	"island-siri-border relative shrink-0 overflow-hidden shadow-2xl";
// The "Golden Gate" Siri look: a near-black vertical gradient that fades toward
// transparent, with light text, over the in-island blur. (Translucent CSS blur
// can't reach the desktop, so this is a tinted dark glass — see file header.)
const TRANSLUCENT_SKIN =
	"bg-gradient-to-b from-neutral-950/85 via-neutral-950/65 to-neutral-900/35 text-neutral-100 backdrop-blur-2xl";
// Acrylic = REAL desktop blur from the native OS material (Win11 acrylic / macOS
// vibrancy). A *translucent* dark gradient tints that blur into the Siri look
// without negating it — keep these alphas well under 1 so the frosted desktop
// still reads through (a heavy/opaque fill would kill the material).
const ACRYLIC_SKIN =
	"bg-gradient-to-b from-black/55 via-black/40 to-black/20 text-neutral-100";

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
): { height: number; width: number } {
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
	state: IslandState
): string | null {
	if (isTextPill) {
		// Text pill: the whole surface drags + taps-to-collapse (just a label).
		return COVER_HANDLE;
	}
	if (state === "suggestion") {
		// No strip, so the chip stays fully clickable; the user drags via the logo.
		return null;
	}
	// Expanded: a top grab strip drags; the panel body stays interactive.
	return STRIP_HANDLE;
}

/** Inner-content layout class for the detail island, by surface. */
function detailContentClassFor(
	isExpanded: boolean,
	state: IslandState
): string {
	if (isExpanded) {
		return "flex h-full w-full items-stretch px-3 py-2";
	}
	if (state === "suggestion") {
		return "flex h-full w-full items-center px-3";
	}
	return "flex h-full w-full items-center justify-center px-4";
}

// Action mini-island skin. Each pill is a sibling shape of the detail island
// (so it sits outside the chip's clip and carries its own ring + shadow + blur),
// matching the glass look of the main shapes. The primary (Accept) pill gets the
// amber tint; the rest are a quieter dark glass.
const ACTION_PILL_BASE =
	"island-siri-border relative flex shrink-0 items-center justify-center overflow-hidden whitespace-nowrap rounded-full font-medium text-xs shadow-xl backdrop-blur-2xl";
const ACTION_PILL_PRIMARY =
	"bg-amber-400/25 text-amber-50 hover:bg-amber-400/40";
const ACTION_PILL_DEFAULT =
	"bg-neutral-900/70 text-neutral-200 hover:bg-neutral-800/85";

const COVER_HANDLE =
	"absolute inset-0 z-10 cursor-grab bg-transparent active:cursor-grabbing";
const STRIP_HANDLE =
	"absolute inset-x-0 top-0 z-10 h-9 w-full cursor-grab bg-transparent active:cursor-grabbing";

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
}: {
	state: IslandState;
	onAccept: () => void;
	onSnooze: () => void;
	onDismiss: () => void;
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
			className="flex"
			style={{
				gap: SPLIT_GAP,
				marginLeft: LOGO_CIRCLE.width + SPLIT_GAP,
				marginTop: SUGGESTION_STACK_GAP,
			}}
		>
			{actions.map((action, index) => (
				<motion.button
					animate={{ width: ACTION_PILL_WIDTH, opacity: 1 }}
					className={`${ACTION_PILL_BASE} ${action.primary ? ACTION_PILL_PRIMARY : ACTION_PILL_DEFAULT}`}
					initial={{ width: 0, opacity: 0 }}
					key={action.key}
					onClick={action.onClick}
					style={{ height: ACTION_PILL_HEIGHT }}
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
	const state = useIslandState((store) => store.state);
	const setState = useIslandState((store) => store.setState);
	const openPanel = useIslandState((store) => store.openPanel);
	const openVoice = useIslandState((store) => store.openVoice);
	const expandedView = useIslandState((store) => store.expandedView);
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
	const background = useIslandAppearance();
	// `acrylic` and `mica` are both content-tracked native-material modes; only
	// `translucent` keeps the oversized transparent window + floating split shape.
	const material = background === "acrylic" || background === "mica";
	const shapeClass = `${SHAPE_BASE} ${material ? ACRYLIC_SKIN : TRANSLUCENT_SKIN}`;

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
	const {
		levels: voiceLevels,
		error: voiceError,
		toggle: voiceToggle,
	} = useVoiceInput();
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
	useVoiceModeShortcuts(voiceMode.active, sections);
	const handleVoiceMode = (): void => {
		voiceMode.start();
		openVoice();
	};
	const handleVoiceClose = (): void => {
		voiceMode.stop();
		setState("collapsed");
	};
	const openCommand = useIslandState((store) => store.openCommand);
	const attachAndOpen = useIslandState((store) => store.attachAndOpen);

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
	// The logo circle leads every state — including the expanded chat panel, where
	// it stays docked to the panel's left as the Ryu island (and the tap-to-collapse
	// target). The detail island is present whenever we are not collapsed.
	const showCircle = true;
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
	const detail =
		state === "collapsed"
			? null
			: state === "expanded"
				? expandedSize
				: DETAIL_SIZES[state];

	// Report the visible footprint (logo + gap + detail bounding box, plus the
	// suggestion action row) to the main process. In the acrylic appearance the
	// window *is* the island, so main resizes the native-material window to match.
	// In either appearance, main uses the `expanded` flag to keep the expanded
	// panel on-screen (anchored to the resting island, flipped upward at the
	// bottom edge and clamped at the sides), then restores the resting position on
	// collapse — the translucent window keeps its fixed size and only moves.
	// Quick-action islands shown beside the input in text mode (the expanded chat
	// composer only — not the command palette, which is itself a text input): mic
	// drives voice mode (same toggle as the hotkey), attach stages images on the
	// composer to send as multimodal file-parts (the same Core path the desktop
	// uses), and command opens the palette.
	const handleAttach = (): void => {
		window.island.system
			.attachFiles()
			.then((files) => {
				if (files.length > 0) {
					attachAndOpen(files);
				}
			})
			.catch(() => undefined);
	};
	const actions: IslandAction[] = [
		{
			key: "voice",
			label: "Voice input",
			icon: <MicIcon />,
			onClick: voiceToggle,
		},
		{
			key: "voice-mode",
			label: "Voice mode",
			icon: <VoiceModeIcon />,
			onClick: handleVoiceMode,
		},
		{
			key: "attach",
			label: "Attach files",
			icon: <AttachIcon />,
			onClick: handleAttach,
		},
		{
			key: "command",
			label: "Command palette",
			icon: <CommandIcon />,
			onClick: openCommand,
		},
	];
	const dockVisible = isExpanded && expandedView === "panel";
	const dockWidth = dockVisible ? actionDockWidth(actions.length) : 0;

	const { width: footprintWidth, height: footprintHeight } = islandFootprint(
		showCircle,
		detail,
		state,
		dockWidth
	);
	useEffect(() => {
		if (footprintWidth > 0 && footprintHeight > 0) {
			window.island.win.setContentSize(
				footprintWidth,
				footprintHeight,
				isExpanded
			);
		}
	}, [footprintWidth, footprintHeight, isExpanded]);

	// Detail-island drag handle + inner layout vary by surface (see helpers).
	const detailHandleClass = detailHandleClassFor(isTextPill, state);
	const detailContentClass = detailContentClassFor(isExpanded, state);
	const circleLabel = isCollapsed ? "Expand Ryu island" : "Collapse Ryu island";
	const detailLabel = isTextPill ? "Open Ryu panel" : "Move island";
	// Tapping the text pill opens the full panel (chat + Store + Settings); the
	// logo circle still folds the pill back down. Other surfaces own their taps.
	const detailTap = isTextPill ? openPanel : undefined;

	return (
		// The outer container fills the window; the island group is centered
		// horizontally and pinned to the top. `items-start` keeps the group's
		// bounding box tight so the mouse-capture region (set on the inner wrapper)
		// does not blanket the whole click-through window. In the acrylic
		// appearance the window is content-tracked, so drop the top inset and let
		// the group sit flush against the (tightly wrapped) window.
		<div
			className={`flex h-full w-full items-start justify-center ${material ? "" : "pt-2"}`}
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
			>
				<div className="flex items-start" style={{ gap: SPLIT_GAP }}>
					<AnimatePresence initial={false}>
						{showCircle ? (
							<motion.div
								animate={{ scale: 1, opacity: 1 }}
								className={shapeClass}
								exit={{ scale: 0.6, opacity: 0 }}
								initial={{ scale: 0.6, opacity: 0 }}
								key="logo"
								style={{
									width: LOGO_CIRCLE.width,
									height: LOGO_CIRCLE.height,
									borderRadius: LOGO_CIRCLE.radius,
								}}
								transition={ISLAND_SPRING}
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
								<div className="flex h-full w-full items-center justify-center">
									<RyuLogo
										className="text-current"
										size="34px"
										variant="eyes"
									/>
								</div>
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
								className={shapeClass}
								exit={{ width: 0, opacity: 0 }}
								initial={{ width: 0, opacity: 0 }}
								key="detail"
								transition={ISLAND_SPRING}
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
										/>
									</motion.div>
								</AnimatePresence>
							</motion.div>
						) : null}
					</AnimatePresence>

					{/* Quick-action islands: a stacked avatar-group of round islands
					    (mic / attach / command) that split out to the RIGHT of the input
					    in text mode (the expanded composer). Bottom-aligned so they sit
					    beside the input row; absent in every other state. */}
					{dockVisible ? (
						<div className="self-end">
							<IslandActionDock actions={actions} />
						</div>
					) : null}
				</div>

				{/* Action mini-islands split out below the chip (renders only in the
				    suggestion state, so other states keep their tight footprint). */}
				<SuggestionActionPills
					onAccept={onAccept}
					onDismiss={onDismiss}
					onSnooze={onSnooze}
					state={state}
				/>
			</div>
		</div>
	);
}
