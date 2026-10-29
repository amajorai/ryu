// Shared helpers for the evaluator catalog surfaces. Maps the wire `Evaluator`
// onto the decoupled presentational `EvaluatorCatalogItem` the blocks catalog
// renders, and splits a set of selected offline evaluators into the two request
// arrays the runner needs (registry ids vs. Core-run code specs).

import type { EvaluatorCatalogItem } from "@ryu/blocks/desktop/evaluator-catalog.tsx";
import type { CodeEvaluatorSpec, Evaluator } from "@/src/lib/api/gateway.ts";

/** Project a wire `Evaluator` onto the presentational catalog item. */
export function toCatalogItem(e: Evaluator): EvaluatorCatalogItem {
	return {
		id: e.id,
		name: e.name,
		description: e.description,
		category: e.category,
		target: e.target,
		capInline: e.capabilities.inline,
		capOffline: e.capabilities.offline,
		implKind: e.impl.kind,
		builtin: e.builtin,
		enforced: e.enforced,
	};
}

/** Core's agent eval runner can execute populated code definitions locally. */
export function toOfflineCatalogItem(e: Evaluator): EvaluatorCatalogItem {
	const item = toCatalogItem(e);
	if (
		e.impl.kind === "code" &&
		e.impl.source.trim().length > 0 &&
		e.target !== "image" &&
		e.target !== "audio"
	) {
		return { ...item, capOffline: true };
	}
	return item;
}

/**
 * Split selected offline evaluators into the two request arrays:
 *   • `evaluators` — registry ids the gateway scores (regex/heuristic/llm_judge/builtin).
 *   • `codeEvaluators` — Code evaluators the Core proxy runs locally and merges.
 * A code evaluator's id belongs ONLY in `codeEvaluators` (Core injects its score).
 */
export function splitOfflineSelection(
	selectedIds: string[],
	catalog: Evaluator[]
) {
	const byId = new Map(catalog.map((e) => [e.id, e]));
	const evaluators: string[] = [];
	const codeEvaluators: CodeEvaluatorSpec[] = [];
	for (const id of selectedIds) {
		const e = byId.get(id);
		if (e && e.impl.kind === "code" && toOfflineCatalogItem(e).capOffline) {
			codeEvaluators.push({
				id: e.id,
				lang: e.impl.lang,
				source: e.impl.source,
			});
		} else {
			evaluators.push(id);
		}
	}
	return { evaluators, codeEvaluators };
}
