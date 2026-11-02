// installLocalFixture: routes the Store home story's Core API calls to the
// in-memory fixture through the ordered route handlers.

import type { Page } from "@playwright/test";
import {
	API_ORIGIN,
	createFixture,
	type EngineFixtureDiagnostics,
	engineDiagnostics,
	type Fixture,
	requestBody,
} from "./marketplace-store-home.fixture.ts";
import { routeStoreHome1 } from "./marketplace-store-home.routes-1.ts";
import { routeStoreHome2 } from "./marketplace-store-home.routes-2.ts";
import { routeStoreHome3 } from "./marketplace-store-home.routes-3.ts";
import {
	NEXT_ROUTE,
	type StoreRouteContext,
} from "./marketplace-store-home.routes-context.ts";

export async function installLocalFixture(
	page: Page,
	apiOrigin = API_ORIGIN,
	strictEngines = false
): Promise<Fixture> {
	const fixture = createFixture();
	const diagnostic: EngineFixtureDiagnostics = {
		pageErrors: [],
		unknown: [],
		fixture,
	};
	if (strictEngines) {
		engineDiagnostics.set(page, diagnostic);
		page.on("pageerror", (error) => diagnostic.pageErrors.push(error.message));
	}
	await page.route(
		strictEngines
			? (url) => url.pathname.startsWith("/api/")
			: `${apiOrigin}/api/**`,
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const method = request.method();
			const body = await requestBody(route);
			fixture.calls.push({
				body,
				method,
				path: url.pathname,
				search: url.search,
			});
			const ctx: StoreRouteContext = {
				apiOrigin,
				body,
				diagnostic,
				fixture,
				method,
				request,
				route,
				strictEngines,
				url,
			};
			for (const handle of [
				routeStoreHome1,
				routeStoreHome2,
				routeStoreHome3,
			]) {
				const handled = await handle(ctx);
				if (handled !== NEXT_ROUTE) {
					return handled;
				}
			}
			return undefined;
		}
	);
	return fixture;
}
