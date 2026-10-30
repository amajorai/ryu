import { Rocket01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AgentSettingsForm,
	type SlotOption,
} from "@ryu/blocks/desktop/agent-edit.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { modeHasOwnAccounts } from "@/src/components/agents/AgentIdentityModePicker.tsx";
import { PromptCacheConfirmDialog } from "@/src/components/chat/PromptCacheConfirmDialog.tsx";
import { PublishDialog } from "@/src/components/marketplace/PublishDialog.tsx";
import type { SchedulePhrase } from "@/src/lib/automations.ts";
import { setProductMode } from "@/src/lib/product-mode.ts";
import { installWallpaper } from "@/src/lib/wallpaper-library.ts";
import { useAgentEditBase } from "./AgentEditPage-base.ts";
import { useAgentEditComposio } from "./AgentEditPage-composio.ts";
import type { AgentEditContext } from "./AgentEditPage-context.ts";
import { useAgentEditFormState } from "./AgentEditPage-form-state.ts";
import { useAgentEditHealth } from "./AgentEditPage-health.ts";
import { useAgentEditHydrate } from "./AgentEditPage-hydrate.ts";
import { useAgentEditLoaders } from "./AgentEditPage-loaders.ts";
import {
	ACP_CUSTOM_ENGINE,
	saveBlockedMessage,
	TONE_OPTIONS,
} from "./AgentEditPage-options.ts";
import { buildAgentEditPanels } from "./AgentEditPage-panels.tsx";
import { buildAgentEditMorePanels } from "./AgentEditPage-panels-more.tsx";
import { useAgentEditPostureActions } from "./AgentEditPage-posture-actions.ts";
import { agentPostureResources } from "./AgentEditPage-posture-resource.ts";
import { createAgentEditSave } from "./AgentEditPage-save.ts";
import { useAgentEditVersions } from "./AgentEditPage-versions.tsx";

