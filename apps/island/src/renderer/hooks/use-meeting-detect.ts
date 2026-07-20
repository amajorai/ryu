import { useCallback, useEffect, useRef, useState } from "react";
import type { IslandMeetingEvent, IslandSuggestion } from "../../shared/ipc.ts";
import { useIslandState } from "../store/island-state.ts";

/**
 * Bridges Core's meeting auto-detection to the island's suggestion surface.
 *
 * The main process forwards Core meeting events (already consent-gated for
 * `detected`). When a meeting is detected, we synthesize an `IslandSuggestion`
 * so the existing chip renders "start notes?", and morph the island to the
 * `suggestion` state. Accepting starts the meeting in Core (which drives Shadow
 * capture); the live transcript + notes live on the desktop Meetings page, so the
 * island simply returns to its resting state after kicking it off.
 */
export interface MeetingDetect {
	accept: () => void;
	dismiss: () => void;
	suggestion: IslandSuggestion | null;
}

interface Detected {
	app: string;
	title: string;
}

export function useMeetingDetect(): MeetingDetect {
	const setState = useIslandState((store) => store.setState);
	const [detected, setDetected] = useState<Detected | null>(null);
	// Remember the state the island was in before the chip so dismiss can restore
	// something sensible without fighting the live-context effect.
	const tsRef = useRef(0);

	useEffect(() => {
		const meetings = window.island?.meetings;
		if (!meetings) {
			return;
		}
		const unsubscribe = meetings.onEvent((event: IslandMeetingEvent) => {
			if (event.type === "detected") {
				tsRef.current = Date.now();
				setDetected({ app: event.app, title: event.title });
				setState("suggestion");
			}
		});
		return unsubscribe;
	}, [setState]);

	const accept = useCallback(() => {
		const current = detected;
		setDetected(null);
		setState("context");
		if (current) {
			Promise.resolve(
				window.island?.meetings?.start({
					app: current.app,
					source: "auto",
				})
			).catch(() => undefined);
		}
	}, [detected, setState]);

	const dismiss = useCallback(() => {
		setDetected(null);
		setState("collapsed");
	}, [setState]);

	const suggestion: IslandSuggestion | null = detected
		? {
				id: `meeting-${tsRef.current}`,
				source: "local_model",
				suggestionType: "meeting",
				title: "Meeting detected",
				body: `${detected.title} — start notes?`,
				action: "chat",
				confidence: 1,
				appName: detected.app,
				ts: tsRef.current,
			}
		: null;

	return { suggestion, accept, dismiss };
}
