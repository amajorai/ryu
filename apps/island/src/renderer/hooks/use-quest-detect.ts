import { useCallback, useEffect, useRef, useState } from "react";
import type { IslandQuestEvent, IslandSuggestion } from "../../shared/ipc.ts";
import { useIslandState } from "../store/island-state.ts";

/**
 * Bridges Core's quest auto-detection to the island's suggestion surface.
 *
 * The main process forwards Core quest events (the proactive `suggested` one is
 * already consent-gated). When a task looks done, we synthesize an
 * `IslandSuggestion` so the existing chip renders "looks done — mark it?", and
 * morph the island to the `suggestion` state. Accepting confirms the completion
 * in Core (marks the quest done); dismissing rejects the suggestion but keeps the
 * quest open. Either way the island returns to a resting state.
 */
export interface QuestDetect {
	accept: () => void;
	dismiss: () => void;
	suggestion: IslandSuggestion | null;
}

interface Detected {
	confidence: number;
	id: string;
	reason: string;
	title: string;
}

export function useQuestDetect(): QuestDetect {
	const setState = useIslandState((store) => store.setState);
	const [detected, setDetected] = useState<Detected | null>(null);
	const tsRef = useRef(0);

	useEffect(() => {
		const quests = window.island?.quests;
		if (!quests) {
			return;
		}
		const unsubscribe = quests.onEvent((event: IslandQuestEvent) => {
			if (event.type === "suggested") {
				tsRef.current = Date.now();
				setDetected({
					id: event.quest.id,
					title: event.quest.title,
					confidence: event.confidence,
					reason: event.reason,
				});
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
			Promise.resolve(window.island?.quests?.accept(current.id)).catch(
				() => undefined
			);
		}
	}, [detected, setState]);

	const dismiss = useCallback(() => {
		const current = detected;
		setDetected(null);
		setState("collapsed");
		if (current) {
			Promise.resolve(window.island?.quests?.dismiss(current.id)).catch(
				() => undefined
			);
		}
	}, [detected, setState]);

	const suggestion: IslandSuggestion | null = detected
		? {
				id: `quest-${detected.id}`,
				source: "local_model",
				suggestionType: "quest",
				title: "Task looks done",
				body: `${detected.title} — mark it done?`,
				action: "dismiss",
				confidence: detected.confidence / 100,
				appName: null,
				ts: tsRef.current,
			}
		: null;

	return { suggestion, accept, dismiss };
}