export { IntegrationsPanel } from "./AgentEditPage-integrations-panel.tsx";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
export default function AgentEditPage({
	agentIdProp,
	initialSettingId,
	onClose,
}: {
	agentIdProp?: string;
	/** Open on this setting (an agent-settings index id, such as Account access
	 *  after adding a Store Agent Template). */
	initialSettingId?: string;
	onClose?: () => void;
}) {
	const base = useAgentEditBase({ agentIdProp, onClose });
	const formState = useAgentEditFormState({ ...base });
	const composio = useAgentEditComposio({ ...base, ...formState });
	const loaders = useAgentEditLoaders({ ...base, ...formState, ...composio });
	const hydrate = useAgentEditHydrate({
		...base,
		...formState,
		...composio,
		...loaders,
	});
	const save = createAgentEditSave({
		...base,
		...formState,
		...composio,
		...loaders,
		...hydrate,
	});
	const postureActions = useAgentEditPostureActions({
		...base,
		...formState,
		...composio,
		...loaders,
		...hydrate,
		...save,
	});
	const versions = useAgentEditVersions({
		...base,
		...formState,
		...composio,
		...loaders,
		...hydrate,
		...save,
		...postureActions,
	});
	const health = useAgentEditHealth({
		...base,
		...formState,
		...composio,
		...loaders,
		...hydrate,
		...save,
		...postureActions,
		...versions,
	});
	const ctx: AgentEditContext = {
		...base,
		...formState,
		...composio,
		...loaders,
		...hydrate,
		...save,
		...postureActions,
		...versions,
		...health,
	};
	const {
		loading,
		recordLoading,
		hydrated,
		installedAgentEngineOptions,
		selectedUninstalledAgent,
		composioToolkitsQuery,
		isBuiltIn,
		personaDisplayName,
		systemPrompt,
		isLocked,
		modelLabel,
		name,
		scheduleSummaryValue,
		toneLabelValue,
		selectedToolsList,
		selectedComposio,
		canPublish,
		setPublishOpen,
		publishOpen,
		acpCommand,
		agentTitle,
		effectiveAgentId,
		agentBannerPreferenceStore,
		chatModel,
		composioConfigured,
		composioAccountOptions,
		composioActionsQuery,
		composioToolkit,
		composioTriggersQuery,
		connectedAccountId,
		customCron,
		customTone,
		dailyTime,
		description,
		engineOptions,
		formError,
		isNew,
		marketplaceWallpapers,
		memoryReadLevels,
		memorySpaceIds,
		memoryWriteEnabled,
		setAcpCommand,
		openAgentsCatalog,
		setRules,
		setAgentTitle,
		goBack,
		setChatModel,
		clearComposioActions,
		setComposioToolkit,
		setConnectedAccountId,
		handleSave,
		setCustomCron,
		setCustomTone,
		setDailyTime,
		handleDeleteTrigger,
		setDescription,
		setMemoryWriteEnabled,
		setName,
		simpleEditor,
		consoleAccess,
		confirmLevelChange,
		setPersonaDisplayName,
		setPersonalityProfileId,
		lifecycleStatus,
		setFormError,
		setScheduleEnabled,
		setSchedulePhrase,
		selectAllComposio,
		handleSubscribeTrigger,
		toggleComposio,
		toggleMemoryReadLevel,
		toggleMemorySpace,
		toggleSkill,
		toggleTool,
		setTone,
		setTriggerSlug,
		setWeeklyDay,
		setWeeklyTime,
		identityMode,
		personalityProfileId,
		personalityProfileOptions,
		rules,
		postureEndpoint,
		posturePendingScope,
		recordScope,
		postureLoadedScope,
		saving,
		scheduleEnabled,
		schedulePhrase,
		selectedSkills,
		selectedTools,
		availableSkills,
		skillsLoading,
		availableSpaces,
		subscribing,
		tone,
		mergedTools,
		toolsLoading,
		triggerError,
		triggerSlug,
		triggerRows,
		weeklyDay,
		weeklyTime,
		promptEditConfirmation,
		setPromptEditConfirmation,
		promptEditConfirmed,
		responseModeDialog,
	} = ctx;

	// Keep all hooks above this loading guard. Existing agents begin with both
	// roster and record loading, so returning before the derived health memos
	// below used to change the hook count when the first request completed.
	if ((loading || recordLoading) && !hydrated) {
		return <SkeletonRows rows={6} spacing="library" />;
	}

	// Save stays disabled until an engine exists to run the agent. Explain the
	// dead end on-screen instead of leaving the button silently greyed out.
	const saveBlockedReason = saveBlockedMessage(
		installedAgentEngineOptions.length,
		selectedUninstalledAgent
	);

	// Composio toolkit options for the integration picker (SlotOption shape).
	const composioToolkitItems: SlotOption[] = (
		composioToolkitsQuery.data ?? []
	).map((t) => ({ id: t.slug, label: t.name }));

	const previewProps = {
		builtIn: isBuiltIn,
		displayName: personaDisplayName,
		instructions: systemPrompt,
		locked: isLocked && !isBuiltIn,
		modelLabel,
		name,
		scheduleSummary: scheduleSummaryValue,
		toneLabel: toneLabelValue,
		tools: [...selectedToolsList, ...Array.from(selectedComposio)],
	};

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="scroll-fade min-h-0 flex-1 overflow-auto p-4 lg:p-6">
				{canPublish ? (
					<div className="mb-4 flex items-center justify-end">
						<Button
							onClick={() => setPublishOpen(true)}
							size="sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={Rocket01Icon} />
							Publish agent template
						</Button>
					</div>
				) : null}
				{canPublish ? (
					<PublishDialog
						kindLabel="Agent Template"
						onOpenChange={setPublishOpen}
						open={publishOpen}
					/>
				) : null}
				<AgentSettingsForm
					{...buildAgentEditPanels(ctx)}
					{...buildAgentEditMorePanels(ctx)}
					acpCommand={acpCommand}
					agentTitle={agentTitle}
					bannerAgentId={effectiveAgentId ?? undefined}
					bannerPreferenceStore={
						effectiveAgentId ? agentBannerPreferenceStore : undefined
					}
					chatModel={chatModel}
					chatSlotDisabled={
						isLocked || (isBuiltIn && installedAgentEngineOptions.length === 0)
					}
					composioAccounts={
						composioConfigured ? composioAccountOptions : undefined
					}
					composioActions={composioActionsQuery.data ?? []}
					composioActionsLoading={composioActionsQuery.isLoading}
					composioConfigured={composioConfigured}
					composioToolkit={composioToolkit}
					composioToolkitItems={composioToolkitItems}
					composioTriggers={composioTriggersQuery.data ?? []}
					connectedAccountId={connectedAccountId}
					customCron={customCron}
					customTone={customTone}
					dailyTime={dailyTime}
					description={description}
					engineOptions={engineOptions}
					formError={formError ?? saveBlockedReason}
					initialSettingId={initialSettingId}
					isBuiltIn={isBuiltIn}
					isLocked={isLocked}
					isNew={isNew}
					marketplaceWallpapers={marketplaceWallpapers}
					memoryReadLevels={memoryReadLevels}
					memorySpaceIds={memorySpaceIds}
					memoryWriteEnabled={memoryWriteEnabled}
					name={name}
					onAcpCommandChange={setAcpCommand}
					onAddMoreAgentProviders={openAgentsCatalog}
					onAddRule={() => setRules((prev) => [...prev, ""])}
					onAgentTitleChange={setAgentTitle}
					onCancel={() => goBack()}
					onChatModelChange={setChatModel}
					onClearComposio={clearComposioActions}
					onComposioToolkitChange={setComposioToolkit}
					onConnectedAccountIdChange={setConnectedAccountId}
					onCreateAndChat={() => handleSave()}
					onCustomCronChange={setCustomCron}
					onCustomToneChange={setCustomTone}
					onDailyTimeChange={setDailyTime}
					onDeleteTrigger={handleDeleteTrigger}
					onDescriptionChange={setDescription}
					onInstallWallpaper={(wallpaper) => installWallpaper(wallpaper.id)}
					onMemoryWriteEnabledChange={setMemoryWriteEnabled}
					onNameChange={setName}
					onOpenAdvanced={
						simpleEditor && consoleAccess
							? () =>
									confirmLevelChange("expert", () => setProductMode("console"))
							: undefined
					}
					onPersonaDisplayNameChange={setPersonaDisplayName}
					onPersonalityProfileChange={setPersonalityProfileId}
					onRemoveRule={(index) =>
						setRules((prev) => prev.filter((_, i) => i !== index))
					}
					onRuleChange={(index, value) =>
						setRules((prev) => prev.map((r, i) => (i === index ? value : r)))
					}
					onSave={() => handleSave()}
					onScheduleEnabledChange={(next) => {
						if (next && lifecycleStatus !== "active") {
							setFormError(
								"Promote this agent to Active before enabling an automation."
							);
							return;
						}
						setScheduleEnabled(next);
					}}
					onSchedulePhraseChange={(value) => {
						const options: SchedulePhrase[] = [
							"everyminute",
							"hourly",
							"daily",
							"weekdays",
							"weekends",
							"weekly",
							"custom",
						];
						const selected = options.find((option) => option === value);
						if (selected) {
							setSchedulePhrase(selected);
						}
					}}
					onSelectAllComposio={selectAllComposio}
					onSubscribeTrigger={() => handleSubscribeTrigger()}
					onToggleComposio={toggleComposio}
					onToggleMemoryReadLevel={toggleMemoryReadLevel}
					onToggleMemorySpace={toggleMemorySpace}
					onToggleSkill={toggleSkill}
					onToggleTool={toggleTool}
					onToneChange={(value) => {
						const selected = TONE_OPTIONS.find(
							(option) => option.value === value
						);
						if (selected) {
							setTone(selected.value);
						}
					}}
					onTriggerSlugChange={setTriggerSlug}
					onWeeklyDayChange={setWeeklyDay}
					onWeeklyTimeChange={setWeeklyTime}
					ownAccountsAllowed={modeHasOwnAccounts(identityMode)}
					personaDisplayName={personaDisplayName}
					personalityProfile={personalityProfileId}
					personalityProfiles={personalityProfileOptions}
					preview={previewProps}
					rules={rules}
					saveDisabled={
						Boolean(
							postureEndpoint &&
								agentPostureResources.get(postureEndpoint)?.pending
						) ||
						posturePendingScope.current === recordScope ||
						(!isNew && postureLoadedScope.current !== recordScope) ||
						saving ||
						installedAgentEngineOptions.length === 0 ||
						selectedUninstalledAgent ||
						isLocked
					}
					saving={saving}
					scheduleEnabled={scheduleEnabled}
					schedulePhrase={schedulePhrase}
					selectedComposio={selectedComposio}
					selectedSkills={selectedSkills}
					selectedTools={selectedTools}
					showAcpCommand={chatModel === ACP_CUSTOM_ENGINE}
					showComposioTriggers={composioConfigured && !isNew && !simpleEditor}
					simple={simpleEditor}
					skills={availableSkills}
					skillsLoading={skillsLoading}
					spaces={availableSpaces}
					subscribing={subscribing}
					systemPrompt={systemPrompt}
					tone={tone}
					toneOptions={TONE_OPTIONS}
					tools={mergedTools}
					toolsLoading={toolsLoading}
					triggerError={triggerError}
					triggerSlug={triggerSlug}
					triggerSubs={triggerRows}
					weeklyDay={weeklyDay}
					weeklyTime={weeklyTime}
				/>
			</div>
			<PromptCacheConfirmDialog
				confirmation={promptEditConfirmation}
				onApply={() => {
					setPromptEditConfirmation(null);
					promptEditConfirmed.current = true;
					handleSave().catch(() => undefined);
				}}
				onCancel={() => setPromptEditConfirmation(null)}
			/>
			{responseModeDialog}
		</div>
	);
}
