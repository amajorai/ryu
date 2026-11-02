"use client";

import { useOptionalI18n } from "@ryu/i18n/react";
import { useEffect, useRef, useState } from "react";
import {
	localizePierreShadowRoot,
	type PierreShadowLocalizer,
} from "./pierre-shadow-copy.ts";

/** Hosts @pierre/diffs (`<diffs-container>`) and @pierre/trees draw into. */
const PIERRE_HOSTS = "diffs-container, file-tree-container";

/**
 * Translate the fixed copy @pierre/diffs and @pierre/trees draw inside their
 * shadow roots, for every such host under the element this returns a ref for.
 * Hosts that mount later (a lazily loaded diff, a hover card) are picked up,
 * and the copy follows UI language changes. Pass the result as a `ref`.
 */
export function usePierreShadowLocalizer(): (
	container: HTMLElement | null
) => void {
	const [container, setContainer] = useState<HTMLElement | null>(null);
	const localizersRef = useRef(new Map<ShadowRoot, PierreShadowLocalizer>());
	const i18n = useOptionalI18n();

	useEffect(() => {
		if (!container || globalThis.MutationObserver === undefined) {
			return;
		}
		const localizers = localizersRef.current;
		const sync = () => {
			const roots = new Set<ShadowRoot>();
			for (const host of container.querySelectorAll(PIERRE_HOSTS)) {
				if (host.shadowRoot) {
					roots.add(host.shadowRoot);
				}
			}
			for (const [root, localizer] of localizers) {
				if (!roots.has(root)) {
					localizer.dispose();
					localizers.delete(root);
				}
			}
			for (const root of roots) {
				if (!localizers.has(root)) {
					localizers.set(root, localizePierreShadowRoot(root));
				}
			}
		};
		sync();
		const observer = new MutationObserver(sync);
		observer.observe(container, { childList: true, subtree: true });
		return () => {
			observer.disconnect();
			for (const localizer of localizers.values()) {
				localizer.dispose();
			}
			localizers.clear();
		};
	}, [container]);

	const locale = i18n?.locale;
	const version = i18n?.version;
	useEffect(() => {
		// Read so a language or catalog change re-runs this effect.
		if (locale === undefined && version === undefined) {
			return;
		}
		for (const localizer of localizersRef.current.values()) {
			localizer.refresh();
		}
	}, [locale, version]);

	return setContainer;
}
