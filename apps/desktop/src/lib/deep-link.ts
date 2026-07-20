// apps/desktop/src/lib/deep-link.ts
//
// The `ryu://` deep-link grammar (parser, builder, page list, types) is owned by
// `@ryuhq/protocol/deep-link` — the single source of truth shared by desktop, web,
// and mobile (the copies used to drift). Import those directly from the package.
// Only `pickRecommendedQuant`, which depends on the desktop model-catalog type,
// lives here.

import type { ModelFile } from "./api/models.ts";

// Worst → best is the reverse; lower rank = better fit for this device.
const FIT_RANK: Record<ModelFile["fit"], number> = {
	great: 0,
	ok: 1,
	partial: 2,
	cpu: 3,
	unknown: 4,
	too_big: 5,
};

/**
 * Pick the quantization to pre-select when a deep link asks to install a model:
 * the best device fit, breaking ties toward the smaller file (more likely to
 * actually run). Returns `null` only when there are no files at all. An already
 * installed quant is preferred so re-triggering a link is a no-op.
 */
export function pickRecommendedQuant(files: ModelFile[]): ModelFile | null {
	if (files.length === 0) {
		return null;
	}
	const alreadyInstalled = files.find((f) => f.installed);
	if (alreadyInstalled) {
		return alreadyInstalled;
	}
	return files.reduce((best, f) => {
		const byFit = FIT_RANK[f.fit] - FIT_RANK[best.fit];
		if (byFit !== 0) {
			return byFit < 0 ? f : best;
		}
		const fSize = f.sizeBytes ?? Number.POSITIVE_INFINITY;
		const bestSize = best.sizeBytes ?? Number.POSITIVE_INFINITY;
		return fSize < bestSize ? f : best;
	});
}
