import type { ComposerSettingItem } from "@/components/agent-elements/input/composer-settings-menu.tsx";

/** The tag a Ryu Router model wears when free credit pays for it. */
export const FREE_MODEL_TAG = "Free";

/** The user's free credit: every active grant summed, plus the nearest expiry. */
export interface FreeCredit {
	/** The soonest expiry among the grants, ISO, or null when none lapses. */
	expiresAt: string | null;
	remainingMicroUsd: number;
}

/**
 * Fold per-pool grant balances into the ONE free-credit figure a user sees.
 * Free credit is not tied to a model family or supplier any more, so showing
 * it per pool would only invent distinctions. `null` when there is none.
 */
export function totalFreeCredit(
	grants: ReadonlyArray<{ expiresAt: string | null; remainingMicroUsd: number }>
): FreeCredit | null {
	let remainingMicroUsd = 0;
	let expiresAt: string | null = null;
	for (const grant of grants) {
		if (!(grant.remainingMicroUsd > 0)) {
			continue;
		}
		remainingMicroUsd += grant.remainingMicroUsd;
		if (
			grant.expiresAt &&
			(expiresAt === null ||
				Date.parse(grant.expiresAt) < Date.parse(expiresAt))
		) {
			expiresAt = grant.expiresAt;
		}
	}
	return remainingMicroUsd > 0 ? { expiresAt, remainingMicroUsd } : null;
}

/**
 * Tag the models free credit pays for. `freeModelIds` is Core's
 * `freeModels` for the Ryu Router row — the Gateway router's equivalence
 * table, so the tag and the routing share one source of truth. Absent ⇒ the
 * items are returned unchanged (no free credit, or not the Ryu Router row).
 */
export function tagFreeModels(
	items: ComposerSettingItem[],
	freeModelIds: ReadonlySet<string> | undefined
): ComposerSettingItem[] {
	if (!freeModelIds || freeModelIds.size === 0) {
		return items;
	}
	const free = new Set([...freeModelIds].map((id) => id.toLowerCase()));
	return items.map((item) =>
		free.has(item.id.toLowerCase()) ? { ...item, tag: FREE_MODEL_TAG } : item
	);
}
