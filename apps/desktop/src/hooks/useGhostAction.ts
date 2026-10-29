// apps/desktop/src/hooks/useGhostAction.ts
//
// Companion overlay hook for executing a Ghost computer-use action through
// Core's MCP path (issue #201). The hook enforces the confirmation requirement:
// the caller must call `confirm()` before `execute()`, otherwise the action is
// refused client-side. No Ghost action executes without explicit user consent.
//
// Flow:
//   1. Caller builds a GhostActionInput describing the desired action.
//   2. Caller calls `confirm(input)` — marks the action as confirmed.
//   3. Caller calls `execute(agentId)` — dispatches through Core /api/mcp/tools/call.
//   4. `result` carries the outcome; `reset()` clears for the next action.
//
// The two-step confirm + execute design keeps the confirmation gate in the UI
// layer (the dialog) without passing a boolean flag down into the API client.

import { useLiteralMessages } from "@ryu/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	callGhostAction,
	type GhostActionInput,
	type McpCallResult,
} from "@/src/lib/api/mcp.ts";

export interface GhostActionState {
	/** Inline error message (network / Core error before a result arrives). */
	error: string | null;
	/** Whether a call is in flight. */
	executing: boolean;
	/** The action the user has confirmed but not yet executed, or null. */
	pending: GhostActionInput | null;
	/** Result of the last completed call. null before first call. */
	result: McpCallResult | null;
}

export interface UseGhostActionResult extends GhostActionState {
	/**
	 * Stage an action as confirmed. Must be called before `execute`.
	 * Resets any previous result so the UI reflects a fresh confirmation.
	 */
	confirm: (input: GhostActionInput) => void;
	/**
	 * Execute the confirmed action through Core's MCP path.
	 * Requires `pending` to be non-null (i.e. `confirm` was called first).
	 * Does nothing if no action is pending.
	 */
	execute: (agentId: string) => Promise<void>;
	/** Clear all state (pending, result, error) for the next action cycle. */
	reset: () => void;
}

export function useGhostAction(target: ApiTarget): UseGhostActionResult {
	const [state, setState] = useState<GhostActionState>({
		error: null,
		executing: false,
		pending: null,
		result: null,
	});

	// Ref mirrors `pending` so `execute` always reads the latest confirmed action
	// without needing to capture `state` in the closure (which would go stale).
	const tl = useLiteralMessages();
	const tlRef = useRef(tl);
	tlRef.current = tl;
	const pendingRef = useRef<GhostActionInput | null>(null);

	const generation = useRef(0);
	const executing = useRef(false);
	useEffect(() => {
		generation.current += 1;
		pendingRef.current = null;
		executing.current = false;
		setState({ error: null, executing: false, pending: null, result: null });
		return () => {
			generation.current += 1;
		};
	}, [target.url, target.token, target.userJwt]);
	const confirm = useCallback((input: GhostActionInput) => {
		if (executing.current) {
			return;
		}
		pendingRef.current = input;
		setState({
			error: null,
			executing: false,
			pending: input,
			result: null,
		});
	}, []);

	const execute = useCallback(
		async (agentId: string) => {
			const action = pendingRef.current;
			if (!action || executing.current) {
				return;
			}

			pendingRef.current = null;
			executing.current = true;
			const activeGeneration = generation.current;
			setState((prev) => ({
				...prev,
				error: null,
				executing: true,
				result: null,
			}));

			try {
				const res = await callGhostAction(target, agentId, action);
				if (activeGeneration !== generation.current) {
					return;
				}
				executing.current = false;
				setState((prev) => ({
					...prev,
					error: null,
					executing: false,
					result: res,
				}));
			} catch (err) {
				if (activeGeneration !== generation.current) {
					return;
				}
				executing.current = false;
				const message = err instanceof Error ? err.message : String(err);
				setState((prev) => ({
					...prev,
					error: tlRef.current("Ghost action failed: {message}", { message }),
					executing: false,
					result: null,
				}));
			}
		},
		[target]
	);

	const reset = useCallback(() => {
		generation.current += 1;
		executing.current = false;
		pendingRef.current = null;
		setState({ error: null, executing: false, pending: null, result: null });
	}, []);

	return { ...state, confirm, execute, reset };
}
