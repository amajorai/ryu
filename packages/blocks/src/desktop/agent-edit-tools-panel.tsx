"use client";

import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@ryu/ui/components/input-group";
import { Label } from "@ryu/ui/components/label";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import type { AgentSettingsFormProps } from "./agent-edit-form-types.ts";
import { MemorySpacesCard } from "./agent-edit-memory-spaces.tsx";
import { formatToolDisplayName } from "./agent-elements/tools/tool-registry.ts";
import { SettingsCard, SettingsSection } from "./settings-items.tsx";

/** Tools & knowledge tab: identity, execution policy, tools + skills, and
 *  memory. The capability search query stays with the form so it survives a
 *  tab switch. */
export function AgentToolsPanel({
	capabilityQuery,
	props,
	setCapabilityQuery,
	simpleAccountAccess,
}: {
	capabilityQuery: string;
	props: AgentSettingsFormProps;
	setCapabilityQuery: (query: string) => void;
	simpleAccountAccess: boolean;
}) {
	const {
		isLocked,
		toolsLoading,
		tools,
		selectedTools,
		onToggleTool,
		skillsLoading,
		skills,
		selectedSkills,
		onToggleSkill,
		spaces,
		memorySpaceIds,
		onToggleMemorySpace,
		memoryReadLevels,
		onToggleMemoryReadLevel,
		memoryWriteEnabled,
		onMemoryWriteEnabledChange,
		executionPolicyPanel,
		identityModePanel,
		accountAccessPanel,
		simple = false,
	} = props;
	const tl = useLiteralMessages();
	const normalizedCapabilityQuery = capabilityQuery.trim().toLowerCase();
	const filteredTools = tools.filter((toolName) =>
		formatToolDisplayName(toolName)
			.toLowerCase()
			.includes(normalizedCapabilityQuery)
	);
	const filteredSkills = skills.filter((skill) =>
		[skill.name, skill.description, skill.id]
			.filter(Boolean)
			.some((value) => value?.toLowerCase().includes(normalizedCapabilityQuery))
	);
	const enableAllCapabilities = () => {
		for (const tool of tools) {
			if (!selectedTools.has(tool)) {
				onToggleTool?.(tool);
			}
		}
		for (const skill of skills) {
			if (skill.enabled && !selectedSkills.has(skill.id)) {
				onToggleSkill?.(skill.id);
			}
		}
	};
	const disableAllCapabilities = () => {
		for (const tool of tools) {
			if (selectedTools.has(tool)) {
				onToggleTool?.(tool);
			}
		}
		for (const skill of skills) {
			if (selectedSkills.has(skill.id)) {
				onToggleSkill?.(skill.id);
			}
		}
	};
	return (
		<>
			{/* Identity: whose accounts the agent works with. Essential tab, so the
			    simple editor (Ryu Bot) keeps it too. The simple editor has no
			    Connections tab, so Account access renders here instead. */}
			{identityModePanel ? (
				<div data-setting-id="agent.identity-mode">
					<SettingsSection
						caption={
							simpleAccountAccess
								? "Whose accounts this agent works with, and which accounts exactly."
								: "Whose accounts this agent works with. Choose which accounts exactly under Connections → Account access."
						}
						title="Identity"
					>
						{simpleAccountAccess ? (
							<div className="flex flex-col gap-5">
								{identityModePanel}
								<div data-setting-id="agent.account-access">
									{accountAccessPanel}
								</div>
							</div>
						) : (
							identityModePanel
						)}
					</SettingsSection>
				</div>
			) : null}
			{/* Lifecycle + safety: what an available agent may do. */}
			{executionPolicyPanel}
			{/* 4. Tools + skills — one readable settings surface. */}
			<SettingsSection
				caption="New agents start with every available tool and enabled skill. Turn off anything this agent should not use."
				headerAction={
					<div className="flex items-center gap-2">
						<Button
							disabled={isLocked || toolsLoading || skillsLoading}
							onClick={enableAllCapabilities}
							size="sm"
							variant="ghost"
						>
							Enable all
						</Button>
						<Button
							disabled={isLocked || toolsLoading || skillsLoading}
							onClick={disableAllCapabilities}
							size="sm"
							variant="ghost"
						>
							Disable all
						</Button>
						<InputGroup className="w-64">
							<InputGroupAddon>
								<HugeiconsIcon className="size-4" icon={Search01Icon} />
							</InputGroupAddon>
							<InputGroupInput
								aria-label="Search tools and skills"
								onChange={(event) => setCapabilityQuery(event.target.value)}
								placeholder="Search tools and skills…"
								value={capabilityQuery}
							/>
						</InputGroup>
					</div>
				}
				title="Tools & skills"
			>
				<SettingsCard className="flex flex-col gap-4">
					{toolsLoading ? (
						<div className="flex items-center gap-2 text-muted-foreground text-xs">
							<Spinner className="size-3" />
							Loading tools…
						</div>
					) : null}
					{!toolsLoading && tools.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							No tools available. Install MCP servers to add tools.
						</p>
					) : null}
					{!toolsLoading && tools.length > 0 ? (
						<div className="grid gap-2 md:grid-cols-2">
							{filteredTools.map((toolName) => {
								const checkId = `tool-${toolName}`;
								return (
									<div
										className="flex items-center justify-between gap-3 rounded-xl border bg-muted/20 px-3 py-2.5"
										key={toolName}
									>
										<Label
											className="min-w-0"
											htmlFor={checkId}
											variant="agent-choice"
										>
											<span className="block truncate">
												{formatToolDisplayName(toolName)}
											</span>
											<span
												className="block truncate text-muted-foreground text-xs"
												title={toolName}
											>
												{toolName}
											</span>
										</Label>
										<Switch
											checked={selectedTools.has(toolName)}
											disabled={isLocked}
											id={checkId}
											onCheckedChange={() => onToggleTool?.(toolName)}
										/>
									</div>
								);
							})}
						</div>
					) : null}
					<div className="border-t pt-4">
						<div className="mb-2 flex items-center justify-between">
							<div>
								<h3 className="font-medium text-sm">Skills</h3>
								<p className="text-muted-foreground text-xs">
									New agents start with every globally enabled skill. Turn off
									individual skills to narrow this agent.
								</p>
							</div>
							<Badge variant="secondary">
								{tl("{size} enabled", { size: String(selectedSkills.size) })}
							</Badge>
						</div>
						{skillsLoading ? (
							<div className="flex items-center gap-2 text-muted-foreground text-xs">
								<Spinner className="size-3" />
								Loading skills…
							</div>
						) : null}
						{!skillsLoading && skills.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								No Skills installed. Browse and install from the Skills page.
							</p>
						) : null}
						{!skillsLoading && skills.length > 0 ? (
							<div className="grid gap-2 md:grid-cols-2">
								{filteredSkills.map((skill) => {
									const checkId = `skill-${skill.id}`;
									return (
										<div
											className="flex items-start justify-between gap-3 rounded-xl border bg-muted/20 px-3 py-2.5"
											key={skill.id}
										>
											<Label
												className="min-w-0"
												htmlFor={checkId}
												variant="agent-choice"
											>
												<span
													className="block truncate font-medium"
													title={skill.name}
												>
													{skill.name}
												</span>
												{skill.description ? (
													<span
														className="block truncate text-muted-foreground text-xs"
														title={skill.description}
													>
														{skill.description}
													</span>
												) : null}
												{skill.enabled ? null : (
													<span className="text-muted-foreground text-xs">
														Disabled globally
													</span>
												)}
											</Label>
											<Switch
												checked={selectedSkills.has(skill.id)}
												disabled={isLocked}
												id={checkId}
												onCheckedChange={() => onToggleSkill?.(skill.id)}
											/>
										</div>
									);
								})}
							</div>
						) : null}
					</div>
				</SettingsCard>
			</SettingsSection>

			{/* What the agent may read and remember. Grouped with tools and skills
			    because "what it can do" and "what it knows" are one question to a
			    user — it used to be buried under Advanced. */}
			<MemorySpacesCard
				disabled={isLocked}
				memoryReadLevels={memoryReadLevels}
				memorySpaceIds={memorySpaceIds}
				memoryWriteEnabled={memoryWriteEnabled}
				onMemoryWriteEnabledChange={onMemoryWriteEnabledChange}
				onToggleMemoryReadLevel={onToggleMemoryReadLevel}
				onToggleMemorySpace={onToggleMemorySpace}
				showReadLevels={!simple}
				spaces={spaces}
			/>
		</>
	);
}
