"use client";

import { GlassScrimCard } from "@ryu/ui/components/glasscn/glass-scrim-card.tsx";
import { Logo } from "@ryu/ui/components/logo";
import { cn } from "@ryu/ui/lib/utils";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	isAssistantSelectionChange,
	readBrowserPageSelection,
} from "./browser-context.ts";
import {
	type AssistantColorScheme,
	AssistantColorSchemeProvider,
	colorSchemeClass,
	useResolvedColorScheme,
} from "./color-scheme.tsx";
import {
	DeferredAssistantSession,
	preloadAssistantSession,
} from "./deferred-session.tsx";
import { RyuAssistantMorph } from "./morph.tsx";
import styles from "./public-widget.module.css";
import type { AssistantMode } from "./runtime-controls.tsx";
import {
	ASSISTANT_GLASS_CHROME,
	ASSISTANT_GLASS_FILL,
	ASSISTANT_ISLAND_LAUNCHER_SCRIM,
	ASSISTANT_ISLAND_LAUNCHER_SKIN,
} from "./skin.ts";
import { useWebMcpPageTools } from "./webmcp.ts";

export type { AssistantColorScheme } from "./color-scheme.tsx";
export type { AssistantMode } from "./runtime-controls.tsx";

export interface RyuAssistantWidgetProps {
	/** Absolute docs origin for the marketing site; omit on Fumadocs. */
	docsBaseUrl?: string;
	initialMode?: AssistantMode;
	inline?: boolean;
	/**
	 * A host-owned card docked just above the floating launcher while the panel
	 * is closed, e.g. the marketing site's landing-page launch offer. The host
	 * owns its content and dismissal; it hides whenever Ask Ryu is open.
	 */
	launcherPromo?: ReactNode;
	openOnMount?: boolean;
	/**
	 * Show the "Powered by Ryu" badge under the transcript. Off by default, which
	 * is right on Ryu's own sites; a host embedding the widget on a member's site
	 * turns it on unless the member's plan drops it (`canRemovePoweredByRyu`).
	 */
	poweredByRyu?: boolean;
	showLauncher?: boolean;
	/**
	 * Light or dark appearance. `auto` (default) detects the host page's theme
	 * (a `.dark` class or `data-theme` on `<html>`/`<body>`, its CSS
	 * `color-scheme`, its background, then the visitor's system setting) and
	 * follows changes; `light` or `dark` pins the widget for any page.
	 */
	theme?: AssistantColorScheme;
}

// Same geometry as Desktop's floating Ask Ryu (AssistantDock): a 400 × 620 panel
// that springs out of a 40px circle wearing the 34px eyes, dressed as the
// Island's logo circle.
const MORPH_CONTENT_HEIGHT = 620;
const MORPH_CONTENT_WIDTH = 400;
const LAUNCHER_EYES_SIZE = "34px";
/** The panel's corner radius once open, matching `RyuAssistantMorph`. */
const INLINE_PANEL_RADIUS = "rounded-2xl";

/**
 * The launcher's face: the Island's logo circle (Liquid Glass under a popover
 * scrim) wearing the 34px eyes, so the widget reads as the Island on any site.
 */
function IslandLauncherFace() {
	return (
		<GlassScrimCard
			appearance="island"
			className="h-full w-full"
			contour="round"
			data-ryu-launcher-face="island"
			scrimClassName={ASSISTANT_ISLAND_LAUNCHER_SCRIM}
			surfaceClassName="h-full w-full rounded-full"
		>
			<span className="relative z-[2] flex h-full w-full items-center justify-center">
				<Logo
					className="text-current"
					size={LAUNCHER_EYES_SIZE}
					variant="eyes"
				/>
			</span>
		</GlassScrimCard>
	);
}

/** The visitor's page selection, for the live region and the context chips. */
function usePageSelection(): string | null {
	const [selection, setSelection] = useState<string | null>(null);
	useEffect(() => {
		if (!globalThis.document) {
			return;
		}
		const refreshSelection = () => {
			// Context previews are portaled outside the widget root, so origin is
			// checked by the shared widget marker rather than root containment.
			if (isAssistantSelectionChange(document)) {
				return;
			}
			setSelection(readBrowserPageSelection(document));
		};
		setSelection(readBrowserPageSelection(document));
		document.addEventListener("selectionchange", refreshSelection);
		return () => {
			document.removeEventListener("selectionchange", refreshSelection);
		};
	}, []);
	return selection;
}

