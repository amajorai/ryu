// A `React.lazy` page whose chunk can be fetched before it renders.
//
// Hovering or focusing a link calls `preload()` so the import is usually settled
// by the click. The factory promise is memoised and shared with `lazy`, so the
// hover and the real render never download the chunk twice. A failed import is
// forgotten so the next attempt (or the real navigation) retries it.

import { type ComponentType, type LazyExoticComponent, lazy } from "react";

// `any` mirrors `React.lazy`'s own constraint; any page's props must fit.
// matches React.lazy's signature.
type AnyComponent = ComponentType<any>;

export type PreloadableLazy<T extends AnyComponent> = LazyExoticComponent<T> & {
	preload: () => Promise<{ default: T }>;
};

export function lazyRoute<T extends AnyComponent>(
	factory: () => Promise<{ default: T }>
): PreloadableLazy<T> {
	let pending: Promise<{ default: T }> | null = null;
	const load = () => {
		pending ??= factory().catch((error) => {
			pending = null;
			throw error;
		});
		return pending;
	};
	return Object.assign(lazy<T>(load), { preload: load });
}
