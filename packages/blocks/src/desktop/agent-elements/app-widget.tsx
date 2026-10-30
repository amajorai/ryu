"use client";

import { isNativeFunction } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import styles from "./elements-one.module.css";
import type { AgentGeometryStyle } from "./elements-one-style.ts";
// The WIDGET RENDERER (Ryu Apps). Mounted by the tool-renderer for a
// `data-tool-widget-available` part, through the `WidgetHostContext` slot the
// surface provides. It is the widget-specific sibling of `PluginHostPanel`:
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
// host performs.
//
// It lives in @ryu/blocks, not in a single app, because every surface that
// renders the message list renders widgets: the desktop chat and the island
// mini-chat both mount THIS component. The two shell-specific facts (how to open
// a browser, which node origin proxies assets) arrive as `WidgetHostEnv` on the
// context — see widget-host-context.tsx.

import { COMPANION_THEME_MUTATION_ATTRIBUTES } from "@ryu/app-host/companion-theme";
import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import { useModelContextStore } from "@ryu/app-host/model-context";
import {
	type Capability,
	capabilitiesFromGrants,
	type HostPush,
	type WidgetGlobalsPatch,
} from "@ryu/app-host/rpc";
import {
	createScopedToastHost,
	createSileoToastRenderer,
} from "@ryu/app-host/toast-host";
import {
	type WidgetAssetProxy,
	type WidgetInitialGlobals,
	widgetBootstrapSrcdoc,
} from "@ryu/app-host/widget-bootstrap";
import { useWidgetStateStore } from "@ryu/app-host/widget-state-store";
import { useLiteralMessages, useOptionalI18n } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo";
import { useFriendlyMode } from "@ryu/ui/hooks/use-friendly-mode.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWidgetHostServices } from "./app-widget-host-services.ts";
import {
	COMPACT_INLINE_HEIGHT,
	DEFAULT_INLINE_HEIGHT,
	detectTheme,
	readHostThemeTokens,
	toBase64Utf8,
	type WidgetPartLike,
	widgetData,
} from "./app-widget-payload.ts";
import { useChatDisplayPrefs } from "./chat-display-prefs.tsx";
import { useWidgetHost } from "./widget-host-context.tsx";

const WIDGET_TOAST_RENDERER = createSileoToastRenderer(toast);

