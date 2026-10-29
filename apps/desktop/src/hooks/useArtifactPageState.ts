// apps/desktop/src/hooks/useArtifactPageState.ts
//
// Saved state for an HTML artifact page rendered inline in the chat. The page
// calls `ryu.state.set(obj)` inside its sandbox (see artifact-srcdoc.ts); this
// hook saves those snapshots through the same generative-UI state host as
// `ui.render` widgets, so a game score or a ticked list survives reopening the
// chat and the agent can read it with `ui.get_state`.

import { useAgentUiStateHost } from "@ryu/blocks/desktop/agent-elements/agent-ui/state-host-context.tsx";
import { clampSavedTitle } from "@ryu/blocks/desktop/agent-elements/agent-ui/state-limits.ts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ArtifactSavedState } from "@/src/lib/artifact-srcdoc.ts";

/** Quiet period before a burst of `ryu.state.set` calls is saved. */
const SAVE_DEBOUNCE_MS = 400;

// Artifact cards are keyed `artifact-<toolCallId>`, both as an inline tool row
// and once moved to the end of the turn, so the two share one saved record.
// Anything else (a turn-end card whose part carried no call id, or the
// `artifact-tool` fallback) has no stable identity to save under.
const PERSISTABLE_ARTIFACT_ID_RE = /^artifact-(?!tool$).+/;

export interface ArtifactPageState {
	/** Receives the page's snapshots; undefined when the page can't be saved. */
	onState: ((state: ArtifactSavedState) => void) | undefined;
	/** What `ryu.state.get()` returns when the frame loads. */
	savedState: ArtifactSavedState | null;
}

export function useArtifactPageState(
	artifactId: string,
	title: string
): ArtifactPageState {
	const host = useAgentUiStateHost();
	const persistable =
		Boolean(host) && PERSISTABLE_ARTIFACT_ID_RE.test(artifactId);

	// Read once per server load, not per save: a new value reloads the frame. The
	// host object only changes identity when saved state is reloaded from Core.
	const savedState = useMemo(
		() => (persistable ? (host?.read(artifactId)?.state ?? null) : null),
		[artifactId, host, persistable]
	);

	const pendingRef = useRef<ArtifactSavedState | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const flush = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		const pending = pendingRef.current;
		pendingRef.current = null;
		if (pending && host) {
			// The frame budgets the page's state to leave room for this wrapper,
			// which holds only if the title is clamped too.
			host.write(artifactId, {
				state: pending,
				...(title ? { title: clampSavedTitle(title) } : {}),
			});
		}
	}, [artifactId, host, title]);
	useEffect(() => flush, [flush]);

	const onState = useCallback(
		(state: ArtifactSavedState) => {
			pendingRef.current = state;
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
			timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
		},
		[flush]
	);

	return { onState: persistable ? onState : undefined, savedState };
}
