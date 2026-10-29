// apps/desktop/src/lib/catalog/friendly.ts
//
// Desktop display helpers for raw catalog strings. The shared vocabulary
// (recognized-token badges, Small/Medium/Large size tiers, plain-language
// compression levels, friendly names, GGUF roles, pipeline modalities) lives in
// `@ryu/marketplace/catalog/friendly`, so desktop and web read one
// implementation; it is re-exported here so desktop import paths stay stable.
// This file adds only the desktop surfaces on top of it: the Download Center row
// label, the one-line model display for pickers, and the catalog search
// haystacks.
//
// Nothing here hits the network or React; it is unit-tested in
// `friendly.test.ts`.

import {
	extractTokens,
	friendlyModelName,
	friendlyQuant,
	parseModelSize,
	type QuantInfo,
	titleCase,
} from "@ryu/marketplace/catalog/friendly";
import type { ModelCard } from "@/src/lib/api/models.ts";
import type { SkillCard } from "@/src/lib/api/skills.ts";

export {
	displayTokens,
	extractTokens,
	friendlyModelName,
	friendlyQuant,
	ggufFileRole,
	isModelGgufFile,
	parseModelSize,
	parsePipelineModalities,
	quantVariantRank,
	skillOrg,
	titleCase,
} from "@ryu/marketplace/catalog/friendly";

// A download label's `name (detail)` shape, e.g.
// "unsloth/gemma-4-12B-it-GGUF (gemma-4-12B-it-Q4_K_M.gguf)". The detail is the
// filename / quant / role that tells the user exactly what's being fetched, so
// it is never dropped — only the name half is made friendly.
const DOWNLOAD_LABEL_RE = /^(.*?)\s*\(([^)]*)\)\s*$/;
// A GGUF quant token anywhere in a filename: K-quant / IQ families, legacy
// Q4_0-style, or full-precision F16/BF16/F32. Top-level literal — never per call.
const QUANT_IN_FILENAME_RE = /\b(I?Q\d[\w]*|[FB]F?(?:16|32))\b/i;

/**
 * Friendly display name for a Download Center row. Only `model` and `skill`
 * downloads carry the cryptic developer strings a non-technical user can't read;
 * every other kind (engine/agent/tool/voice/media binaries) already has a clean
 * label and is returned untouched.
 *
 * For a model it splits the `name (detail)` shape, makes only the repo name
 * friendly ({@link friendlyModelName} on the last path segment), and maps a
 * quant-looking detail through {@link friendlyQuant} while keeping any other
 * detail verbatim. The detail is preserved either way so the user still knows
 * which file/quant is downloading. **Any parse miss or empty result falls back
 * to the raw label** — a friendly name is never worth losing information over.
 */
export function friendlyDownloadLabel(label: string, kind: string): string {
	if (kind === "skill") {
		const titled = titleCase(label);
		return titled.length > 0 ? titled : label;
	}
	if (kind !== "model") {
		return label;
	}

	const m = DOWNLOAD_LABEL_RE.exec(label);
	const namePart = (m ? m[1] : label).trim();
	const detail = m ? m[2].trim() : "";
	const lastSegment = namePart.split("/").pop() ?? namePart;
	const friendlyName = friendlyModelName(lastSegment);
	if (friendlyName.length === 0) {
		return label;
	}

	if (detail.length === 0) {
		return friendlyName;
	}
	const quantMatch = QUANT_IN_FILENAME_RE.exec(detail);
	const friendlyDetail = quantMatch
		? friendlyQuant(quantMatch[1]).label
		: detail;
	return `${friendlyName} · ${friendlyDetail}`;
}

/** A friendly, inline model display (for pickers/labels that have no badge row). */
export interface FriendlyModelDisplay {
	/** Friendly name plus " · <friendly compression>" when a quant is present. */
	label: string;
	/** Just the friendly model name (quant stripped) — compact, for a trigger. */
	name: string;
	/** The raw original string, surfaced verbatim in a hover tooltip. */
	original: string;
	/** Friendly compression info when the raw carried a quant token, else `null`. */
	quant: QuantInfo | null;
	/** Ready-to-show hover text: the original id plus the quant explanation. */
	tooltip: string;
}

/**
 * Friendly inline display for a single model name/id that may embed a quant
 * (`gemma-4-12B-it-Q4_K_M`, `unsloth/gemma-4-12B-it-GGUF`, a served-file stem, an
 * ACP-advertised name). Unlike the catalog — which renders the name and the quant
 * as separate elements (a clean name + a quality meter badge) — a picker or a
 * one-line label has nowhere to put a badge, so this folds the *same* vocabulary
 * (`friendlyModelName` + `friendlyQuant`, never a raw `Q4_K_M`) into one string
 * and keeps the raw original for a hover tooltip. Selection elsewhere is by id, so
 * the friendlier text is purely cosmetic.
 */
export function friendlyModelDisplay(raw: string): FriendlyModelDisplay {
	// Only the last path segment carries the model id ("org/repo" → "repo").
	const last = raw.split("/").pop() ?? raw;
	const quantMatch = QUANT_IN_FILENAME_RE.exec(last);
	const quant = quantMatch ? friendlyQuant(quantMatch[1]) : null;
	// Strip the quant token before friendly-naming so it isn't mangled into the
	// nonsense "Q4 K M" (the underscores split into separate, meaningless words).
	const withoutQuant = quantMatch ? last.replace(quantMatch[0], " ") : last;
	const name = friendlyModelName(withoutQuant);
	const label = quant ? `${name} · ${quant.label}` : name;
	const tooltip = quant ? `${raw}\n${quant.tooltip}` : raw;
	return { name, label, quant, original: raw, tooltip };
}

// ── Search ──────────────────────────────────────────────────────────────────

/** Lowercased haystack for a model card: name, author, id, tags, token labels, size. */
export function modelHaystack(card: ModelCard): string {
	const tokens = extractTokens(card.name, card.tags).map((t) => t.label);
	const size = parseModelSize(card.name);
	return [
		card.name,
		friendlyModelName(card.name, card.tags),
		card.author,
		card.id,
		card.pipelineTag ?? "",
		...card.tags,
		...tokens,
		size?.raw ?? "",
		size?.tier ?? "",
	]
		.join(" ")
		.toLowerCase();
}

/** Lowercased haystack for a skill card: name, source/org, slug, id, and the
 *  one-line description when the card carries one (installed skills do), so
 *  searching for what a skill DOES finds it, not only what it is called. */
export function skillHaystack(card: SkillCard): string {
	return [
		card.name,
		titleCase(card.name),
		card.source,
		card.slug,
		card.id,
		card.description ?? "",
	]
		.join(" ")
		.toLowerCase();
}

const WHITESPACE_RE = /\s+/;

/** Whether a lowercased haystack contains every whitespace-separated term in `q`. */
export function matchesQuery(haystack: string, q: string): boolean {
	const terms = q.toLowerCase().trim().split(WHITESPACE_RE).filter(Boolean);
	return terms.every((t) => haystack.includes(t));
}
