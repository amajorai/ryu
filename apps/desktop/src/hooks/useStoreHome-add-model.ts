import {
	fitBlockReason,
	isBlockedFit,
	isBlockedRepoFit,
} from "@ryu/blocks/desktop/model-fit.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchModelDetail,
	installModelFile,
	installModelSnapshot,
} from "@/src/lib/api/models.ts";
import { pickRecommendedQuant } from "@/src/lib/deep-link.ts";
import type { HomeCard } from "./useStoreHome-types.ts";

/**
 * The Home one-click model add. Fit is computed by the Core node that serves
 * the request: GGUF picks the best quant that is NOT blocked (`too_big` /
 * `no_space`), and a snapshot respects its repo verdict. When nothing fits it
 * throws the plain-language reason instead of starting a download Core would
 * refuse (or that could exhaust the machine's memory or disk).
 */
export async function addModelFromHome(
	modelTarget: ApiTarget,
	card: HomeCard
): Promise<void> {
	const format = card.modelFormat ?? "gguf";
	const detail = await fetchModelDetail(modelTarget, card.id, format);
	if (format !== "gguf") {
		if (isBlockedRepoFit(detail.repoFit, detail.device)) {
			throw new Error(
				fitBlockReason(detail.repoFit, detail.repoFitLabel, detail.device) ??
					`${card.name} won't fit on this device.`
			);
		}
		await installModelSnapshot(modelTarget, card.id, format);
		return;
	}
	const file = pickRecommendedQuant(
		detail.files.filter((candidate) => !candidate.installed)
	);
	if (!file) {
		throw new Error(`No available GGUF file for ${card.id}`);
	}
	// The shared ranking puts blocked quants last, so a blocked pick means no
	// quant of this model fits this device.
	if (isBlockedFit(file.fit)) {
		throw new Error(
			fitBlockReason(file.fit, file.fitLabel, detail.device) ??
				`${card.name} won't fit on this device.`
		);
	}
	await installModelFile(modelTarget, card.id, file.filename);
}
