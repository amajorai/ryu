/* @jsxImportSource @opentui/react */
// Models tab - parity with apps/cli's Models feature tab (main.rs refresh_feature_tab
// + feature_tab_action/secondary). Lists the HF model catalog (name / id title,
// description-author-pipeline_tag subtitle, downloads-installs-likes badge). Enter
// installs the selected model (POST /api/models/catalog/install {id}); 'a' makes it
// the active served chat model (POST /api/models/active {id}).

import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { setActiveModel } from "@ryuhq/core-client/models";
import { featureListLoader, type ListRow } from "../core/featureList.ts";
import { ListTab } from "../ui/ListTab.tsx";
import type { TabProps } from "./types.ts";

const loadModels = featureListLoader({
	path: "/api/models/catalog?limit=30",
	containerKeys: ["data", "models", "items", "results"],
	titleKeys: ["name", "id", "model_id", "slug"],
	subtitleKeys: ["description", "author", "pipeline_tag"],
	badgeKeys: ["downloads", "installs", "likes"],
	idKeys: ["id", "model_id", "slug"],
});

const installModel = async (
	row: ListRow,
	target: ApiTarget
): Promise<string> => {
	await request(target, "/api/models/catalog/install", {
		method: "POST",
		body: { id: row.id },
	});
	return `install queued: ${row.id}`;
};

const activateModel = async (
	row: ListRow,
	target: ApiTarget
): Promise<string> => {
	await setActiveModel(target, row.id);
	return `active model: ${row.id}`;
};

export function ModelsTab({ active }: TabProps) {
	return (
		<ListTab
			active={active}
			emptyLabel="No models in the catalog"
			load={loadModels}
			onActivate={installModel}
			onSecondary={activateModel}
		/>
	);
}
