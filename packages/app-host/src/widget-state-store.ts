// Client-side widget state (Ryu Apps), keyed by `toolCallId`.
//
// A widget calls `window.ryu.setWidgetState(s)` to persist ephemeral UI state
// (filters, selection, expanded rows, running tally). The host mirrors it here so
// the state survives a remount of the SAME tool row within a session, and — per
// decisions doc D4 — ALSO best-effort persists it server-side (`POST /api/widgets/
// state`) so it survives a full reload. This store is only the client mirror; the
// authoritative snapshot lives in Core's `WidgetInstanceStore`.
//
// The key is `toolCallId`: it is the stable React key of the tool row
// (`message-list.tsx`), so it is 1:1 with a mounted widget and does not change
// across the render churn a stream produces. `instanceId` is minted per render and
// is NOT a stable client key.

import { create } from "zustand";

/** The widget-state store shape. `byToolCall` is the raw map; `get`/`set` are the
 *  accessors the widget host uses. */
export interface WidgetStateStore {
	byToolCall: Record<string, unknown>;
	get(toolCallId: string): unknown;
	set(toolCallId: string, state: unknown): void;
}

/**
 * The singleton widget-state store. Kept module-global (like `useNodeStore`) so a
 * widget's state is shared across every surface that mounts its tool row. Seeded
 * from `part.data.initialWidgetState` by {@link AppWidget} on first mount.
 */
export const useWidgetStateStore = create<WidgetStateStore>(
	(zustandSet, zustandGet) => ({
		byToolCall: {},
		get: (toolCallId) => zustandGet().byToolCall[toolCallId],
		set: (toolCallId, state) =>
			zustandSet((prev) => ({
				byToolCall: { ...prev.byToolCall, [toolCallId]: state },
			})),
	})
);
