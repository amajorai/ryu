// Renders a tab's body by resolving its path through the contribution registry,
// replacing the hardcoded `TabContent` if-else in `Layout.tsx`. Behavior is
// identical: exact-path match first, then ordered pattern routes, else `null`
// (the old chain's `return null` fallthrough).
//
// PR-1 wiring: `Layout.tsx`'s `TabContent` becomes a one-line delegation to this
// component (after importing `@/src/contributions/builtins.ts` once so the
// built-ins are seeded). See the integration snippet in
// `docs/desktop-extension-host-spec.md`.

import { Button } from "@ryu/ui/components/button.tsx";
import { Suspense, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { Tab } from "@/src/contexts/TabsContext.tsx";
import { contributionRegistry } from "@/src/contributions/registry.ts";
import { isBotRoutePath } from "@/src/lib/product.ts";
import { useProductMode } from "@/src/lib/product-mode.ts";

export function RouteOutlet({
	tab,
	onClose,
}: {
	tab: Tab;
	onClose: () => void;
}) {
	const closeRef = useRef(onClose);
	useLayoutEffect(() => {
		closeRef.current = onClose;
	}, [onClose]);
	const close = useCallback(() => closeRef.current(), []);
	const botProduct = useProductMode() === "bot";
	const render =
		botProduct && !isBotRoutePath(tab.path)
			? undefined
			: contributionRegistry.resolve(tab.path);
	const content = useMemo(
		() => render?.(tab, { onClose: close }) ?? null,
		[render, tab, close]
	);
	if (botProduct && !isBotRoutePath(tab.path)) {
		return (
			<div className="flex size-full items-center justify-center p-6">
				<div className="flex max-w-sm flex-col items-center gap-3 text-center">
					<p className="font-medium text-lg">
						That surface belongs in Ryu Build.
					</p>
					<p className="text-muted-foreground text-sm">
						Bot keeps the managed chat experience focused. Close this tab to
						return to your conversations.
					</p>
					<Button onClick={onClose} variant="outline">
						Back to chat
					</Button>
				</div>
			</div>
		);
	}
	if (!render) {
		// Mirrors the old chain's `return null` for an unknown path.
		return null;
	}
	// `Tab` is structurally a superset of `RouteTab`; the render-fns only read the
	// `RouteTab` subset (path + the initial* params a pattern/exact route needs).
	// The fallback is deliberately empty. Lazy page chunks are warmed on link
	// hover/focus (see `lib/route-prefetch.ts`), so a suspend usually lasts a
	// single frame; a "Loading…" label there only ever read as a flash.
	return (
		<Suspense fallback={<div className="size-full" />}>{content}</Suspense>
	);
}
