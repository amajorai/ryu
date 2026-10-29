// packages/blocks/src/desktop/model-fit.ts
//
// The one client-side reading of Core's device-fit verdicts (`FitVerdict` in
// `crates/core/model-catalog/src/device.rs`). Core computes every verdict against
// the node that serves the request and refuses blocked installs itself (HTTP
// 422); this module only ranks, classifies, and words them so the Store detail
// panel, the Store Home one-click Add, and the deep-link dialog agree. Pure logic
// with no React, so both `@ryu/marketplace` and the desktop app import it.

/** Device-fit rank — lower is a better fit. Blocked verdicts rank last so a
 *  recommendation never prefers an option that cannot be installed. */
export const FIT_RANK = {
	great: 0,
	ok: 1,
	partial: 2,
	cpu: 3,
	unknown: 4,
	too_big: 5,
	no_space: 6,
} as const;

/** Every verdict Core emits, worst → best order lives in {@link FIT_RANK}. */
export type KnownFitVerdict = keyof typeof FIT_RANK;

/** Plain-language labels matching Core's `FitVerdict::label`, used when a
 *  response omits `fit_label`. */
export const FIT_LABELS: Record<KnownFitVerdict, string> = {
	great: "Runs great — fully on your GPU",
	ok: "Runs on your GPU",
	partial: "Only partly fits your GPU — may be slow",
	cpu: "Runs on your CPU only — may be slow",
	unknown: "Can't check your device",
	too_big: "Too large for your device's memory",
	no_space: "Not enough free disk space to download it",
};

/** Short warning shown beside an enabled install of a slow verdict. */
export const SLOW_FIT_WARNING = "May be slow on this device";

function isKnownFit(fit: string): fit is KnownFitVerdict {
	return Object.hasOwn(FIT_RANK, fit);
}

/** Rank any verdict string; an unrecognized one ranks as `unknown`. */
export function fitRank(fit: string): number {
	return isKnownFit(fit) ? FIT_RANK[fit] : FIT_RANK.unknown;
}

/** True when Core refuses to install a file with this verdict. */
export function isBlockedFit(fit: string): boolean {
	return fit === "too_big" || fit === "no_space";
}

/**
 * True when Core refuses to install a snapshot repo with this verdict. An older
 * Core mapped every non-fitting snapshot, partial and CPU included, to a soft
 * `too_big` ("may not fit") and still installed it; only a Core that reports
 * the node's free disk (`diskFreeBytes` present, even as null) refuses it, so
 * without that field `too_big` is a warning, not a block.
 */
export function isBlockedRepoFit(
	fit: string,
	device: { diskFreeBytes?: number | null } | null | undefined
): boolean {
	if (!isBlockedFit(fit)) {
		return false;
	}
	return fit !== "too_big" || device?.diskFreeBytes !== undefined;
}

/** True when the file installs and runs, but on the CPU or with partial offload. */
export function isSlowFit(fit: string): boolean {
	return fit === "cpu" || fit === "partial";
}

/** The device numbers a blocked-install explanation quotes. */
export interface FitDeviceNumbers {
	diskFreeHuman?: string | null;
	ramHuman?: string | null;
	unifiedMemory?: boolean;
	vramHuman?: string | null;
}

function memorySummary(device: FitDeviceNumbers): string | null {
	if (device.unifiedMemory && device.ramHuman) {
		return `${device.ramHuman} of unified memory`;
	}
	const parts: string[] = [];
	if (device.ramHuman) {
		parts.push(`${device.ramHuman} of RAM`);
	}
	if (device.vramHuman) {
		parts.push(`${device.vramHuman} of GPU memory`);
	}
	return parts.length > 0 ? parts.join(" and ") : null;
}

/**
 * Why an install is disabled, in one sentence with the device's numbers, or
 * `null` when the verdict does not block. `label` is Core's `fit_label`; the
 * built-in label is used when it is empty.
 */
export function fitBlockReason(
	fit: string,
	label: string | null | undefined,
	device: FitDeviceNumbers | null | undefined
): string | null {
	if (!isBlockedFit(fit)) {
		return null;
	}
	// Core's snapshot labels are full sentences; drop their final period so the
	// joined sentence never reads "…memory.. This device has …".
	const verdictLabel = (
		label?.trim() || (isKnownFit(fit) ? FIT_LABELS[fit] : "")
	).replace(/\.+$/, "");
	let detail: string | null = null;
	if (fit === "no_space" && device?.diskFreeHuman) {
		detail = `Only ${device.diskFreeHuman} is free on the models drive.`;
	} else if (fit === "too_big" && device) {
		const memory = memorySummary(device);
		detail = memory ? `This device has ${memory}.` : null;
	}
	return detail ? `${verdictLabel}. ${detail}` : `${verdictLabel}.`;
}

/** The minimal file shape the recommendation ranking reads. */
export interface FitRankedFile {
	fit: string;
	sizeBytes: number | null;
}

/**
 * Pick the best device fit, breaking ties toward the smaller file (more likely
 * to actually run). Blocked files rank last, so the result is blocked only when
 * every file is. `null` only for an empty list.
 */
export function pickBestFit<TFile extends FitRankedFile>(
	files: readonly TFile[]
): TFile | null {
	let best: TFile | null = null;
	for (const file of files) {
		if (best === null || isBetterFit(file, best)) {
			best = file;
		}
	}
	return best;
}

/** Whether `candidate` beats `current`: a better fit, else a smaller file. */
function isBetterFit(
	candidate: FitRankedFile,
	current: FitRankedFile
): boolean {
	const byFit = fitRank(candidate.fit) - fitRank(current.fit);
	if (byFit !== 0) {
		return byFit < 0;
	}
	const candidateSize = candidate.sizeBytes ?? Number.POSITIVE_INFINITY;
	const currentSize = current.sizeBytes ?? Number.POSITIVE_INFINITY;
	return candidateSize < currentSize;
}
