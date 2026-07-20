// packages/marketplace/src/catalog/chrome/skill-list-row.tsx
//
// A skill master-list row: name, install state, source, optional installs. This is
// the presentational leaf the shared Skills catalog section renders for every row.
// It mirrors the storyboard-shared `@ryu/blocks/desktop/skills-catalog` SkillListRow
// but is inlined here so the package stays self-contained (importing the blocks
// source, which only ever gets bundled, drags un-typecheckable extensionless
// imports into this package's strict `tsc`). Keep the two in visual sync.

import {
	CheckmarkCircle02Icon,
	Download01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";

export interface SkillListRowData {
	/** Whether the installed skill is active (enabled). Only meaningful when
	 *  installed; `null` hides the active badge. */
	active?: boolean | null;
	id: string;
	installed: boolean;
	/** Optional install/download count line. */
	installsLabel?: string | null;
	name: string;
	/** Source/owner line, e.g. "skills.sh" or "amajorai". */
	source: string;
}

/** A skill master-list row: name, install state, source, optional installs. */
export function SkillListRow({
	skill,
	selected,
	onSelect,
}: {
	skill: SkillListRowData;
	selected?: boolean;
	onSelect?: () => void;
}) {
	return (
		<button
			className={`w-full rounded-md px-3 py-2 text-left transition-colors ${
				selected ? "bg-accent" : "hover:bg-accent/50"
			}`}
			onClick={onSelect}
			type="button"
		>
			<div className="flex items-center gap-1.5">
				<span className="flex-1 truncate font-medium text-sm">
					{skill.name}
				</span>
				{renderInstalledMark(skill)}
			</div>
			<p className="truncate text-muted-foreground text-xs">{skill.source}</p>
			{skill.installsLabel ? (
				<div className="mt-1 flex items-center gap-1 text-muted-foreground text-xs">
					<HugeiconsIcon className="size-3" icon={Download01Icon} />
					{skill.installsLabel}
				</div>
			) : null}
		</button>
	);
}

function renderInstalledMark(skill: SkillListRowData) {
	if (!skill.installed) {
		return null;
	}
	if (skill.active === true) {
		return <Badge variant="secondary">Active</Badge>;
	}
	if (skill.active === false) {
		return <Badge variant="outline">Installed</Badge>;
	}
	return (
		<HugeiconsIcon
			aria-label="Installed"
			className="size-3.5 shrink-0 text-success"
			icon={CheckmarkCircle02Icon}
		/>
	);
}
