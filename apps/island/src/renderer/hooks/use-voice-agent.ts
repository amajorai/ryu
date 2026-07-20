// Routed-agent tracking + Tab agent-cycling for voice capture.
//
// While recording, pressing Tab (Shift+Tab) rotates which agent will handle the
// dictated task. The main process reports each Tab press through the global key
// hook (`voice.onCycleAgent`); this hook rotates through Core's installed agents,
// persists the pick as the new `island-agents.voiceAgent` default, and exposes the
// selected agent's display name for the recording pill. Persistence is the single
// source of truth: writing the pref echoes back over `agents.onChanged`, which
// both this hook and `useIslandChat` read — so the pill and the actual chat route
// never drift.

import { useCallback, useEffect, useRef, useState } from "react";
import {
	DEFAULT_ISLAND_AGENT_PREFS,
	parseIslandAgentPrefs,
} from "../../shared/agents.ts";
import type {
	CoreAgentSummary,
	VoiceCycleDirection,
} from "../../shared/ipc.ts";

/** Label shown when routing to Core's default local model (empty agent id). */
const DEFAULT_MODEL_LABEL = "Default model";

interface UseVoiceAgent {
	/** Display name of the agent that will take the task (for the recording pill). */
	agentName: string;
	/** True once more than one agent exists, so Tab actually cycles. */
	canCycle: boolean;
}

/** Resolve an agent id to a human label from the installed list. */
function labelFor(id: string, agents: CoreAgentSummary[]): string {
	if (id.length === 0) {
		return DEFAULT_MODEL_LABEL;
	}
	return agents.find((a) => a.id === id)?.name ?? id;
}

/**
 * Track the routed voice agent and rotate it on Tab while recording. Returns the
 * current agent's display name for the recording UI.
 */
export function useVoiceAgent(): UseVoiceAgent {
	const [agents, setAgents] = useState<CoreAgentSummary[]>([]);
	const [currentId, setCurrentId] = useState<string>(
		DEFAULT_ISLAND_AGENT_PREFS.voiceAgent
	);

	// Refs so the (stable) cycle handler always reads the latest list + prefs
	// without re-subscribing on every change.
	const agentsRef = useRef<CoreAgentSummary[]>(agents);
	agentsRef.current = agents;
	const prefsRef = useRef(DEFAULT_ISLAND_AGENT_PREFS);

	// Load the installed agents once (the set Tab cycles through).
	useEffect(() => {
		let cancelled = false;
		window.island.core.agents().then((result) => {
			if (!cancelled && result.available) {
				setAgents(result.agents);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);

	// Track the routed agent from the shared pref (read once, then live).
	useEffect(() => {
		window.island.agents.get().then((raw) => {
			const prefs = parseIslandAgentPrefs(raw);
			prefsRef.current = prefs;
			setCurrentId(prefs.voiceAgent);
		});
		const off = window.island.agents.onChanged((raw) => {
			const prefs = parseIslandAgentPrefs(raw);
			prefsRef.current = prefs;
			setCurrentId(prefs.voiceAgent);
		});
		return () => {
			off();
		};
	}, []);

	// Rotate to the next/previous installed agent and persist it. Persisting fires
	// `agents.onChanged`, which updates `currentId` here and re-routes the chat.
	const cycle = useCallback((direction: VoiceCycleDirection) => {
		const list = agentsRef.current;
		if (list.length === 0) {
			return;
		}
		const prefs = prefsRef.current;
		const index = list.findIndex((a) => a.id === prefs.voiceAgent);
		let nextIndex: number;
		if (index === -1) {
			nextIndex = direction > 0 ? 0 : list.length - 1;
		} else {
			nextIndex = (index + direction + list.length) % list.length;
		}
		const nextId = list[nextIndex].id;
		if (nextId === prefs.voiceAgent) {
			return;
		}
		const nextPrefs = { ...prefs, voiceAgent: nextId };
		prefsRef.current = nextPrefs;
		setCurrentId(nextId);
		window.island.agents.set(JSON.stringify(nextPrefs)).catch(() => {
			// Best effort: a failed write just means the pick doesn't stick as the
			// default; the in-session selection already updated locally.
		});
	}, []);

	useEffect(() => {
		const off = window.island.voice.onCycleAgent(cycle);
		return () => {
			off();
		};
	}, [cycle]);

	return {
		agentName: labelFor(currentId, agents),
		canCycle: agents.length > 1,
	};
}
