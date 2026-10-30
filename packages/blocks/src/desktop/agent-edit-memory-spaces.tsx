"use client";

import { Badge } from "@ryu/ui/components/badge";
import { Checkbox } from "@ryu/ui/components/checkbox";
import { Label } from "@ryu/ui/components/label";
import { Separator } from "@ryu/ui/components/separator";
import { Switch } from "@ryu/ui/components/switch";
import type { SpaceRow } from "./agent-edit-form-types.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./settings-items.tsx";

// ── Memory / Spaces slot (live) ────────────────────────────────────────────────

/** The five memory scope levels an agent may recall from. Leaving all personal
 * levels unchecked means "all personal levels" — the back-compat default Core
 * applies for agents configured before this slot existed. Organization memory
 * stays explicit because it is shared with every member of the organization. */
const MEMORY_READ_LEVELS: { hint: string; label: string; value: string }[] = [
	{
		value: "agent",
		label: "Agent",
		hint: "Memories scoped to this agent.",
	},
	{
		value: "user",
		label: "User",
		hint: "Personal memories for the signed-in user.",
	},
	{
		value: "node",
		label: "Node",
		hint: "Memories shared across this device / node.",
	},
	{
		value: "project",
		label: "Project",
		hint: "Memories scoped to the active project.",
	},
	{
		value: "org",
		label: "Organization",
		hint: "Memories shared across this organization.",
	},
];

export interface MemorySpacesCardProps {
	disabled?: boolean;
	memoryReadLevels: Set<string>;
	memorySpaceIds: Set<string>;
	memoryWriteEnabled: boolean;
	onMemoryWriteEnabledChange?: (v: boolean) => void;
	onToggleMemoryReadLevel?: (level: string) => void;
	onToggleMemorySpace?: (id: string) => void;
	/** Show the per-scope recall checkboxes. The simple editor hides them and
	 *  keeps Core's default (all personal levels). */
	showReadLevels?: boolean;
	spaces: SpaceRow[];
}

/** Live Memory / Spaces slot: pick readable Spaces, recallable memory levels,
 * and whether the agent may record new memories. Replaces the old "coming soon"
 * SlotCard. */
export function MemorySpacesCard({
	spaces,
	memorySpaceIds,
	onToggleMemorySpace,
	memoryReadLevels,
	onToggleMemoryReadLevel,
	memoryWriteEnabled,
	onMemoryWriteEnabledChange,
	disabled = false,
	showReadLevels = true,
}: MemorySpacesCardProps) {
	return (
		<SettingsSection
			caption={
				showReadLevels
					? "Give this agent long-term memory. Choose which Spaces it may read for retrieval, which memory levels it may recall, and whether it may record new memories."
					: "Choose which Spaces this agent may read, and whether it may remember new things."
			}
			headerAction={
				memorySpaceIds.size > 0 ? (
					<Badge variant="secondary">{memorySpaceIds.size}</Badge>
				) : undefined
			}
			title="Memory & Spaces"
		>
			<SettingsCard className="flex flex-col gap-4">
				<div className="flex flex-col gap-2">
					<span className="font-medium text-sm">Readable Spaces</span>
					<p className="text-muted-foreground text-xs">
						Vector Spaces this agent may inject into chat for retrieval. Leave
						all unchecked to inject none.
					</p>
					{spaces.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							No Spaces yet. Create one on the Spaces page to grant access.
						</p>
					) : (
						<div className="flex flex-col gap-2">
							{spaces.map((space) => {
								const checkId = `memory-space-${space.id}`;
								return (
									<div className="flex items-center gap-3" key={space.id}>
										<Checkbox
											checked={memorySpaceIds.has(space.id)}
											disabled={disabled}
											id={checkId}
											onCheckedChange={() => onToggleMemorySpace?.(space.id)}
										/>
										<Label htmlFor={checkId} variant="agent-choice">
											{space.name}
										</Label>
									</div>
								);
							})}
						</div>
					)}
				</div>

				{showReadLevels ? <Separator /> : null}

				{showReadLevels ? (
					<div className="flex flex-col gap-2">
						<span className="font-medium text-sm">Memory levels</span>
						<p className="text-muted-foreground text-xs">
							Which memory scopes this agent may recall from. Leave all
							unchecked to allow all personal levels (agent, user, node, and
							project).
						</p>
						<div className="flex flex-col gap-2">
							{MEMORY_READ_LEVELS.map((level) => {
								const checkId = `memory-level-${level.value}`;
								return (
									<div className="flex items-start gap-3" key={level.value}>
										<Checkbox
											checked={memoryReadLevels.has(level.value)}
											disabled={disabled}
											id={checkId}
											onCheckedChange={() =>
												onToggleMemoryReadLevel?.(level.value)
											}
										/>
										<Label htmlFor={checkId} variant="agent-choice">
											<span className="font-medium">{level.label}</span>
											<span className="block text-muted-foreground text-xs">
												{level.hint}
											</span>
										</Label>
									</div>
								);
							})}
						</div>
					</div>
				) : null}
			</SettingsCard>

			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={memoryWriteEnabled}
							disabled={disabled}
							id="memory-write-enabled"
							onCheckedChange={onMemoryWriteEnabledChange}
						/>
					}
					description="When on, the agent may record new memories during a session. When off, it can only recall existing ones."
					title="Allow writing memories"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
