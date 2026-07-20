import { createContext, useContext } from "react";
import type { WidgetRendererComponent } from "./types.ts";

/**
 * Privileged host operations a mounted app widget can invoke. Implemented by
 * apps/desktop (which holds the Core node token); the sandboxed iframe never
 * calls these directly — the host bridges its postMessage RPC to them. All three
 * are governed server-side (provenance gate -> Gateway), so `serverId`/`instanceId`
 * are host-pinned, never frame-supplied.
 */
/** Core's response to a governed widget tool call (mirrors
 *  `apps/desktop` `WidgetCallToolResult`; blocks cannot import from the app). */
export interface WidgetCallToolResult {
	ok: boolean;
	output: unknown;
}

export interface WidgetHostServices {
	/** Governed tool call from a widget -> `POST /api/widgets/tools/call`. */
	callTool(args: {
		instanceId: string;
		serverId: string;
		toolCallId: string;
		name: string;
		args: unknown;
	}): Promise<WidgetCallToolResult>;
	/** Inject a follow-up user turn on the owning conversation ->
	 *  `POST /api/widgets/follow-up` (governed, R4) — not the raw chat transport. */
	sendFollowUpMessage(args: {
		instanceId: string;
		toolCallId: string;
		prompt: string;
	}): Promise<void>;
	/** Persist widget state, keyed by `toolCallId`; best-effort server-side (D4). */
	setWidgetState(args: {
		instanceId: string;
		toolCallId: string;
		state: unknown;
	}): Promise<void>;
}

/**
 * Value carried on {@link WidgetHostContext}: the desktop-authored widget
 * renderer plus the privileged services it closes over. apps/desktop provides
 * both by wrapping `<AgentChat/>` in `<WidgetHostContext.Provider>`.
 */
export interface WidgetHostValue {
	Renderer: WidgetRendererComponent;
	services: WidgetHostServices;
}

const WidgetHostContext = createContext<WidgetHostValue | null>(null);

export { WidgetHostContext };

/** Read the injected widget host, or `null` when no host is mounted (widgets
 *  then degrade to a plain tool row). */
export function useWidgetHost(): WidgetHostValue | null {
	return useContext(WidgetHostContext);
}
