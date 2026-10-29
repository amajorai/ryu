// Reads the app's live design tokens for the artifact sandbox (see
// artifact-srcdoc.ts). The iframe runs at a null origin and cannot inherit the
// host's CSS, so the computed values are copied in. Re-reads when the theme
// class or inline token overrides on <html> change.

import { useEffect, useState } from "react";
import {
	ARTIFACT_THEME_TOKENS,
	type ArtifactTheme,
} from "@/src/lib/artifact-srcdoc.ts";

function readArtifactTheme(): ArtifactTheme | undefined {
	if (globalThis.document === undefined) {
		return;
	}
	const root = document.documentElement;
	const computed = getComputedStyle(root);
	const tokens: ArtifactTheme["tokens"] = {};
	for (const name of ARTIFACT_THEME_TOKENS) {
		const value = computed.getPropertyValue(name).trim();
		if (value) {
			tokens[name] = value;
		}
	}
	return { dark: root.classList.contains("dark"), tokens };
}

function sameTheme(a: ArtifactTheme | undefined, b: ArtifactTheme | undefined) {
	if (!(a && b) || a.dark !== b.dark) {
		return a === b;
	}
	return ARTIFACT_THEME_TOKENS.every(
		(name) => a.tokens[name] === b.tokens[name]
	);
}

export function useArtifactTheme(): ArtifactTheme | undefined {
	const [theme, setTheme] = useState(readArtifactTheme);

	useEffect(() => {
		if (globalThis.MutationObserver === undefined) {
			return;
		}
		const observer = new MutationObserver(() => {
			const next = readArtifactTheme();
			setTheme((current) => (sameTheme(current, next) ? current : next));
		});
		observer.observe(document.documentElement, {
			attributeFilter: ["class", "style", "data-theme"],
			attributes: true,
		});
		return () => observer.disconnect();
	}, []);

	return theme;
}
