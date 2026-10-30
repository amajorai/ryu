import { GlassScrimCard } from "@ryu/ui/components/glasscn/glass-scrim-card.tsx";
import { Logo as RyuLogo } from "@ryu/ui/components/logo.tsx";
import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
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
import { useIslandFootprintReport } from "../hooks/use-island-footprint-report.ts";
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
import { useIslandState } from "../store/island-state.ts";
import { IslandContent } from "./IslandContent.tsx";
import { IslandNotchSurface } from "./IslandNotchSurface.tsx";
import { PillBody } from "./IslandShellParts.tsx";
import {
	CONTENT_SPRING,
	DETAIL_SIZES,
	EXPANDED_COMPACT_HEADER,
	EXPANDED_COMPACT_MAX_H,
	EXPANDED_COMPACT_MIN_H,
	EXPANDED_COMPACT_RADIUS,
	EXPANDED_COMPACT_VPAD,
	EXPANDED_COMPACT_WIDTH,
	ISLAND_SPRING,
	type IslandSize,
	pillHeight,
	pillOverflows,
	placementAlignClass,
	TRANSLUCENT_INSET_STYLE,
} from "./island-config.ts";
import {
	ACRYLIC_SKIN,
	COVER_HANDLE,
	circleGeometryStyle,
	detailContentClassFor,
	detailHandleClassFor,
	groupGeometryStyle,
	islandFootprint,
	NATIVE_SCRIM,
	SURFACE_BASE,
	TRANSLUCENT_SCRIM,
	TRANSLUCENT_SKIN,
} from "./island-shell-geometry.ts";

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
	const scrimClass = material ? NATIVE_SCRIM : TRANSLUCENT_SCRIM;
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
	// Meeting and quest prompts have no snooze; only engine suggestions offer it.
	const suggestionActions = {
		onAccept,
		onDismiss,
		onSnooze: proactive ? undefined : snooze,
	};
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
	// The chat's header sits above the composer, so the bar holds both.
	const compactHeight =
		EXPANDED_COMPACT_HEADER +
		Math.min(
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
	useIslandFootprintReport({
		background,
		detailHeight,
		detailRadius,
		detailWidth,
		footprintHeight,
		footprintWidth,
		isExpanded,
		material,
		notch,
		scheduleMaterialMask,
		showCircle,
		state,
	});

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
		return (
			<IslandNotchSurface
				appName={context.appName}
				footprintHeight={footprintHeight}
				footprintWidth={footprintWidth}
				isCollapsed={isCollapsed}
				notchHeight={notch.height}
				onOpenPanel={openPanel}
				onPointerEnter={drag.onPointerEnter}
				onPointerLeave={drag.onPointerLeave}
				showLauncher={isCollapsed || isTextPill}
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
						suggestionActions={suggestionActions}
						voice={voiceMode}
						voiceAgentName={voiceAgentName}
						voiceCanCycle={voiceCanCycle}
						voiceError={voiceError}
						voiceLevels={voiceLevels}
						wrap={!isExpanded}
					/>
				</PillBody>
			</IslandNotchSurface>
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
			{/* Island column: the two-shape group. Pointer enter/leave lives on
			    this wrapper so the whole island (both shapes and the gap) captures
			    clicks with no flicker as the pointer crosses between shapes; the
			    captured box is exactly the group box. Suggestion actions sit inside
			    the chip, so nothing mounts below the group. */}
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
									scrimClassName={scrimClass}
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
								className={surfaceClass}
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
									contour="round"
									material={material ? "native" : "glass"}
									scrimClassName={scrimClass}
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
													suggestionActions={suggestionActions}
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
			</div>
		</div>
	);
}
