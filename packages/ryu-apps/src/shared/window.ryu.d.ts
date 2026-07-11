// The `window.ryu` / `window.openai` widget globals contract (spec §1.3, D6).
//
// `window.ryu` is the PRIMARY object a Ryu widget reads and calls; `window.openai`
// is the same object reference (`window.openai = window.ryu`, see
// `compat/openai-shim.ts`) so an unmodified ChatGPT Apps-SDK component runs against
// it. The bridge (`bridge.ts`) installs the METHODS and drives the props; Core
// injects the INITIAL props synchronously into the document (D2) before the widget
// module evaluates, because real components read `window.openai.toolOutput` at
// module top-level.
//
// This file is BOTH a module (it `export`s the types other widget code imports) and
// a global augmentation (`declare global`). It is the single source of truth for the
// globals shape shared by U3 (this workspace), U6 (desktop blocks types), and U7
// (desktop host).

/** Host visual theme pushed to the widget. Only `light | dark` in v1. */
export type WidgetTheme = "light" | "dark";

/** How the widget is presented (R6). `pip` is reserved; only `inline` and
 *  `fullscreen` have a host implementation in v1. */
export type WidgetDisplayMode = "inline" | "fullscreen" | "pip";

/** Insets (px) the host asks the widget to keep clear (notches, host chrome). */
export interface WidgetSafeArea {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

/** The taxonomy an RPC denial carries back to the widget (D6). Lets a widget render
 *  a meaningful error instead of a generic failure. */
export type WidgetRpcErrorCode =
	| "denied"
	| "not_found"
	| "over_budget"
	| "server_error"
	| "invalid_args";

/** The error object shape carried on a rejected RPC reply (D6):
 *  `{ kind:"ryu-plugin-rpc-result", id, error:{ code, message } }`. */
export interface WidgetRpcErrorPayload {
	code: WidgetRpcErrorCode;
	message: string;
}

/**
 * The complete `window.ryu` surface (spec §1.3): the host→widget PROPS a widget
 * reads reactively, plus the widget→host METHODS the bridge marshals over the
 * transferred `MessagePort`.
 *
 * Props are updated by the host via `ryu-widget-set-globals` pushes; subscribe to
 * them with {@link useRyuGlobal} rather than reading once. Methods are Gateway- and
 * host-governed — `callTool` / `sendFollowUpMessage` transit the full governance
 * chain; `requestClose` / `openExternal` are denied in v1.
 */
export interface RyuWidgetGlobals {
	// ---- props (host -> widget) ----
	/** The arguments the tool was invoked with. */
	toolInput: unknown;
	/** The tool's `structuredContent` result (the model-visible output). */
	toolOutput: unknown;
	/** The tool's `_meta` (widget-only payload; `ryu/widget` already stripped). */
	toolResponseMetadata: unknown;
	/** Widget-owned persisted UI state (keyed by `toolCallId` host-side). */
	widgetState: unknown;
	/** Host theme; re-pushed on change. */
	theme: WidgetTheme;
	/** BCP-47 locale string. */
	locale: string;
	/** Current display mode. */
	displayMode: WidgetDisplayMode;
	/** Max height (px) the host will allow, or `null` for unbounded. */
	maxHeight: number | null;
	/** Safe-area insets to keep clear. */
	safeArea: WidgetSafeArea;

	// ---- methods (widget -> host) ----
	/** Persist widget UI state. Maps to RPC `widget.setState`. */
	setWidgetState(state: unknown): Promise<void>;
	/** Call a tool on the widget's own origin server (Gateway-governed). Maps to
	 *  RPC `tool.call`; the host pins the server, the frame never supplies it. */
	callTool(name: string, args: unknown): Promise<unknown>;
	/** Inject a governed follow-up user turn. Maps to RPC `ui.sendMessage`. */
	sendFollowUpMessage(args: { prompt: string }): Promise<void>;
	/** Request a display-mode change. Maps to RPC `ui.requestDisplayMode`. */
	requestDisplayMode(args: {
		mode: WidgetDisplayMode;
	}): Promise<{ mode: string }>;
	/** Alias of `requestDisplayMode({ mode: "fullscreen" })`. */
	requestModal(): Promise<void>;
	/** Denied in v1 (unmapped host method → rejects). */
	requestClose(): Promise<void>;
	/** Report the widget's intrinsic content height so the host can size the frame.
	 *  Maps to RPC `ui.notifyHeight`; fire-and-forget. */
	notifyIntrinsicHeight(px: number): void;
	/** Denied in v1 (unmapped host method → rejects). */
	openExternal(args: { href: string }): Promise<void>;
}

/** Compat alias: the ChatGPT-Apps-SDK-facing name for {@link RyuWidgetGlobals}. */
export type OpenAiGlobals = RyuWidgetGlobals;

/** Convenience alias used across the widget workspace. */
export type WidgetGlobals = RyuWidgetGlobals;

/** The subset of {@link RyuWidgetGlobals} that is DATA (props only) — the shape the
 *  host injects synchronously and pushes as partials over `ryu-widget-set-globals`. */
export type RyuWidgetProps = Pick<
	RyuWidgetGlobals,
	| "toolInput"
	| "toolOutput"
	| "toolResponseMetadata"
	| "widgetState"
	| "theme"
	| "locale"
	| "displayMode"
	| "maxHeight"
	| "safeArea"
>;

declare global {
	interface Window {
		ryu: RyuWidgetGlobals;
		openai: RyuWidgetGlobals;
		/** Per-mount handshake nonce injected synchronously by the host/Core before
		 *  the widget module evaluates. The bridge echoes it in `ryu-plugin-ready`
		 *  and only accepts the `ryu-plugin-host-port` message carrying it. */
		__ryuWidgetNonce?: string;
	}
}
