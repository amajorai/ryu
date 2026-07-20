// Renders a tab's body by resolving its path through the contribution registry,
// replacing the hardcoded `TabContent` if-else in `Layout.tsx`. Behavior is
// identical: exact-path match first, then ordered pattern routes, else `null`
// (the old chain's `return null` fallthrough).
//
// PR-1 wiring: `Layout.tsx`'s `TabContent` becomes a one-line delegation to this
// component (after importing `@/src/contributions/builtins.ts` once so the
// built-ins are seeded). See the integration snippet in
// `docs/desktop-extension-host-spec.md`.

import type { Tab } from "@/src/contexts/TabsContext.tsx";
import {
	contributionRegistry,
	type RouteTab,
} from "@/src/contributions/registry.ts";

export function RouteOutlet({
	tab,
	onClose,
}: {
	tab: Tab;
	onClose: () => void;
}) {
	const render = contributionRegistry.resolve(tab.path);
	if (!render) {
		// Mirrors the old chain's `return null` for an unknown path.
		return null;
	}
	// `Tab` is structurally a superset of `RouteTab`; the render-fns only read the
	// `RouteTab` subset (path + the initial* params a pattern/exact route needs).
	return <>{render(tab as RouteTab, { onClose })}</>;
}
