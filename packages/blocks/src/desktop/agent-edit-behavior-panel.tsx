"use client";

import { Add01Icon, Delete01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Textarea } from "@ryu/ui/components/textarea";
import type { ReactNode } from "react";
import type { AgentSettingsFormProps } from "./agent-edit-form-types.ts";
import type { AgentSettingsTab } from "./agent-settings-search.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./settings-items.tsx";

/** Behavior tab: instructions, goal, personality, and rules. */
export function AgentBehaviorPanel({
	modelPanel,
	props,
	setActiveTab,
	showInlineModel,
}: {
	modelPanel: ReactNode;
	props: AgentSettingsFormProps;
	setActiveTab: (tab: AgentSettingsTab) => void;
	showInlineModel: boolean;
}) {
	const {
		isNew,
		isLocked,
		instructionsEditor,
		agentSetupComposer,
		goalPanel,
		promptStudioPanel,
		rulesPanel,
		systemPrompt,
		onOpenPromptStudio,
		personalityProfile = "",
		personalityProfiles = [],
		onPersonalityProfileChange,
		tone,
		toneOptions,
		onToneChange,
		customTone,
		onCustomToneChange,
	} = props;
	const rulesSection = <AgentRulesSection props={props} />;

	return (
		<>
			{/* 7. Instructions — the output: prompt + personality */}
			<SettingsSection
				caption={
					agentSetupComposer
						? "Write its instructions and choose its agent and model from one simple composer."
						: "Describe how this agent should behave, what it should avoid, and how it should respond."
				}
				headerAction={
					isNew ? undefined : (
						<button
							className="cursor-pointer font-medium text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
							onClick={() =>
								promptStudioPanel
									? setActiveTab("prompt-studio")
									: onOpenPromptStudio?.()
							}
							type="button"
						>
							Open Prompt Studio
						</button>
					)
				}
				title={agentSetupComposer ? "Instructions & model" : "Instructions"}
			>
				{/* `bare`: the editor (injected PlateJS, or the fallback textarea) is a
				    tall bordered box that fills the card edge to edge, so the card
				    surface only draws a second edge a few pixels outside the first. */}
				<SettingsCard bare>
					{agentSetupComposer ?? instructionsEditor ?? (
						<Textarea
							className="min-h-32"
							disabled={isLocked}
							id="agent-prompt"
							readOnly
							value={systemPrompt}
						/>
					)}
				</SettingsCard>
			</SettingsSection>

			{goalPanel}

			{showInlineModel ? modelPanel : null}

			<SettingsSection title="Personality & tone">
				<SettingsGroup>
					{personalityProfiles.length > 1 ? (
						<SettingsItem
							actions={
								<Select
									disabled={isLocked}
									items={personalityProfiles.map((profile) => ({
										label: profile.label,
										value: profile.id,
									}))}
									onValueChange={(v) => onPersonalityProfileChange?.(v ?? "")}
									value={personalityProfile}
								>
									<SelectTrigger
										appearance="editor-row"
										className="w-56 shrink-0"
										id="agent-personality-profile"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{personalityProfiles.map((profile) => (
											<SelectItem key={profile.id} value={profile.id}>
												{profile.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							}
							title="Personality profile"
						/>
					) : null}
					<SettingsItem
						actions={
							<Select
								disabled={isLocked}
								items={toneOptions}
								onValueChange={(v) => onToneChange?.(v ?? "")}
								value={tone}
							>
								<SelectTrigger
									appearance="editor-row"
									className="w-56 shrink-0"
									id="persona-tone"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{toneOptions.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						title="Tone"
					/>
					{tone === "custom" ? (
						<SettingsItem
							actions={
								<Input
									className="h-8 w-64"
									disabled={isLocked}
									id="persona-custom-tone"
									onChange={(e) => onCustomToneChange?.(e.target.value)}
									placeholder="e.g. Concise and technical, with a dry wit"
									value={customTone}
								/>
							}
							title="Custom tone"
						/>
					) : null}
				</SettingsGroup>
			</SettingsSection>

			{/* Always-on directives read as part of "how it behaves", so they sit
			    with the instructions instead of owning a tab of their own. */}
			{rulesPanel ?? rulesSection}
		</>
	);
}

/** The built-in Rules editor, used unless a plugin injects `rulesPanel`. */
export function AgentRulesSection({
	props,
}: {
	props: AgentSettingsFormProps;
}) {
	const { isLocked, rules, onRuleChange, onRemoveRule, onAddRule } = props;
	const tl = useLiteralMessages();

	return (
		<>
			{/* 6. Rules */}
			<SettingsSection
				caption="Short, always-on directives folded into this agent's instructions."
				title="Rules"
			>
				<SettingsCard className="flex flex-col gap-2">
					{rules.map((rule, index) => (
						<div className="flex items-center gap-2" key={`rule-${index}`}>
							<Input
								aria-label={tl("Rule {number}", { number: String(index + 1) })}
								disabled={isLocked}
								onChange={(e) => onRuleChange?.(index, e.target.value)}
								placeholder="e.g. Always cite your sources"
								value={rule}
							/>
							<Button
								aria-label="Remove rule"
								disabled={isLocked}
								onClick={() => onRemoveRule?.(index)}
								size="icon-sm"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={Delete01Icon} />
							</Button>
						</div>
					))}
					<Button
						className="self-start"
						disabled={isLocked}
						onClick={onAddRule}
						size="sm"
						variant="outline"
					>
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						Add rule
					</Button>
				</SettingsCard>
			</SettingsSection>
		</>
	);
}
