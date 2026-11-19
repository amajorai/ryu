// Theme CSS for the sandboxed Companion documents: the host-owned scale and font
// layout rule, the sanitized theme-token `<style>` bridge, and the legacy alias map
// the generated bootstraps also apply at runtime (`applyThemeTokens`).

import { z } from "zod";

// Self-contained app bundles do not necessarily import the shared Companion
// stylesheet. Keep scale host-owned at the document boundary so those bundles
// still receive the user's zoom preference. First-party bundles may declare the
// same rule themselves; the value is identical and this declaration wins over
// an app-local fixed zoom.
/** CSS that applies the host's scale exactly once at the Companion boundary. */
export function buildCompanionThemeLayoutCss(scaleInParent: boolean): string {
	const zoom = scaleInParent
		? "html body{zoom:1 !important;}"
		: "html body{zoom:var(--ryu-ui-scale, 1) !important;}";
	return `${zoom}html body{font-family:var(--font-sans, system-ui, sans-serif) !important;}html body :where(h1,h2,h3,h4,h5,h6){font-family:var(--font-heading, var(--font-sans, system-ui, sans-serif)) !important;}html body :where(code,pre,kbd,samp){font-family:var(--font-code, var(--font-mono, monospace)) !important;}`;
}

/**
 * Compatibility aliases for self-contained companions that predate the shared
 * semantic token names. New UI should use the canonical names directly; the
 * aliases keep shipped app bundles in the active Ryu theme until they are
 * rebuilt.
 */
export const COMPANION_THEME_ALIASES = {
	"--bg": "--background",
	"--fg": "--foreground",
	"--text": "--foreground",
	"--ink": "--foreground",
	"--panel": "--card",
	"--panel-2": "--muted",
	"--raised": "--card",
	"--glass": "--card",
	"--line": "--border",
	"--accent-fg": "--accent-foreground",
	"--ok": "--success",
	"--good": "--success",
	"--warn": "--warning",
	"--bad": "--destructive",
	"--err": "--destructive",
	"--danger": "--destructive",
	"--cv-bg": "--background",
	"--cv-card": "--card",
	"--cv-border": "--border",
	"--cv-fg": "--foreground",
	"--cv-muted": "--muted-foreground",
	"--cv-primary": "--primary",
	"--cv-danger": "--destructive",
	"--wb-bg": "--background",
	"--wb-border": "--border",
	"--wb-fg": "--foreground",
	"--wb-muted": "--muted-foreground",
	"--wb-accent": "--primary",
	"--rf-paper": "--background",
	"--rf-paper-deep": "--muted",
	"--rf-ink": "--foreground",
	"--rf-muted": "--muted-foreground",
	"--rf-line": "--border",
	"--rf-white": "--card",
	"--rf-sage": "--secondary",
	"--rf-moss": "--success",
	"--rf-blue": "--primary",
} as const;

/** A CSS custom-property name is safe to emit only if it is exactly `--<kebab>`;
 *  everything else is dropped so the theme-token bridge can never inject a stray
 *  selector/declaration. */
const THEME_TOKEN_NAME_RE = /^--[a-z0-9-]+$/;

/** A token VALUE may contain the characters real design-system values use —
 *  `oklch(… / …%)`, `0.625rem`, `#fff` — but NEVER a CSS-structural char that could
 *  break out of the `:root{…}` block or the `<style>` element. A value with any of
 *  `{ } ; < >` is rejected (the whole entry dropped, fail-safe). */
const THEME_TOKEN_VALUE_UNSAFE_RE = /[{}<>;]/;

const safeThemeTokenValueSchema = z
	.string()
	.min(1)
	.refine((value) => !THEME_TOKEN_VALUE_UNSAFE_RE.test(value));

/**
 * Build the theme-token bridge `<style>` block from the host's resolved CSS custom
 * properties (the W7 theme-token bridge). The desktop host reads its live token
 * values (light/dark/custom) at mount and passes them here; emitting them as an
 * `html:root{…}` override makes the sandboxed companion render in the host's ACTIVE
 * resolved theme, on top of the companion's own hardcoded token defaults (which
 * remain the offline/parity fallback). Returns "" when there is nothing safe to
 * inject.
 *
 * The selector is `html:root` (specificity 0,1,1), not `:root` (0,1,0), so it wins
 * over the companion's own `:root{…}` token block REGARDLESS of source order — the
 * host injects the already-resolved values for the active theme. The bootstrap also
 * applies the reserved mode/state values before the app's own styles run.
 *
 * Sanitized hard: only `--kebab` names, only values free of CSS-structural chars,
 * so a (host-controlled, already-trusted) token map can never inject extra
 * declarations or escape the `<style>` element. Under the companion CSP
 * `style-src 'unsafe-inline'`, the inline `<style>` needs no nonce.
 */
const themeTokenInputSchema = z.record(z.string(), z.unknown()).optional();

export function buildThemeTokenStyle(
	input?: z.input<typeof themeTokenInputSchema>
): string {
	const parsedInput = themeTokenInputSchema.safeParse(input);
	const themeTokens = parsedInput.success ? parsedInput.data : undefined;
	if (!themeTokens) {
		return "";
	}
	const decls: string[] = [];

	for (const [name, value] of Object.entries(themeTokens)) {
		const parsed = safeThemeTokenValueSchema.safeParse(value);
		if (THEME_TOKEN_NAME_RE.test(name) && parsed.success) {
			decls.push(`${name}: ${parsed.data.trim()};`);
		}
	}
	for (const [alias, source] of Object.entries(COMPANION_THEME_ALIASES)) {
		const parsed = safeThemeTokenValueSchema.safeParse(themeTokens[source]);
		if (!(alias in themeTokens) && parsed.success) {
			decls.push(`${alias}: ${parsed.data.trim()};`);
		}
	}

	if (decls.length === 0) {
		return "";
	}
	return `<style>html:root{${decls.join("")}}</style>`;
}
