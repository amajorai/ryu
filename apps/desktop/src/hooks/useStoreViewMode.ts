import type { ViewMode } from "@ryu/blocks/desktop/view-toggle";
import { useTabViewMode } from "./useTabViewMode.ts";

// Persisted view preference for each Store section. The existing storage key is
// now a JSON map keyed by section, while readTabViewMode still accepts the old
// plain grid/list value as a migration fallback.

const KEY = "ryu:store-view-mode";
const VALID_MODES: readonly ViewMode[] = ["grid", "list", "showcase"];

export function useStoreViewMode(
	tabKey = "default",
	defaultMode: ViewMode = "grid"
): [ViewMode, (mode: ViewMode) => void] {
	return useTabViewMode({
		defaultMode,
		storageKey: KEY,
		tabKey,
		validModes: VALID_MODES,
	});
}
