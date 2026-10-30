import { readCompanionThemeTokens } from "@ryu/app-host/companion-theme";

/** A widget CSP (mirrors the blocks `WidgetCsp`); `resource_domains` is ignored
 *  under D3, so only the optional shape matters here. */
export interface WidgetCsp {
	connect_domains?: string[];
	resource_domains?: string[];
}

/** The resolved payload of a `data-tool-widget-available` part. Per decisions doc
 *  D6 the fields live UNDER `data`; {@link widgetData} reads that (with a flat
 *  fallback) so this renderer is robust to either shape U6 lands. */
export interface WidgetAvailableData {
	approvedGrants?: string[];
	conversationId?: string | null;
	displayMode?: "inline" | "fullscreen" | "pip";
	initialWidgetState?: unknown;
	instanceId: string;
	invoked?: string | null;
	invoking?: string | null;
	maxHeight?: number | null;
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
export interface WidgetPartLike {
	data?: WidgetAvailableData;
	type?: string;
}

/** Read the widget payload from a part. Per decisions doc D6 the fields live under
 *  `data`; returns null for a malformed part so the renderer degrades safely. */
export function widgetData(part: WidgetPartLike): WidgetAvailableData | null {
	return part.data ?? null;
}

/** Base64-encode a UTF-8 string (btoa is Latin-1 only), so the widget document
 *  survives the srcdoc round-trip and a `</script>` in it cannot break the tag. */
export function toBase64Utf8(input: string): string {
	const bytes = new TextEncoder().encode(input);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/** The viewer's current theme, read from the app root (kept in sync via observer). */
export function detectTheme(): "light" | "dark" {
	if (globalThis.document === undefined) {
		return "dark";
	}
	const root = document.documentElement;
	if (
		root.classList.contains("dark") ||
		root.dataset.theme === "dark" ||
		root.dataset.ryuTheme === "dark"
	) {
		return "dark";
	}
	return "light";
}

export function readHostThemeTokens(): Record<string, string> {
	return readCompanionThemeTokens(undefined, {
		includeStoredPreferences: true,
	});
}

export const DEFAULT_INLINE_HEIGHT = 360;
/** A widget in a narrow surface (the island) gets a shorter default box — 360px
 *  would swallow the whole panel before the widget reports its own height. */
export const COMPACT_INLINE_HEIGHT = 220;
