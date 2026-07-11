/* @jsxImportSource @opentui/react */
// Recipes tab - parity with apps/cli's Recipes feature tab (main.rs
// refresh_feature_tab + feature_tab_action). Lists ghost recipes (name / id title,
// description-task subtitle, steps count badge) from /api/recipes. Enter replays the
// selected recipe (POST /api/recipes/:name/run {params:{}}). No secondary action.

import type { ApiTarget } from "@ryuhq/core-client/client";
import { runRecipe } from "@ryuhq/core-client/recipes";
import { featureListLoader, type ListRow } from "../core/featureList.ts";
import { ListTab } from "../ui/ListTab.tsx";
import type { TabProps } from "./types.ts";

const loadRecipes = featureListLoader({
	path: "/api/recipes",
	containerKeys: ["recipes", "data"],
	titleKeys: ["name", "id"],
	subtitleKeys: ["description", "task"],
	badgeKeys: ["steps"],
	idKeys: ["name", "id"],
});

const replayRecipe = async (
	row: ListRow,
	target: ApiTarget
): Promise<string> => {
	await runRecipe(target, row.id, {});
	return `replayed: ${row.id}`;
};

export function RecipesTab({ active }: TabProps) {
	return (
		<ListTab
			active={active}
			emptyLabel="No recipes"
			load={loadRecipes}
			onActivate={replayRecipe}
		/>
	);
}
