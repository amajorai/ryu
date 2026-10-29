// apps/desktop/src/lib/deep-link.ts
//
// The `ryu://` deep-link grammar (parser, builder, page list, types) is owned by
// `@ryuhq/protocol/deep-link` — the single source of truth shared by desktop, web,
// and mobile (the copies used to drift). Import those directly from the package.
// Only `pickRecommendedQuant`, which depends on the desktop model-catalog type,
// lives here.

import { pickBestFit } from "@ryu/blocks/desktop/model-fit.ts";
import type { ModelFile } from "./api/models.ts";
import { isModelGgufFile } from "./catalog/friendly.ts";

/**
 * Pick the quantization to pre-select when a deep link asks to install a model:
 * the best device fit, breaking ties toward the smaller file (more likely to
 * actually run). The ranking is the shared `FIT_RANK`, so a blocked quant
 * (`too_big` / `no_space`) is picked only when every quant is blocked — callers
 * must still check `isBlockedFit` before installing. Returns `null` only when
 * there are no files at all. An already installed quant is preferred so
 * re-triggering a link is a no-op.
 */
export function pickRecommendedQuant(files: ModelFile[]): ModelFile | null {
	const modelFiles = files.filter((file) => isModelGgufFile(file.filename));
	if (modelFiles.length === 0) {
		return null;
	}
	const alreadyInstalled = modelFiles.find((f) => f.installed);
	if (alreadyInstalled) {
		return alreadyInstalled;
	}
	return pickBestFit(modelFiles);
}
