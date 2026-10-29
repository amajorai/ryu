import type { RecipeSummary } from "@ryuhq/core-client/recipes";
import { z } from "zod";
import type { AppMountForwarder } from "./app-request-target.ts";
import { ghostRecipeSummariesSchema } from "./ghost-recording.ts";
import type { HostServices } from "./rpc.ts";

// The legacy `ghost.recipes` host-API verb (grant `ghost:record`). Host API 1.x is
// additive-only, so older Workflows Companion bundles that still call it keep
// working. Current bundles call `app.request({ app: "@ryu/recipes", ... })` under
// the reviewed `app:http:@ryu/recipes` grant instead. The legacy verb keeps its
// original gate (`ghost:record`) and its original reach (the Recipes list route,
// GET `/` on the Recipes mount), now through the host's generic ext-proxy forwarder
// rather than a per-app desktop API module.

/** The Recipes app, whose sidecar serves the recipe list. */
export const RECIPES_APP_ID = "@ryu/recipes";

/** The Recipes list route's reply: `{ recipes }`, absent meaning none. */
export const recipesListReplySchema = z.object({
	recipes: ghostRecipeSummariesSchema.optional(),
});

/** Serve `ghost.recipes` from the Recipes app's list route. */
export function ghostRecipesViaAppMount(
	forward: AppMountForwarder
): Pick<HostServices, "ghostRecipes"> {
	return {
		ghostRecipes: async (): Promise<RecipeSummary[]> => {
			const reply = await forward(RECIPES_APP_ID, { method: "GET", path: "/" });
			return recipesListReplySchema.parse(reply).recipes ?? [];
		},
	};
}
