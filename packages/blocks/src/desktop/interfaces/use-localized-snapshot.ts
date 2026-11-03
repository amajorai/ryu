import { useOptionalI18n } from "@ryu/i18n/react";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";

/**
 * Changes whenever the UI language or its literal catalog changes. The
 * catalog loads after the first render, and a language switch keeps every
 * prop the same, so a cache of `translate()` output needs this as a key.
 */
export function useI18nRevision(): string {
	const i18n = useOptionalI18n();
	return `${i18n?.locale ?? "en"}:${i18n?.version ?? 0}`;
}

/**
 * The same snapshot under a new identity per i18n revision. A renderer that
 * caches translated copy with `useMemo(…, [snapshot])` then rebuilds it after
 * the catalog arrives or the language changes, without a remount. The thread
 * list keeps its identity, so effects keyed on the threads do not re-run.
 */
export function useLocalizedSnapshot(
	snapshot: InterfaceSnapshot
): InterfaceSnapshot {
	const revision = useI18nRevision();
	// biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the key: a new identity per language or catalog change.
	return useMemo(() => ({ ...snapshot }), [snapshot, revision]);
}
