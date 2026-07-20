import type { ReactNode } from "react";
import type { IslandSuggestion } from "../../shared/ipc.ts";
import type { ActiveContext } from "../hooks/use-active-context.ts";
import type { VoiceMode } from "../hooks/use-voice-mode.ts";
import type { IslandState } from "../store/island-state.ts";
import { useIslandState } from "../store/island-state.ts";
import { ContextPill } from "./ContextPill.tsx";
import { IslandCommand } from "./command/IslandCommand.tsx";
import { ExpandedPanel } from "./ExpandedPanel.tsx";
import { IslandSuggestionChip } from "./IslandSuggestionChip.tsx";
import { RecordingPill } from "./RecordingPill.tsx";
import { VoiceModePanel } from "./VoiceModePanel.tsx";

const IS_DEV = Boolean(
	(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV
);

// A throwaway suggestion so the dev state switcher (press 3) can preview the
// chip morph even when no real engine suggestion is active. Never used in prod.
const DEV_DEMO_SUGGESTION: IslandSuggestion = {
	id: "dev-demo",
	source: "local_model",
	suggestionType: "context",
	title: "Summarize this page",
	body: "Looks like a long article. Want a quick summary?",
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
}

export function IslandContent({
	state,
	context,
	suggestion,
	voice,
	composerControls,
	onVoiceClose,
	voiceAgentName,
	voiceCanCycle,
	voiceError,
	voiceLevels,
}: IslandContentProps) {
	const expandedView = useIslandState((store) => store.expandedView);
	if (state === "expanded") {
		if (expandedView === "voice") {
			return (
				<VoiceModePanel
					composerControls={composerControls}
					onClose={onVoiceClose}
					voice={voice}
				/>
			);
		}
		return expandedView === "command" ? <IslandCommand /> : <ExpandedPanel />;
	}
	if (state === "recording") {
		return (
			<RecordingPill
				agentName={voiceAgentName}
				canCycle={voiceCanCycle}
				error={voiceError}
				levels={voiceLevels}
			/>
		);
	}
	// `collapsed` renders nothing here: it is just the standalone logo circle,
	// drawn directly by `Island`. The detail island is absent in that state.
	const shownSuggestion =
		suggestion ??
		(IS_DEV && state === "suggestion" ? DEV_DEMO_SUGGESTION : null);
	if (state === "suggestion" && shownSuggestion) {
		return <IslandSuggestionChip suggestion={shownSuggestion} />;
	}
	// `idle` and `context` share the morphing pill: it widens to show the active
	// app when live context is available, else falls back to the plain pill.
	return <ContextPill context={context} />;
}
