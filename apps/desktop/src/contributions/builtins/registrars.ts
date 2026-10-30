// The registrar shapes `seedBuiltinRoutes` hands to each area of the built-in route
// table, so every area registers into the same registry in the same order.

import type { RoutePreload, RouteRender } from "../registry.ts";

/** Registers an exact path (matched first, via the O(1) map). */
export type ExactRouteRegistrar = (
	path: string,
	render: RouteRender,
	preload?: RoutePreload
) => void;

/** Registers an ordered, `$`-anchored pattern route. */
export type PatternRouteRegistrar = (
	test: RegExp | { startsWith: string },
	render: RouteRender,
	preload?: RoutePreload
) => void;
