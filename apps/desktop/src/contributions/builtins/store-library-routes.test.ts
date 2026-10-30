// Every Store, Library and Memory route must build an element without rendering
// it: the handlers wrap a lazy page in a Suspense boundary, and a handler that
// calls itself instead of creating the page element overflows the stack the
// moment the route opens.

import { describe, expect, it } from "bun:test";
import { isValidElement, type ReactElement, Suspense } from "react";
import type { RouteContext, RouteRender, RouteTab } from "../registry.ts";
import {
	registerLibraryPatternRoutes,
	registerStoreLibraryExactRoutes,
	registerStorePatternRoutes,
} from "./store-library-routes.ts";

const ctx: RouteContext = { onClose: () => undefined } as RouteContext;

function tabFor(path: string): RouteTab {
	// SAFETY: the handlers under test read only `path` and the optional store
	// hand-off fields, so a path-only tab is a complete input for them.
	return { path } as RouteTab;
}

function collect(): { path: string; render: RouteRender }[] {
	const routes: { path: string; render: RouteRender }[] = [];
	registerStoreLibraryExactRoutes((path, render) => {
		routes.push({ path, render });
	});
	const samples: Record<string, string> = {
		library: "/library/agent",
		memory: "/library/memory/reflect",
		store: "/store/skills",
	};
	registerStorePatternRoutes((_test, render) => {
		routes.push({ path: samples.store, render });
	});
	registerLibraryPatternRoutes((test, render) => {
		const path =
			test instanceof RegExp && test.test(samples.memory)
				? samples.memory
				: samples.library;
		routes.push({ path, render });
	});
	return routes;
}

describe("Store, Library and Memory routes", () => {
	it("wrap each lazy page in a Suspense boundary without recursing", () => {
		const routes = collect();
		expect(routes.length).toBeGreaterThan(10);
		for (const { path, render } of routes) {
			const node = render(tabFor(path), ctx);
			expect(isValidElement(node)).toBe(true);
			const element = node as ReactElement<{ children: ReactElement }>;
			expect(element.type).toBe(Suspense);
			expect(isValidElement(element.props.children)).toBe(true);
		}
	});
});
