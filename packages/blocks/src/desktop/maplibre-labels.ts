// Localized strings for MapLibre's built-in controls. MapLibre ships English
// button titles and aria labels (the compact attribution toggle, zoom buttons,
// popup close, the map's own label) and only takes translations through the
// `locale` option of `new maplibregl.Map`, so every map passes this hook's
// result. `tools/check-third-party-chrome-labels.test.mjs` keeps it that way.
//
// The place names themselves are drawn on the WebGL canvas from the style's
// `text-field`, out of reach of the catalog. `useMaplibreLabelLanguage`
// rewrites those fields to the UI language, falling back to the Latin and
// then the local name where the tiles carry no translation.

import { activeLocale } from "@ryu/i18n/core";
import {
	type LiteralMessage,
	useLiteralMessages,
	useOptionalI18n,
} from "@ryu/i18n/react";
import { type RefObject, useEffect, useRef } from "react";

/** MapLibre's UI string table (namespaced ids to text), translated. */
export function maplibreLocale(tl: LiteralMessage): Record<string, string> {
	return {
		"AttributionControl.ToggleAttribution": tl("Toggle attribution"),
		"AttributionControl.MapFeedback": tl("Map feedback"),
		"Map.Title": tl("Map"),
		"Marker.Title": tl("Map marker"),
		"NavigationControl.ResetBearing": tl(
			"Drag to rotate map, click to reset north"
		),
		"NavigationControl.ZoomIn": tl("Zoom in"),
		"NavigationControl.ZoomOut": tl("Zoom out"),
		"Popup.Close": tl("Close popup"),
	};
}

/**
 * MapLibre's `locale` option in the active locale. MapLibre reads it when the
 * map is built, so the returned object keeps its identity until a string
 * changes; maps that are built once may read it through a ref.
 */
export function useMaplibreLocale(): Record<string, string> {
	const locale = maplibreLocale(useLiteralMessages());
	const key = Object.values(locale).join("\u0000");
	const cache = useRef<{ key: string; locale: Record<string, string> } | null>(
		null
	);
	if (cache.current?.key !== key) {
		cache.current = { key, locale };
	}
	return cache.current.locale;
}

/** The slice of a MapLibre map the label rewrite needs. */
export interface LabelLanguageMap {
	getLayoutProperty(layerId: string, name: string): unknown;
	getStyle(): { layers?: readonly { id: string; type: string }[] } | undefined;
	off(type: "style.load", listener: () => void): unknown;
	on(type: "style.load", listener: () => void): unknown;
	setLayoutProperty(layerId: string, name: string, value: unknown): unknown;
}

/** A label expression that reads a feature name (not a road ref or house number). */
const NAME_FIELD = /"name(?:[:_][\w-]+)?"|\{name/u;

/** The OpenMapTiles `name:<lang>` suffix for a UI locale: zh-CN → zh, pt-BR → pt. */
export function mapLabelLanguage(locale: string): string {
	return (locale.split(/[-_]/u)[0] ?? "en").toLowerCase() || "en";
}

/** The UI language first, then the Latin name, then the local name. */
export function localizedNameField(language: string): unknown[] {
	return [
		"coalesce",
		["get", `name:${language}`],
		["get", "name:latin"],
		["get", "name"],
	];
}

/**
 * Points every symbol layer that prints a feature name at the UI language.
 * Idempotent, so it can run on every style load.
 */
export function localizeMapLabels(map: LabelLanguageMap, locale: string): void {
	const field = localizedNameField(mapLabelLanguage(locale));
	const wanted = JSON.stringify(field);
	try {
		// A style that is still loading serializes to undefined; its own
		// style.load runs this again.
		for (const layer of map.getStyle()?.layers ?? []) {
			if (layer.type !== "symbol") {
				continue;
			}
			const current = JSON.stringify(
				map.getLayoutProperty(layer.id, "text-field") ?? null
			);
			if (current === wanted || !NAME_FIELD.test(current)) {
				continue;
			}
			map.setLayoutProperty(layer.id, "text-field", field);
		}
	} catch {
		// A removed map or a style swap in flight: the next style.load retries.
	}
}

interface AttachedLabels {
	apply: () => void;
	locale: string;
	map: LabelLanguageMap;
}

/**
 * Keeps a map's place labels in the UI language: now, after every style
 * load (a theme swap replaces the style) and whenever the language changes.
 * Call it after the effect that builds the map; it follows whichever map the
 * ref holds after each commit, so maps rebuilt on a condition are covered.
 */
export function useMaplibreLabelLanguage(
	mapRef: RefObject<LabelLanguageMap | null>
): void {
	const locale = useOptionalI18n()?.locale ?? activeLocale();
	const attached = useRef<AttachedLabels | null>(null);
	// No dependency list: the map behind the ref can change without a render
	// of its own, so every commit checks it (a cheap identity comparison).
	useEffect(() => {
		const map = mapRef.current;
		const previous = attached.current;
		if (previous?.map === map && previous.locale === locale) {
			return;
		}
		previous?.map.off("style.load", previous.apply);
		attached.current = null;
		if (!map) {
			return;
		}
		const apply = () => localizeMapLabels(map, locale);
		// Not gated on isStyleLoaded(): that stays false while tiles load, so a
		// language switch mid-pan would be skipped with no style.load to follow.
		apply();
		map.on("style.load", apply);
		attached.current = { apply, locale, map };
	});
	useEffect(
		() => () => {
			const previous = attached.current;
			previous?.map.off("style.load", previous.apply);
			attached.current = null;
		},
		[]
	);
}
