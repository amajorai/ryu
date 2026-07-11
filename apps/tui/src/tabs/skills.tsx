/* @jsxImportSource @opentui/react */
// Skills tab - parity with apps/cli's Skills feature tab (main.rs refresh_feature_tab
// + feature_tab_action/secondary). Lists the skills catalog (name / slug / id title,
// description-summary subtitle, installed badge). Enter installs the selected skill
// (POST /api/skills/catalog/install {id}); 'a' activates it (POST /api/skills/activate
// {id, active:true}).

import type { ApiTarget } from "@ryuhq/core-client/client";
import { installSkill, setSkillActive } from "@ryuhq/core-client/skills";
import { featureListLoader, type ListRow } from "../core/featureList.ts";
import { ListTab } from "../ui/ListTab.tsx";
import type { TabProps } from "./types.ts";

const loadSkills = featureListLoader({
	path: "/api/skills/catalog?limit=30",
	containerKeys: ["skills", "data", "results"],
	titleKeys: ["name", "slug", "id"],
	subtitleKeys: ["description", "summary"],
	badgeKeys: ["installed"],
	idKeys: ["id", "slug"],
});

const installSkillRow = async (
	row: ListRow,
	target: ApiTarget
): Promise<string> => {
	await installSkill(target, row.id);
	return `install queued: ${row.id}`;
};

const activateSkill = async (
	row: ListRow,
	target: ApiTarget
): Promise<string> => {
	await setSkillActive(target, row.id, true);
	return `activated: ${row.id}`;
};

export function SkillsTab({ active }: TabProps) {
	return (
		<ListTab
			active={active}
			emptyLabel="No skills in the catalog"
			load={loadSkills}
			onActivate={installSkillRow}
			onSecondary={activateSkill}
		/>
	);
}
