"use client";

import { cn } from "@ryu/ui/lib/utils";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { ASSISTANT_POPUP_LAYER } from "./skin.ts";

/**
 * The widget's light/dark setting. `auto` (the default) detects the host page's
 * theme and keeps following it; `light` and `dark` pin the widget regardless of
 * the page, for sites whose own theme the widget cannot read.
 */
export type AssistantColorScheme = "auto" | "light" | "dark";
export type ResolvedAssistantColorScheme = "light" | "dark";

/**
 * Class a forced-light subtree wears. `@ryu/ui` re-declares its light tokens on
 * it and keeps the `dark:` variant off inside it, so a light widget stays light
 * on a `.dark` page. A dark subtree wears the ordinary `dark` class.
 */
export const ASSISTANT_LIGHT_SCHEME_CLASS = "ryu-color-scheme-light";

/** The class that scopes a subtree to the resolved scheme. */
export function colorSchemeClass(
	scheme: ResolvedAssistantColorScheme | null
): string | undefined {
	if (scheme === "dark") {
		return "dark";
	}
	return scheme === "light" ? ASSISTANT_LIGHT_SCHEME_CLASS : undefined;
}

/** Host attributes that name a theme, read in this order. */
const THEME_ATTRIBUTES = [
	"data-theme",
	"data-ryu-theme",
	"data-color-scheme",
	"data-bs-theme",
	"data-mode",
] as const;
const OBSERVED_ATTRIBUTES = ["class", "style", ...THEME_ATTRIBUTES];
const PREFERS_DARK = "(prefers-color-scheme: dark)";
const LIGHTNESS_MIDPOINT = 0.5;
const OPAQUE_ALPHA = 0.5;

function asScheme(
	value: string | null | undefined
): ResolvedAssistantColorScheme | null {
	const normalized = value?.trim().toLowerCase();
	return normalized === "dark" || normalized === "light" ? normalized : null;
}

/** An element's explicit theme marker: a class or a theme attribute. */
function markedScheme(element: Element): ResolvedAssistantColorScheme | null {
	if (element.classList.contains("dark")) {
		return "dark";
	}
	for (const attribute of THEME_ATTRIBUTES) {
		const scheme = asScheme(element.getAttribute(attribute));
		if (scheme) {
			return scheme;
		}
	}
	return element.classList.contains("light") ? "light" : null;
}

function channel(value: string): number {
	const number = Number.parseFloat(value);
	return value.endsWith("%") ? number / 100 : number;
}

/**
 * Lightness (0–1) of a computed background, or null when it is transparent or
 * in a notation this does not read.
 */
export function backgroundLightness(color: string): number | null {
	const match = /^(rgba?|oklch|oklab|lab|lch)\(([^)]*)\)$/i.exec(color.trim());
	if (!match) {
		return null;
	}
	const [, fn = "", body = ""] = match;
	const parts = body.split(/[\s,/]+/).filter(Boolean);
	const alpha = parts.length >= 4 ? channel(parts[3] ?? "1") : 1;
	if (alpha < OPAQUE_ALPHA) {
		return null;
	}
	const first = parts[0] ?? "";
	if (fn.toLowerCase().startsWith("rgb")) {
		const [r, g, b] = parts.slice(0, 3).map((part) => {
			const value = part.endsWith("%") ? channel(part) : Number(part) / 255;
			return value;
		});
		return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
	}
	// oklch/oklab take lightness 0–1 (or %); lab/lch take 0–100.
	const lightness = channel(first);
	return fn.toLowerCase().startsWith("ok") || first.endsWith("%")
		? lightness
		: lightness / 100;
}

/**
 * Work out the host page's scheme: an explicit marker on `<html>` or `<body>`
 * (`.dark`, `data-theme`, …), then a declared CSS `color-scheme`, then how light
 * the page background is, and finally the visitor's system preference.
 */
export function detectHostColorScheme(
	doc: Document,
	prefersDark: boolean
): ResolvedAssistantColorScheme {
	const elements = [doc.documentElement, doc.body].filter(
		(element): element is HTMLElement => Boolean(element)
	);
	for (const element of elements) {
		const scheme = markedScheme(element);
		if (scheme) {
			return scheme;
		}
	}
	const view = doc.defaultView;
	if (view) {
		for (const element of elements) {
			const scheme = asScheme(view.getComputedStyle(element).colorScheme);
			if (scheme) {
				return scheme;
			}
		}
		for (const element of [...elements].reverse()) {
			const lightness = backgroundLightness(
				view.getComputedStyle(element).backgroundColor
			);
			if (lightness !== null) {
				return lightness < LIGHTNESS_MIDPOINT ? "dark" : "light";
			}
		}
	}
	return prefersDark ? "dark" : "light";
}

/**
 * The scheme to render with. A pinned setting resolves immediately (also during
 * server rendering); `auto` resolves after mount and follows later host theme
 * switches and system changes. Null means "not resolved yet": inherit the host.
 */
export function useResolvedColorScheme(
	preference: AssistantColorScheme
): ResolvedAssistantColorScheme | null {
	const [detected, setDetected] = useState<ResolvedAssistantColorScheme | null>(
		null
	);
	useEffect(() => {
		if (preference !== "auto" || !globalThis.document) {
			return;
		}
		const media = globalThis.matchMedia?.(PREFERS_DARK);
		const refresh = () =>
			setDetected(detectHostColorScheme(document, media?.matches ?? false));
		refresh();
		const observer = new MutationObserver(refresh);
		for (const element of [document.documentElement, document.body]) {
			if (element) {
				observer.observe(element, {
					attributeFilter: OBSERVED_ATTRIBUTES,
					attributes: true,
				});
			}
		}
		media?.addEventListener("change", refresh);
		return () => {
			observer.disconnect();
			media?.removeEventListener("change", refresh);
		};
	}, [preference]);
	return preference === "auto" ? detected : preference;
}

const AssistantColorSchemeContext =
	createContext<ResolvedAssistantColorScheme | null>(null);

/** Shares the widget's resolved scheme with popups it portals to `<body>`. */
export function AssistantColorSchemeProvider({
	children,
	scheme,
}: {
	children: ReactNode;
	scheme: ResolvedAssistantColorScheme | null;
}) {
	return (
		<AssistantColorSchemeContext.Provider value={scheme}>
			{children}
		</AssistantColorSchemeContext.Provider>
	);
}

/**
 * Positioner classes for a widget popup: the popup layer plus the widget's
 * scheme, since a portal leaves the widget root and its scheme class behind.
 */
export function useAssistantPopupLayer(): string {
	return cn(
		ASSISTANT_POPUP_LAYER,
		colorSchemeClass(useContext(AssistantColorSchemeContext))
	);
}
