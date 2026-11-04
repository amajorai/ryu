import {
	activeLocale,
	numberFormatter,
	relativeTimeFormatter,
	translate as tl,
} from "@ryu/i18n/lite";
import { formatCount as formatSharedCount } from "@ryu/ui/lib/number-format.ts";
import type { ComponentType } from "react";
import {
	type ActiveChip,
	ORG_ICON,
	tokenIcon,
} from "./chrome/catalog-badges.tsx";
import { CATALOG_TOKENS, extractTokens } from "./friendly.ts";
import type { CatalogInstallButtonProps } from "./host.tsx";
import type {
	ModelCard,
	ModelDetail,
	ModelFormat,
	ModelSort,
} from "./types.ts";

/** The host-provided install button, injected wherever an install action renders. */
export type InstallButton = ComponentType<CatalogInstallButtonProps>;
/** The host-provided device-fit color resolver. */
export type FitStyle = (fit: string) => { className: string; dot: string };

/** Token id → friendly label, for building active-filter chip text. */
const TOKEN_LABEL = new Map(CATALOG_TOKENS.map((t) => [t.id, t.label]));

/** Deep-link the selected base model into the fine-tune Companion. */
export function fineTuneHrefForModel(modelId: string): string {
	return `/plugin/@ryu/finetune?base_model_id=${encodeURIComponent(modelId)}`;
}

/** Refine loaded models to those carrying every active token-badge filter. */
export function filterModelsByTokens(
	models: ModelCard[],
	activeTokens: Set<string>,
	org: string
): ModelCard[] {
	const normalizedOrg = org.trim().toLowerCase();
	return models.filter((m) => {
		if (normalizedOrg && m.author.toLowerCase() !== normalizedOrg) {
			return false;
		}
		if (activeTokens.size === 0) {
			return true;
		}
		const ids = new Set(extractTokens(m.name, m.tags).map((t) => t.id));
		for (const id of activeTokens) {
			if (!ids.has(id)) {
				return false;
			}
		}
		return true;
	});
}

/** Build the toolbar's removable chips for the active org + token filters. */
export function buildModelChips(
	org: string,
	activeTokens: Set<string>,
	setOrg: (o: string) => void,
	toggleToken: (id: string) => void
): ActiveChip[] {
	const out: ActiveChip[] = [];
	if (org) {
		out.push({
			key: `org:${org}`,
			label: tl("Org: {org}", { org }),
			icon: ORG_ICON,
			onRemove: () => setOrg(""),
		});
	}
	for (const id of activeTokens) {
		out.push({
			key: `token:${id}`,
			label: TOKEN_LABEL.get(id) ?? id,
			icon: tokenIcon(id),
			onRemove: () => toggleToken(id),
		});
	}
	return out;
}

export const SORT_OPTIONS: { value: ModelSort; label: string }[] = [
	{ value: "trending", label: "Trending" },
	{ value: "downloads", label: "Popular" },
	{ value: "likes", label: "Most liked" },
	{ value: "recent", label: "Newest" },
];

/** Weight-format facet. Each maps to an engine family; the catalog lists one
 *  format at a time (one clean Hub cursor per format). */
export const FORMAT_OPTIONS: { value: ModelFormat; label: string }[] = [
	{ value: "gguf", label: "Runs anywhere (GGUF)" },
	{ value: "safetensors", label: "Full quality (Safetensors)" },
	{ value: "mlx", label: "Apple Silicon (MLX)" },
];

/** Largest-first calendar units for relative-time formatting (ms per unit). */
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["year", 365 * 24 * 60 * 60 * 1000],
	["month", 30 * 24 * 60 * 60 * 1000],
	["week", 7 * 24 * 60 * 60 * 1000],
	["day", 24 * 60 * 60 * 1000],
	["hour", 60 * 60 * 1000],
	["minute", 60 * 1000],
];

/** Relative age of an ISO-8601 timestamp, e.g. "3 months ago". `null` when the
 *  date is missing or unparseable, so callers can omit the chip entirely.
 *  Uses the native Intl formatter — no third-party date dependency. */
export function formatAgo(
	iso: string | null,
	locale: string = activeLocale()
): string | null {
	if (!iso) {
		return null;
	}
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	// Cached per locale, so this stays cheap inside a render loop.
	const relativeTime = relativeTimeFormatter(locale, "long", "auto");
	const diffMs = date.getTime() - Date.now();
	const absMs = Math.abs(diffMs);
	for (const [unit, unitMs] of RELATIVE_UNITS) {
		if (absMs >= unitMs) {
			return relativeTime.format(Math.round(diffMs / unitMs), unit);
		}
	}
	return relativeTime.format(Math.round(diffMs / 1000), "second");
}

/** Absolute calendar date for a detail line, e.g. "10 Jun 2026", in `locale`. */
export function formatDate(
	iso: string | null,
	locale: string = activeLocale()
): string | null {
	if (!iso) {
		return null;
	}
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return date.toLocaleDateString(locale, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

/** Shared count policy, exported for the catalog helper tests. */
export function formatCount(n: number): string {
	return formatSharedCount(n) ?? "—";
}

/** Friendly context-window string (32768 → "32,768", 1048576 → "1m"). `null` when
 *  the Hub didn't report a context length, so callers can omit the chip. */
export function formatContext(tokens: number | null): string | null {
	if (!tokens || tokens <= 0) {
		return null;
	}
	return formatSharedCount(tokens);
}

/** Friendly parameter-count string (999885952 → "1.0B", 8e9 → "8.0B"). `null`
 *  when unknown. Uses 1B = 1e9 (HF reports decimal parameter counts). The
 *  number uses the reader's decimal mark ("8,0B" in German); "B" and "M" are
 *  model-size unit suffixes, not words. */
export function formatParams(
	n: number | null,
	locale: string = activeLocale()
): string | null {
	if (!n || n <= 0) {
		return null;
	}
	const digits = (value: number, fractionDigits: number) =>
		numberFormatter(locale, {
			maximumFractionDigits: fractionDigits,
			minimumFractionDigits: fractionDigits,
			useGrouping: false,
		}).format(value);
	if (n >= 500_000_000) {
		const b = n / 1_000_000_000;
		return `${b >= 10 ? digits(Math.round(b), 0) : digits(b, 1)}B`;
	}
	if (n >= 1_000_000) {
		return `${digits(Math.round(n / 1_000_000), 0)}M`;
	}
	return digits(n, 0);
}

/** Multi-line hardware summary for the detail overview, in the UI language. */
export function deviceSummaryLines(device: ModelDetail["device"]): string[] {
	// Free disk decides whether a download can land at all, so it closes every
	// summary (when Core reports it).
	const disk = device.diskFreeHuman
		? [tl("{diskFree} free disk", { diskFree: device.diskFreeHuman })]
		: [];
	if (device.unifiedMemory && device.ramHuman) {
		return [tl("{ram} unified memory", { ram: device.ramHuman }), ...disk];
	}
	const lines: string[] = [];
	if (device.gpuName) {
		lines.push(device.gpuName);
	}
	if (device.vramHuman) {
		lines.push(tl("{vram} GPU RAM", { vram: device.vramHuman }));
	}
	if (device.ramHuman) {
		lines.push(tl("{ram} system RAM", { ram: device.ramHuman }));
	}
	if (lines.length === 0) {
		return [device.os || tl("unknown hardware"), ...disk];
	}
	return [...lines, ...disk];
}
