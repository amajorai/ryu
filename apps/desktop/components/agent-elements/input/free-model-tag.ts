import type { ComposerSettingItem } from "@/components/agent-elements/input/composer-settings-menu.tsx";

/** The tag a Ryu Router model wears when free credit pays for it. */
export const FREE_MODEL_TAG = "Free";

/** The user's free credit: every active grant summed, plus the nearest expiry. */
export interface FreeCredit {
	/** The soonest expiry among the grants, ISO, or null when none lapses. */
	expiresAt: string | null;
	/**
	 * The Ryu Router model ids the user's grants can pay for (separate pools:
	 * each pool's grant pays only for its own models). Undefined when the
	 * control plane did not say, which keeps every Free id tagged.
	 */
	payableModelIds?: ReadonlySet<string>;
	remainingMicroUsd: number;
}

/**
 * Fold per-pool grant balances into the ONE free-credit figure a user sees,
 * plus the union of the models those pools pay for. The balance stays one
 * number; only the Free tag follows the pools. `null` when there is none.
 */
export function totalFreeCredit(
	grants: ReadonlyArray<{
		expiresAt: string | null;
		freeModelIds?: readonly string[];
		remainingMicroUsd: number;
	}>
): FreeCredit | null {
	let remainingMicroUsd = 0;
	let expiresAt: string | null = null;
	let payable: Set<string> | undefined;
	for (const grant of grants) {
		if (!(grant.remainingMicroUsd > 0)) {
			continue;
		}
		if (grant.freeModelIds) {
			payable ??= new Set();
			for (const id of grant.freeModelIds) {
				payable.add(id.toLowerCase());
			}
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
	if (!(remainingMicroUsd > 0)) {
		return null;
	}
	return payable
		? { expiresAt, payableModelIds: payable, remainingMicroUsd }
		: { expiresAt, remainingMicroUsd };
}

/**
 * The Free ids to tag for this user: Core's Free list (what the Gateway routes
 * to own supply), narrowed to the models the user's pools pay for when known.
 * `undefined` when nothing is left to tag.
 */
export function payableFreeModels(
	coreFreeIds: readonly string[] | undefined,
	freeCredit: FreeCredit | null
): ReadonlySet<string> | undefined {
	if (!(freeCredit && coreFreeIds?.length)) {
		return undefined;
	}
	const payable = freeCredit.payableModelIds;
	const ids = payable
		? coreFreeIds.filter((id) => payable.has(id.toLowerCase()))
		: coreFreeIds;
	return ids.length > 0 ? new Set(ids) : undefined;
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