export function AppWidget({
	part,
	fill = false,
}: {
	part: WidgetPartLike;
	fill?: boolean;
}) {
	const host = useWidgetHost();
	const i18n = useOptionalI18n();
	const tl = useLiteralMessages();
	const data = widgetData(part);
	const stateStore = useWidgetStateStore();
	const modelContext = useModelContextStore(
		(store) => store.entries[data?.instanceId ?? ""]?.state ?? null
	);
	const { density } = useChatDisplayPrefs();
	// `requestClose` from the widget dismisses this instance (renders inert).
	const [closed, setClosed] = useState(false);
	// The template a `requestModal({ template })` asked for, recorded so it is
	// honored/observable host-side (Ryu maps the modal itself to fullscreen).
	const modalTemplateRef = useRef<unknown>(null);
	const grantsKey = (data?.approvedGrants ?? []).join(" ");

	// One nonce per mount, host-generated (never widget/user input).
	const nonce = useMemo(
		() =>
			isNativeFunction(crypto?.randomUUID)
				? crypto.randomUUID()
				: `nonce-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
		[grantsKey]
	);
	const toastHost = useMemo(
		() =>
			createScopedToastHost({
				renderer: WIDGET_TOAST_RENDERER,
				sourceId: `widget:${data?.serverId ?? "unavailable"}:${data?.instanceId ?? "unavailable"}:${data?.toolCallId ?? "unavailable"}`,
			}),
		[data?.instanceId, data?.serverId, data?.toolCallId]
	);

	useEffect(() => () => toastHost.dispose(), [toastHost]);

	const [displayMode, setDisplayMode] = useState<
		"inline" | "fullscreen" | "pip"
	>(data?.displayMode ?? "inline");
	const [height, setHeight] = useState<number | null>(null);
	useEffect(() => {
		if (displayMode === "inline") {
			return;
		}
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setDisplayMode("inline");
			}
		};
		window.addEventListener("keydown", handleEscape);
		return () => window.removeEventListener("keydown", handleEscape);
	}, [displayMode]);
	const [theme, setTheme] = useState<"light" | "dark">(() => detectTheme());
	const [themeTokens, setThemeTokens] = useState(readHostThemeTokens);
	// The app-wide "Friendly names" toggle, read here so it can be baked into the
	// widget's initial globals and pushed on change — see the effects below.
	const [friendly] = useFriendlyMode();

	// Keep the injected theme in sync with the app root so the widget re-themes.
	useEffect(() => {
		const target = document.documentElement;
		const observer = new MutationObserver(() => {
			setTheme(detectTheme());
			setThemeTokens(readHostThemeTokens());
		});
		observer.observe(target, {
			attributeFilter: [...COMPANION_THEME_MUTATION_ATTRIBUTES],
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
		if (host?.services.fileAccess) {
			base.add("file.access");
		}
		return base;
	}, [grantsKey, data?.widgetAccessible, host?.services.fileAccess]);

	// The globals baked into the srcdoc ONCE (captured on first mount so the srcdoc
	// stays stable and the iframe never remounts). Subsequent changes go via push.
	const initialGlobalsRef = useRef<WidgetInitialGlobals | null>(null);
	if (initialGlobalsRef.current === null && data) {
		const seeded =
			stateStore.get(data.toolCallId) ?? data.initialWidgetState ?? null;
		initialGlobalsRef.current = {
			displayMode: data.displayMode ?? "inline",
			locale:
				i18n?.locale ??
				(globalThis.navigator === undefined
					? "en"
					: navigator.language || "en"),
			maxHeight: data.maxHeight ?? null,
			friendly,
			safeArea: { bottom: 0, left: 0, right: 0, top: 0 },
			theme,
			themeTokens,
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
			proxyOrigin: host?.env.proxyOrigin ?? "",
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
			};
		}
		pushRef.current?.({ globals: patch, kind: "ryu-widget-set-globals" });
	}, []);
	useEffect(() => {
		pushGlobals({ modelContext });
	}, [modelContext, pushGlobals]);

	useEffect(() => {
		const url = host?.env.appPath ?? "/";
		if (
			url.startsWith("/") &&
			!url.startsWith("//") &&
			!/[\\#]/.test(url) &&
			![...url].some((character) => character.charCodeAt(0) < 32)
		) {
			pushGlobals({ deepLink: { url } });
		}
	}, [host?.env.appPath, pushGlobals]);

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
		pushGlobals({ themeTokens });
	}, [themeTokens, pushGlobals]);
	// Friendly names travel exactly like the theme: baked into the initial globals
	// for first paint, then pushed on every flip so a widget already on screen
	// re-labels with the rest of the app instead of waiting for a remount.
	useEffect(() => {
		pushGlobals({ friendly });
	}, [friendly, pushGlobals]);
	useEffect(() => {
		pushGlobals({ displayMode, maxHeight: data?.maxHeight ?? null });
	}, [displayMode, data?.maxHeight, pushGlobals]);
	useEffect(() => {
		if (i18n) {
			pushGlobals({ locale: i18n.locale });
		}
	}, [i18n, pushGlobals]);

	const services = host?.services;
	const fileAccess = services?.fileAccess;
	useEffect(() => {
		if (!fileAccess) {
			return;
		}
		let disposed = false;
		let revision: string | undefined;
		const refresh = async () => {
			try {
				const snapshot = await fileAccess.read();
				if (!disposed && snapshot.revision !== revision) {
					revision = snapshot.revision;
					pushGlobals({
						openedFile: {
							uri: fileAccess.uri,
							name: fileAccess.name,
							editable: fileAccess.editable,
							revision,
						},
					});
				}
			} catch {
				/* A failed poll retains the last confirmed snapshot; reads still reject. */
			}
		};
		void refresh();
		const timer = setInterval(() => void refresh(), 1500);
		return () => {
			disposed = true;
			clearInterval(timer);
		};
	}, [fileAccess, pushGlobals]);
	const modelContextOwner = data?.instanceId;
	const clearModelContextRef = useRef(services?.clearModelContext);
	clearModelContextRef.current = services?.clearModelContext;
	useEffect(
		() => () => {
			if (modelContextOwner) {
				clearModelContextRef.current?.(modelContextOwner);
			}
		},
		[modelContextOwner, grantsKey]
	);
	const openExternalShell = host?.env.openExternal;

	// Per-instance HostServices: close over the part identifiers (never
	// frame-supplied) and delegate to the node-scoped context services.
	const hostServices = useWidgetHostServices({
		data,
		fileAccess,
		globalsRef,
		i18n,
		modalTemplateRef,
		openExternalShell,
		pushGlobals,
		services,
		setClosed,
		setDisplayMode,
		setHeight,
		stateStore,
		toastHost,
	});

	// Key the srcdoc on STABLE primitives only (the widget HTML + server), not the
	// whole `data` object: a streaming update recreates `part.data` (new toolOutput)
	// and must NOT rebuild the srcdoc — that would remount the iframe and reset the
	// widget. Live prop changes flow through `pushGlobals` instead.
	const widgetHtml = data?.widget.html;
	const widgetServer = data?.serverId;
	const srcdoc = useMemo(() => {
		if (!(widgetHtml && widgetServer && initialGlobalsRef.current)) {
			return null;
		}
		return widgetBootstrapSrcdoc(
			nonce,
			toBase64Utf8(widgetHtml),
			widgetServer,
			initialGlobalsRef.current,
			// Captured once on first mount, so this stays stable and never remounts
			// the iframe (matching the srcdoc's stable-inputs contract above).
			assetProxyRef.current ?? undefined,
			true
		);
	}, [nonce, widgetHtml, widgetServer]);

	// The host context is missing, the part is malformed, or the widget asked to
	// close: render a benign inert placeholder — never fetch or run widget code.
	if (!(host && data && srcdoc) || closed) {
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
			themeTokens={themeTokens}
			title={tl("App widget: {name}", {
				name: host.env.appTitle ?? data.toolName,
			})}
		/>
	);

	return (
		<div
			className={
				displayMode === "fullscreen"
					? "fixed inset-0 z-[100] flex flex-col bg-background"
					: displayMode === "pip"
						? "fixed end-4 bottom-4 z-[100] flex w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border bg-background shadow-xl"
						: fill
							? "flex h-full min-h-0 flex-col overflow-hidden rounded-md border bg-background"
							: "overflow-hidden rounded-md border bg-background"
			}
			data-display-mode={displayMode}
			data-testid="app-widget"
		>
			{displayMode !== "inline" && (
				<div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
					<span className="min-w-0 flex-1 truncate font-medium text-sm">
						{host.env.appTitle ?? data.toolName}
					</span>
					<Button
						onClick={() => setDisplayMode("inline")}
						size="sm"
						variant="ghost"
					>
						{i18n?.t("common.back", {}, "Back") ?? "Back"}
					</Button>
					<Button
						onClick={() => {
							services?.clearModelContext?.(data.instanceId);
							setClosed(true);
						}}
						size="sm"
						variant="ghost"
					>
						{i18n?.t("common.close", {}, "Close") ?? "Close"}
					</Button>
				</div>
			)}
			<div
				className={cn(styles.height, "min-h-0 flex-1")}
				key="widget-frame"
				style={
					{
						"--agent-height":
							displayMode === "fullscreen"
								? "100%"
								: displayMode === "pip"
									? "min(360px, calc(100dvh - 7rem))"
									: fill
										? "100%"
										: `${height ?? (density === "compact" ? COMPACT_INLINE_HEIGHT : DEFAULT_INLINE_HEIGHT)}px`,
					} satisfies AgentGeometryStyle as AgentGeometryStyle
				}
			>
				{frame}
			</div>
		</div>
	);
}