/**
 * Ask Ryu for public pages. Only the launcher, the selection announcement and
 * the WebMCP page-tool listing load with the page; the chat session is a
 * separate chunk that loads on first open and is warmed on launcher intent.
 */
export function RyuAssistantWidget({
	docsBaseUrl,
	initialMode = "browser",
	inline = false,
	launcherPromo,
	openOnMount = false,
	poweredByRyu = false,
	showLauncher = true,
	theme = "auto",
}: RyuAssistantWidgetProps) {
	const scheme = useResolvedColorScheme(theme);
	const schemeClass = colorSchemeClass(scheme);
	const schemeStyle = scheme ? { colorScheme: scheme } : undefined;
	const [open, setOpen] = useState(openOnMount || inline);
	const selection = usePageSelection();
	const pageTools = useWebMcpPageTools();
	const contextRootRef = useRef<HTMLDivElement>(null);
	const close = useCallback(() => setOpen(false), []);

	const session = (
		<DeferredAssistantSession
			contextRootRef={contextRootRef}
			docsBaseUrl={docsBaseUrl}
			initialMode={initialMode}
			onClose={inline ? undefined : close}
			open={inline || open}
			pageTools={pageTools}
			poweredByRyu={poweredByRyu}
			selection={selection}
		/>
	);
	const selectionAnnouncement = (
		<p aria-atomic="true" aria-live="polite" className="sr-only">
			{selection
				? "Selected page text is available as context: " +
					selection.slice(0, 120)
				: ""}
		</p>
	);

	if (inline) {
		// The inline section wears the same glass card the launcher opens into.
		return (
			<AssistantColorSchemeProvider scheme={scheme}>
				<div
					className={cn(
						"w-full overflow-hidden",
						INLINE_PANEL_RADIUS,
						ASSISTANT_GLASS_FILL,
						ASSISTANT_GLASS_CHROME,
						styles.inline,
						schemeClass
					)}
					data-ryu-assistant-widget="true"
					data-ryu-color-scheme={scheme ?? undefined}
					ref={contextRootRef}
					style={schemeStyle}
				>
					{selectionAnnouncement}
					{session}
				</div>
			</AssistantColorSchemeProvider>
		);
	}

	if (!(showLauncher || open)) {
		return null;
	}

	return (
		<AssistantColorSchemeProvider scheme={scheme}>
			<div
				className={schemeClass}
				data-placement="floating"
				data-ryu-assistant-widget="true"
				data-ryu-color-scheme={scheme ?? undefined}
				ref={contextRootRef}
				style={schemeStyle}
			>
				{selectionAnnouncement}
				{launcherPromo && !open ? (
					<div className={cn("fixed", styles.launcherPromo)}>
						{launcherPromo}
					</div>
				) : null}
				<RyuAssistantMorph
					bgClassName={ASSISTANT_GLASS_FILL}
					chromeClassName={ASSISTANT_GLASS_CHROME}
					className={cn("fixed h-10 w-10", styles.launcher)}
					contentHeight={MORPH_CONTENT_HEIGHT}
					contentMaxHeight="calc(100svh - 2rem - var(--ryu-assistant-launcher-lift, 0px))"
					contentMaxWidth="calc(100vw - 2rem)"
					contentWidth={MORPH_CONTENT_WIDTH}
					dialogLabel="Ask Ryu"
					isOpen={open}
					keepContentMounted
					onOpenChange={setOpen}
					onTriggerIntent={preloadAssistantSession}
					trigger={<IslandLauncherFace />}
					triggerLabel="Open Ask Ryu"
					triggerSkinClassName={ASSISTANT_ISLAND_LAUNCHER_SKIN}
				>
					{session}
				</RyuAssistantMorph>
			</div>
		</AssistantColorSchemeProvider>
	);
}
