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

import { useCallback, useRef, useState } from "react";
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
	const pendingRef = useRef<GhostActionInput | null>(null);

	const confirm = useCallback((input: GhostActionInput) => {
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
			if (!action) {
				return;
			}

			setState((prev) => ({
				...prev,
				error: null,
				executing: true,
				result: null,
			}));

			try {
				const res = await callGhostAction(target, agentId, action);
				setState((prev) => ({
					...prev,
					error: null,
					executing: false,
					result: res,
				}));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				setState((prev) => ({
					...prev,
					error: `Ghost action failed: ${message}`,
					executing: false,
					result: null,
				}));
			}
		},
		[target]
	);

	const reset = useCallback(() => {
		pendingRef.current = null;
		setState({ error: null, executing: false, pending: null, result: null });
	}, []);

	return { ...state, confirm, execute, reset };
}
