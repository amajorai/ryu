import type { RpcJsonResponse, RyuJsonValue } from "@ryu/app-host/rpc";
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
	output: RyuJsonValue;
}

export interface WidgetHostServices {
	/** Governed tool call from a widget -> `POST /api/widgets/tools/call`. */
	callTool(args: {
		instanceId: string;
		serverId: string;
		toolCallId: string;
		name: string;
		args: RpcJsonResponse;
	}): Promise<WidgetCallToolResult>;
	clearModelContext?(owner: string): void;
	fileAccess?: import("@ryu/app-host/opened-file").OpenedFileAccess;
	getModelContext?(
		owner: string
	): import("@ryu/app-host/model-context").ModelContextState | null;
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
		state: RpcJsonResponse;
	}): Promise<void>;
	updateModelContext?(args: {
		owner: string;
		input: import("@ryu/app-host/model-context").ModelContextInput;
	}): Promise<import("@ryu/app-host/model-context").ModelContextState>;
}

/**
 * The two host-environment facts {@link AppWidget} cannot derive itself. Both
 * differ per shell — Tauri vs Electron — which is why the renderer takes them
 * through the context instead of importing an app module.
 */
export interface WidgetHostEnv {
	appPath?: string;
	appTitle?: string;
	/**
	 * Open an http(s) URL in the user's real browser (the rpc gate has already
	 * vetted the scheme). NEVER inside the sandboxed frame.
	 */
	openExternal(href: string): Promise<void> | void;
	/**
	 * Origin of the Core node serving this chat, used as the widget asset proxy's
	 * base. Captured once per widget mount.
	 */
	proxyOrigin: string;
}

/**
 * Value carried on {@link WidgetHostContext}: the widget renderer plus the
 * privileged services and shell facts it closes over. A surface that wants MCP
 * widgets to mount wraps its message list in `<WidgetHostContext.Provider>`;
 * without one, `useWidgetHost()` returns null and a widget part degrades to a
 * plain tool row.
 */
export interface WidgetHostValue {
	env: WidgetHostEnv;
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
