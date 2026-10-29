import { z } from "zod";

const CHART_KEY_UNSAFE_RE = /[^a-zA-Z0-9_-]/gu;
// `var(--token)` is allowed only as a bare custom-property reference (no
// fallback, no nesting) so theme tokens like `var(--color-profile-chart-7)` work.
const CHART_COLOR_RE =
	/^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\([^{};]*\)|var\(--[a-z0-9_-]{1,64}\)|[a-z][a-z0-9-]*)$/iu;

/** Turn an arbitrary series key into a stable CSS custom-property suffix. */
export function chartColorVariableName(key: string): `--color-${string}` {
	const normalized = key
		.trim()
		.replace(CHART_KEY_UNSAFE_RE, "-")
		.replace(/-{2,}/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 64);
	return `--color-${normalized || "series"}`;
}

/** Keep identifiers used in CSS selectors and SVG ids to a safe alphabet. */
export function sanitizeChartIdentifier(value: string): string {
	return value.replace(CHART_KEY_UNSAFE_RE, "").slice(0, 64) || "chart";
}

/** Decode the exact CSS color grammar accepted by chart declarations. */
export const chartColorSchema = z
	.string()
	.trim()
	.regex(CHART_COLOR_RE)
	.nullable()
	.catch(null);

/** Invalid or absent persisted chart colors retain the existing null fallback. */
export const safeChartColor = chartColorSchema.parse;
