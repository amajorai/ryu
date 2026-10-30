import { AnimatePresence } from "motion/react";
import type { ReactNode } from "react";
import type { IslandSuggestion } from "../../shared/ipc.ts";
import type { ActiveContext } from "../hooks/use-active-context.ts";
import type { VoiceMode } from "../hooks/use-voice-mode.ts";
import type { IslandState } from "../store/island-state.ts";
import { useIslandState } from "../store/island-state.ts";
import { ContextPill } from "./ContextPill.tsx";
import { IslandCommand } from "./command/IslandCommand.tsx";
import { ExpandedPanel } from "./ExpandedPanel.tsx";
import { IslandMorphingPage } from "./IslandMorphingPage.tsx";
import {
	type IslandSuggestionActions,
	IslandSuggestionChip,
} from "./IslandSuggestionChip.tsx";
import { RecordingPill } from "./RecordingPill.tsx";
import { VoiceModePanel } from "./VoiceModePanel.tsx";

const IS_DEV = Boolean(import.meta.env?.DEV);

// A throwaway connection suggestion so the dev state switcher (press 3) can
// preview the event-trigger surface without a connected Core. Never used in prod.
const DEV_DEMO_SUGGESTION: IslandSuggestion = {
	id: "dev-connect-demo",
	source: "connect_event",
	suggestionType: "connection",
	title: "Password reset request",
	body: "A password reset was requested. If you didn't request it, ignore the code and change your password in the source app.",
	action: "chat",
	confidence: 0.8,
	appName: null,
	ts: 0,
};

// Renders the body for the current island state. U4 wires the real context pill
// (active app + live dot) and suggestion chip; the expanded state hosts the U5/U6
// chat + consent surface.

export interface IslandContentProps {
	/** Agent · Model · Thinking picker for voice mode. */
	composerControls?: ReactNode;
	context: ActiveContext;
	/** Close voice mode (stop the session + collapse the island). */
	onVoiceClose: () => void;
	state: IslandState;
	suggestion: IslandSuggestion | null;
	/** Accept / Dismiss / Snooze for the suggestion chip, drawn inside it. */
	suggestionActions?: IslandSuggestionActions;
	/** Continuous voice-mode session (its own expanded view). */
	voice: VoiceMode;
	/** Name of the agent that will take the dictated task (recording pill). */
	voiceAgentName: string;
	/** Whether Tab cycles agents (shows the ⇥ hint on the recording pill). */
	voiceCanCycle: boolean;
	/** Transient voice error to show on the recording pill, if any. */
	voiceError: string | null;
	/** Live per-bar mic levels (0..1) for the recording-state waveform. */
	voiceLevels: number[];
	/**
	 * Let the pill surfaces wrap their text instead of truncating it to one line.
	 * The island measures this content and grows the shape to fit (capped, then
	 * scrolled), so wrapping is what makes long labels/bodies readable rather than
	 * clipped. Never set on the expanded panel, which owns its own layout.
	 */
	wrap?: boolean;
}

export function IslandContent({
	state,
	context,
	suggestion,
	suggestionActions,
	voice,
	composerControls,
	onVoiceClose,
	voiceAgentName,
	voiceCanCycle,
	voiceError,
	voiceLevels,
	wrap = false,
}: IslandContentProps) {
	const expandedView = useIslandState((store) => store.expandedView);
	if (state === "expanded") {
		return (
			<AnimatePresence initial={false} mode="popLayout">
				<IslandMorphingPage className="h-full w-full" key={expandedView}>
					{expandedView === "voice" ? (
						<VoiceModePanel
							composerControls={composerControls}
							onClose={onVoiceClose}
							voice={voice}
						/>
					) : expandedView === "command" ? (
						<IslandCommand />
					) : (
						<ExpandedPanel />
					)}
				</IslandMorphingPage>
			</AnimatePresence>
		);
	}
	if (state === "recording") {
		return (
			<RecordingPill
				agentName={voiceAgentName}
				canCycle={voiceCanCycle}
				error={voiceError}
				levels={voiceLevels}
				wrap={wrap}
			/>
		);
	}
	// `collapsed` renders nothing here: it is just the standalone logo circle,
	// drawn directly by `Island`. The detail island is absent in that state.
	const shownSuggestion =
		suggestion ??
		(IS_DEV && state === "suggestion" ? DEV_DEMO_SUGGESTION : null);
	if (state === "suggestion" && shownSuggestion) {
		return (
			<IslandSuggestionChip
				actions={suggestionActions}
				suggestion={shownSuggestion}
				wrap={wrap}
			/>
		);
	}
	// `idle` and `context` share the morphing pill: it widens to show the active
	// app when live context is available, else falls back to the plain pill.
	return <ContextPill context={context} wrap={wrap} />;
}
