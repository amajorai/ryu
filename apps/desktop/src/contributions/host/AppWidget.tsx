// The desktop WIDGET RENDERER (Ryu Apps). Mounted by `@ryu/blocks`'s tool-renderer
// for a `data-tool-widget-available` part, through the `WidgetHostContext` slot
// that `ChatPage` provides. It is the widget-specific sibling of `PluginHostPanel`:
// it turns the streamed part into a null-origin sandboxed iframe (ExtensionHost)
// and wires the Gateway-governed bridge (decisions doc D2/D3/D5/D6).
//
// What THIS component owns (the host side of the boundary):
//   - a per-mount `nonce` (crypto.randomUUID) baked into the srcdoc + handshake,
//   - the granted capability Set: `tool.call`/`ui.sendMessage` from the part's
//     Gateway-approved grants (minus `tool.call` unless `widgetAccessible`), plus
//     the LOCAL host caps `widget.state` + `ui.displayMode` (D5),
//   - per-instance `HostServices` that CLOSE OVER the part's identifiers
//     (`instanceId`/`serverId`/`toolCallId`) so the frame can never supply them,
//     delegating to the node-scoped services the context injects,
//   - `pushRef` -> `ryu-widget-set-globals` when props/theme/mode change,
//   - display-mode (inline/fullscreen portal) + intrinsic-height sizing.
//
// The frame NEVER holds the Core token and NEVER reaches the network (CSP
// `connect-src 'none'`); every privileged action is a capability-gated RPC the
// host performs. Rendering is gated behind `PLUGIN_RUNTIME_FLAG` (defense in depth;
// ChatPage also withholds the context value when the flag is off).

import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import {
	type Capability,
	CodedRpcError,
	capabilitiesFromGrants,
	type HostPush,
	type HostServices,
	type WidgetGlobalsPatch,
} from "@ryu/app-host/rpc";
import {
	type WidgetAssetProxy,
	type WidgetInitialGlobals,
	widgetBootstrapSrcdoc,
} from "@ryu/app-host/widget-bootstrap";
import { useWidgetStateStore } from "@ryu/app-host/widget-state-store";
import { useWidgetHost } from "@ryu/blocks/desktop/agent-elements/widget-host-context";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openExternal as openExternalShell } from "@/lib/tauri-bridge.ts";
import {
	PLUGIN_RUNTIME_FLAG,
	useExperimentalFlag,
} from "@/src/lib/experimental.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/** A widget CSP (mirrors the blocks `WidgetCsp`); `resource_domains` is ignored
 *  under D3, so only the optional shape matters here. */
interface WidgetCsp {
	connect_domains?: string[];
	resource_domains?: string[];
}

/** The resolved payload of a `data-tool-widget-available` part. Per decisions doc
 *  D6 the fields live UNDER `data`; {@link widgetData} reads that (with a flat
 *  fallback) so this renderer is robust to either shape U6 lands. */
interface WidgetAvailableData {
	approvedGrants?: string[];
	displayMode?: "inline" | "fullscreen" | "pip";
	initialWidgetState?: unknown;
	instanceId: string;
	invoked?: string;
	invoking?: string;
	maxHeight?: number;
	serverId: string;
	templateUri?: string;
	toolCallId: string;
	toolInput: unknown;
	toolName: string;
	toolOutput: unknown;
	toolResponseMetadata: unknown;
	widget: { csp?: WidgetCsp; html: string; mimeType: string };
	widgetAccessible: boolean;
}

/** The part as the tool-renderer hands it in: `{ type, data }` (D6). Typed loosely
 *  so this file does not hard-depend on U6's exact export shape. */
interface WidgetPartLike {
	data?: WidgetAvailableData;
	type?: string;
}

/** Read the widget payload from a part. Per decisions doc D6 the fields live under
 *  `data`; returns null for a malformed part so the renderer degrades safely. */
function widgetData(part: WidgetPartLike): WidgetAvailableData | null {
	return part.data ?? null;
}

/** Base64-encode a UTF-8 string (btoa is Latin-1 only), so the widget document
 *  survives the srcdoc round-trip and a `</script>` in it cannot break the tag. */
