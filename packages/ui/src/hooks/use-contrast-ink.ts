"use client";

// Pick the theme colour that reads best ON another theme colour.
//
// A surface painted `--primary` cannot hardcode its ink: `--primary` is
// user-editable (the Appearance colour picker writes a custom variant) and a
// plugin theme can set it to anything, so "white on primary" is right for the
// brand blue and wrong for a pale yellow one. Rather than add a token, this
// resolves the *computed* value of each var off `<html>` and returns whichever
// candidate has the larger luminance gap from the surface.
//
// The values are read from `getComputedStyle(document.documentElement)` because
// `applyVariant` writes the active preset as INLINE styles on `<html>` — the
// stylesheet is not the source of truth at runtime. Same reason for the
// observer: a preset switch is an attribute mutation on that element, with no
// React render to hang the recompute off.

import { colorToHex, relativeLuminance } from "@ryu/ui/theme/presets.ts";
import { useEffect, useState } from "react";

function resolve(el: HTMLElement, name: string): string | null {
	return colorToHex(getComputedStyle(el).getPropertyValue(name).trim());
}

/**
 * Returns a CSS colour value — `var(--foreground)` or `var(--background)` —
 * for text/icons drawn on top of `surfaceVar`.
 *
 * Falls back to `--primary-foreground` (SSR, or a colour we cannot parse) so
 * the first paint is never an unreadable guess.
 */
export function useContrastInk(
	surfaceVar = "--primary",
	candidates: readonly [string, string] = ["--foreground", "--background"]
): string {
	const [a, b] = candidates;
	const [ink, setInk] = useState("var(--primary-foreground)");

	useEffect(() => {
		const el = document.documentElement;
		const recompute = () => {
			const surface = resolve(el, surfaceVar);
			const hexA = resolve(el, a);
			const hexB = resolve(el, b);
			if (!(surface && hexA && hexB)) {
				return;
			}
			const lum = relativeLuminance(surface);
			const gapA = Math.abs(relativeLuminance(hexA) - lum);
			const gapB = Math.abs(relativeLuminance(hexB) - lum);
			setInk(`var(${gapA >= gapB ? a : b})`);
		};
		recompute();
		// `class` covers the light/dark flip, `style` the preset/custom-colour
		// write. Both land on <html>, neither re-renders this component.
		const observer = new MutationObserver(recompute);
		observer.observe(el, {
			attributeFilter: ["class", "style"],
		});
		return () => observer.disconnect();
	}, [surfaceVar, a, b]);

	return ink;
}
