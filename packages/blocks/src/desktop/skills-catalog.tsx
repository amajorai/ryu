"use client";

// Presentational leaf components shared by the desktop Skills catalog. The live
// section (`apps/desktop/src/components/store/SkillsCatalogSection.tsx`) is a
// deeply hook-coupled master-detail surface (infinite scroll, @pierre/trees file
// browser, app Markdown) so its orchestration stays in the app; this block
// extracts the genuinely presentational pieces that BOTH the real section and the
// storyboard render — the skill master-list row and the install/active status
// affordance.

import {
	CheckmarkCircle02Icon,
	Download01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { StatusBadge } from "@ryu/ui/components/status-badge";
import { Switch } from "@ryu/ui/components/switch";

export interface SkillListRowData {
	/** Whether the installed skill is active (enabled). Only meaningful when
	 *  installed; null hides the active badge. */
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
				<span
					className="flex-1 truncate font-medium text-sm"
					title={skill.name}
				>
					{skill.name}
				</span>
				{skill.installed ? (
					skill.active === true ? (
						<StatusBadge kind="active" />
					) : skill.active === false ? (
						<Badge variant="outline">Added</Badge>
					) : (
						<HugeiconsIcon
							aria-label="Added"
							className="size-3.5 shrink-0 text-status-success"
							icon={CheckmarkCircle02Icon}
						/>
					)
				) : null}
			</div>
			<p
				className="truncate text-muted-foreground text-xs"
				title={skill.source}
			>
				{skill.source}
			</p>
			{skill.installsLabel ? (
				<div className="mt-1 flex items-center gap-1 text-muted-foreground text-xs">
					<HugeiconsIcon className="size-3" icon={Download01Icon} />
					{skill.installsLabel}
				</div>
			) : null}
		</button>
	);
}

/** The install / active-toggle affordance in the skill detail header. */
export function SkillInstallControl({
	installed,
	installing,
	active = false,
	onInstall,
	onToggleActive,
}: {
	installed: boolean;
	installing?: boolean;
	active?: boolean;
	onInstall?: () => void;
	onToggleActive?: (next: boolean) => void;
}) {
	if (!installed) {
		return (
			<Button loading={installing} onClick={onInstall} size="sm">
				{!installing && (
					<HugeiconsIcon className="size-4" icon={Download01Icon} />
				)}
				{installing ? "Adding…" : "Add skill"}
			</Button>
		);
	}
	return (
		<div className="flex shrink-0 items-center gap-3">
			<Badge variant="secondary">
				<HugeiconsIcon
					className="size-3.5 text-status-success"
					icon={CheckmarkCircle02Icon}
				/>
				Added
			</Badge>
			<label className="flex cursor-pointer items-center gap-2 text-muted-foreground text-xs">
				<Switch
					aria-label={active ? "Disable skill" : "Enable skill"}
					checked={active}
					onCheckedChange={(v) => onToggleActive?.(v)}
				/>
				{active ? "Enabled" : "Disabled"}
			</label>
		</div>
	);
}