function toBase64Utf8(input: string): string {
	const bytes = new TextEncoder().encode(input);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/** The viewer's current theme, read from the app root (kept in sync via observer). */
function detectTheme(): "light" | "dark" {
	if (typeof document === "undefined") {
		return "dark";
	}
	const root = document.documentElement;
	if (root.classList.contains("dark") || root.dataset.theme === "dark") {
		return "dark";
	}
	return "light";
}

const DEFAULT_INLINE_HEIGHT = 360;

export function AppWidget({ part }: { part: WidgetPartLike }) {
	const { enabled: runtimeEnabled } = useExperimentalFlag(PLUGIN_RUNTIME_FLAG);
	const host = useWidgetHost();
	const data = widgetData(part);
	const stateStore = useWidgetStateStore();
	const getActiveNode = useNodeStore((s) => s.getActiveNode);
	// `requestClose` from the widget dismisses this instance (renders inert).
	const [closed, setClosed] = useState(false);
	// The template a `requestModal({ template })` asked for, recorded so it is
	// honored/observable host-side (Ryu maps the modal itself to fullscreen).
	const modalTemplateRef = useRef<unknown>(null);

	// One nonce per mount, host-generated (never widget/user input).
	const nonce = useMemo(
		() =>
			typeof crypto?.randomUUID === "function"
				? crypto.randomUUID()
				: `nonce-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
		[]
	);

	const [displayMode, setDisplayMode] = useState<
		"inline" | "fullscreen" | "pip"
	>(data?.displayMode ?? "inline");
	const [height, setHeight] = useState<number | null>(null);
	const [theme, setTheme] = useState<"light" | "dark">(() => detectTheme());

	// Keep the injected theme in sync with the app root so the widget re-themes.
	useEffect(() => {
		const target = document.documentElement;
		const observer = new MutationObserver(() => setTheme(detectTheme()));
		observer.observe(target, {
			attributeFilter: ["class", "data-theme"],
			attributes: true,
		});
		return () => observer.disconnect();
	}, []);

	// The granted set: Gateway-approved grants -> capabilities, minus `tool.call`
	// unless this tool is widgetAccessible, plus the local host caps. DENY-SAFE:
	// missing/empty approvedGrants yields the two local caps only.
	const granted = useMemo<ReadonlySet<Capability>>(() => {
		const base = capabilitiesFromGrants(data?.approvedGrants ?? []);
		if (data?.widgetAccessible !== true) {
			base.delete("tool.call");
		}
		base.add("widget.state");
		base.add("ui.displayMode");
		return base;
	}, [data?.approvedGrants, data?.widgetAccessible]);

	// The globals baked into the srcdoc ONCE (captured on first mount so the srcdoc
	// stays stable and the iframe never remounts). Subsequent changes go via push.
	const initialGlobalsRef = useRef<WidgetInitialGlobals | null>(null);
	if (initialGlobalsRef.current === null && data) {
		const seeded =
			stateStore.get(data.toolCallId) ?? data.initialWidgetState ?? null;
		initialGlobalsRef.current = {
			displayMode: data.displayMode ?? "inline",
			locale:
				typeof navigator === "undefined" ? "en" : navigator.language || "en",
			maxHeight: data.maxHeight ?? null,
			safeArea: { bottom: 0, left: 0, right: 0, top: 0 },
			theme,
			toolInput: data.toolInput,
			toolOutput: data.toolOutput,
			toolResponseMetadata: data.toolResponseMetadata,
			widgetState: seeded,
		};
	}

	// The Core asset-proxy plan, captured ONCE on first mount (like the globals) so
	// the srcdoc stays stable and the iframe never remounts. `proxyOrigin` is the
	// active node origin; `resourceDomains` is the widget's declared remote-asset
	// allowlist (empty today until the emit path populates it — then this lights up).
	const assetProxyRef = useRef<WidgetAssetProxy | null>(null);
	if (assetProxyRef.current === null && data) {
		assetProxyRef.current = {
			proxyOrigin: getActiveNode().url,
			instanceId: data.instanceId,
			templateUri: data.templateUri ?? "",
			resourceDomains: data.widget.csp?.resource_domains ?? [],
		};
	}

	// The live globals mirror `getGlobals` returns, and `pushGlobals` merges into.
	const globalsRef = useRef<WidgetInitialGlobals | null>(
		initialGlobalsRef.current
	);
	const pushRef = useRef<((msg: HostPush) => void) | null>(null);
	const pushGlobals = useCallback((patch: WidgetGlobalsPatch) => {
		if (globalsRef.current) {
			globalsRef.current = {
				...globalsRef.current,
				...patch,
			} as WidgetInitialGlobals;
		}
		pushRef.current?.({ globals: patch, kind: "ryu-widget-set-globals" });
	}, []);

	// Seed the client state store from the part on first mount (D4 hydration).
	useEffect(() => {
		if (!data) {
			return;
		}
		if (
			stateStore.get(data.toolCallId) === undefined &&
			data.initialWidgetState !== undefined &&
			data.initialWidgetState !== null
		) {
			stateStore.set(data.toolCallId, data.initialWidgetState);
		}
	}, [data, stateStore]);

	// Push prop/theme/mode changes to the live frame (no-op before connect; the
	// frame also pulls the latest via `widget.getGlobals` on connect).
	useEffect(() => {
		pushGlobals({
			toolInput: data?.toolInput,
			toolOutput: data?.toolOutput,
			toolResponseMetadata: data?.toolResponseMetadata,
		});
	}, [
		data?.toolInput,
		data?.toolOutput,
		data?.toolResponseMetadata,
		pushGlobals,
	]);
	useEffect(() => {
		pushGlobals({ theme });
	}, [theme, pushGlobals]);
	useEffect(() => {
		pushGlobals({ displayMode, maxHeight: data?.maxHeight ?? null });
	}, [displayMode, data?.maxHeight, pushGlobals]);

	const services = host?.services;

	// Per-instance HostServices: close over the part identifiers (never
	// frame-supplied) and delegate to the node-scoped context services.
	const hostServices = useMemo<HostServices>(() => {
		// Capture the resolved payload once so the closures share one non-null `d`
		// (the frame can never supply these identifiers).
		const d = data;
		const requireInstance = () => {
			if (!d) {
				throw new CodedRpcError("not_found", "widget instance unavailable");
			}
			return d;
		};
		return {
			callTool: async (name, args) => {
				if (!services) {
					throw new CodedRpcError("server_error", "widget host unavailable");
				}
				const inst = requireInstance();
				const result = await services.callTool({
					args,
					instanceId: inst.instanceId,
					name,
					serverId: inst.serverId,
					toolCallId: inst.toolCallId,
				});
				// Reflect the confirmed output back into the frame's globals.
				pushGlobals({ toolOutput: result.output });
				return result.output;
			},
			getGlobals: () => Promise.resolve(globalsRef.current),
			// Plugin-only services the shared HostServices interface requires. A widget
			// is never granted `core.listAgents`/`ui.render`, so these are unreachable
			// through the gate; they reject to satisfy the type without leaking access.
			listAgents: () =>
				Promise.reject(
					new CodedRpcError(
						"denied",
						"core.listAgents is not a widget capability"
					)
				),
			registerRoute: () =>
				Promise.reject(
					new CodedRpcError(
						"denied",
						"ui.registerRoute is not a widget capability"
					)
				),
			notifyHeight: (px) => {
				const cap = d?.maxHeight;
				const capped = typeof cap === "number" ? Math.min(px, cap) : px;
				setHeight(capped > 0 ? capped : null);
			},
			requestDisplayMode: ({ mode }) => {
				const next =
					mode === "inline" || mode === "fullscreen" || mode === "pip"
						? mode
						: "inline";
				setDisplayMode(next);
				pushGlobals({ displayMode: next });
				return Promise.resolve({ mode: next });
			},
			// Governed `window.openai.requestModal`: Ryu has no modal-template surface,
			// so a modal maps to fullscreen — but the requested `template` is honored
			// (recorded here + reflected into the widget's `view` global) rather than
			// silently dropped.
			requestModal: ({ template }) => {
				modalTemplateRef.current = template;
				setDisplayMode("fullscreen");
				pushGlobals({
					displayMode: "fullscreen",
					view: { modalTemplate: template },
				});
				return Promise.resolve({ mode: "fullscreen" });
			},
			// Governed `window.openai.requestClose`: dismiss this widget instance.
			requestClose: () => {
				setClosed(true);
				return Promise.resolve();
			},
			// Governed `window.openai.openExternal`: the arg is already vetted to an
			// http(s) URL by the rpc gate; open it in the user's real browser via the
			// desktop shell — NEVER inside the sandboxed frame.
			openExternal: async ({ href }) => {
				await openExternalShell(href);
			},
			sendFollowUpMessage: async ({ prompt }) => {
				if (!services) {
					throw new CodedRpcError("server_error", "widget host unavailable");
				}
				const inst = requireInstance();
				await services.sendFollowUpMessage({
					instanceId: inst.instanceId,
					prompt,
					toolCallId: inst.toolCallId,
				});
			},
			setWidgetState: (state) => {
				const inst = requireInstance();
				stateStore.set(inst.toolCallId, state);
				pushGlobals({ widgetState: state });
				// Best-effort server persistence (D4); never blocks the widget.
				services
					?.setWidgetState?.({
						instanceId: inst.instanceId,
						state,
						toolCallId: inst.toolCallId,
					})
					.catch(() => {
						// swallow — client store remains authoritative for the session
					});
				return Promise.resolve();
			},
		};
	}, [services, data, stateStore, pushGlobals]);

	// Key the srcdoc on STABLE primitives only (the widget HTML + server), not the
	// whole `data` object: a streaming update recreates `part.data` (new toolOutput)
	// and must NOT rebuild the srcdoc — that would remount the iframe and reset the
	// widget. Live prop changes flow through `pushGlobals` instead.
	const widgetHtml = data?.widget.html;
	const widgetServer = data?.serverId;
	const srcdoc = useMemo(() => {
		if (
			!(
				runtimeEnabled &&
				widgetHtml &&
				widgetServer &&
				initialGlobalsRef.current
			)
		) {
			return null;
		}
		return widgetBootstrapSrcdoc(
			nonce,
			toBase64Utf8(widgetHtml),
			widgetServer,
			initialGlobalsRef.current,
			// Captured once on first mount, so this stays stable and never remounts
			// the iframe (matching the srcdoc's stable-inputs contract above).
			assetProxyRef.current ?? undefined
		);
	}, [runtimeEnabled, nonce, widgetHtml, widgetServer]);

	// Flag off, the host context is missing, the part is malformed, or the widget
	// asked to close: render a benign inert placeholder — never fetch or run widget code.
	if (!(runtimeEnabled && host && data && srcdoc) || closed) {
		return (
			<div className="rounded-md border bg-muted/30 p-3 text-muted-foreground text-xs">
				{data?.invoked ?? "App widget"}
			</div>
		);
	}

	const frame = (
		<ExtensionHost
			granted={granted}
			nonce={nonce}
			pushRef={pushRef}
			services={hostServices}
			srcdoc={srcdoc}
			title={`App widget: ${data.toolName}`}
		/>
	);

	if (displayMode === "fullscreen") {
		return createPortal(
			<div className="fixed inset-0 z-[100] flex flex-col bg-background">
				<div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
					<span className="font-medium text-sm">App · {data.serverId}</span>
					<button
						className="ml-auto rounded-md border px-2 py-1 text-xs hover:bg-muted"
						onClick={() => setDisplayMode("inline")}
						type="button"
					>
						Exit fullscreen
					</button>
				</div>
				<div className="min-h-0 flex-1">{frame}</div>
			</div>,
			document.body
		);
	}

	return (
		<div className="overflow-hidden rounded-md border bg-background">
			<div style={{ height: height ?? DEFAULT_INLINE_HEIGHT }}>{frame}</div>
		</div>
	);
}
