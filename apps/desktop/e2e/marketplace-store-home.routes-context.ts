// The request context the Store home route handlers share.

import type { Request, Route } from "@playwright/test";
import type {
	EngineFixtureDiagnostics,
	Fixture,
} from "./marketplace-store-home.fixture.ts";
import type { StoreProofJson } from "./marketplace-store-home-proof.contracts.ts";

export const NEXT_ROUTE = Symbol("next-route");

/** What one Store home route handler sees of the intercepted request. */
export interface StoreRouteContext {
	apiOrigin: string;
	body: StoreProofJson;
	diagnostic: EngineFixtureDiagnostics;
	fixture: Fixture;
	method: string;
	request: Request;
	route: Route;
	strictEngines: boolean;
	url: URL;
}
