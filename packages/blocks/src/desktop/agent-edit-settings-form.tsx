"use client";

import { Button } from "@ryu/ui/components/button";
import { Separator } from "@ryu/ui/components/separator";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentBehaviorPanel } from "./agent-edit-behavior-panel.tsx";
import { AgentConnectionsPanel } from "./agent-edit-connections-panel.tsx";
import { AgentFormActions } from "./agent-edit-form-actions.tsx";
import type { AgentSettingsFormProps } from "./agent-edit-form-types.ts";
import { AgentModelPanel } from "./agent-edit-model-panel.tsx";
import { ProfileCardSection, ProfileHeader } from "./agent-edit-profile.tsx";
import { AgentSettingsSearchBox } from "./agent-edit-settings-search-box.tsx";
import { AgentToolsPanel } from "./agent-edit-tools-panel.tsx";
import { AgentTriggersPanel } from "./agent-edit-triggers-panel.tsx";
import {
	AGENT_ACCOUNT_ACCESS_SETTING_ID,
	AGENT_SETTINGS_ENTRIES,
	type AgentSettingsEntry,
	type AgentSettingsTab,
	revealAgentSetting,
	searchAgentSettings,
} from "./agent-settings-search.ts";

interface EditorTab {
	content: ReactNode;
	hint: string;
	id: AgentSettingsTab;
	label: string;
}

export function AgentSettingsForm(props: AgentSettingsFormProps) {
	const {
		name,
		agentTitle = "",
		onNameChange,
		description,
		onDescriptionChange,
		onAgentTitleChange,
		agentIcon,
		isBuiltIn,
		isNew,
		isLocked,
		initialTab,
		initialSettingId,
		agentSetupComposer,
		promptStudioPanel,
		evalsPanel,
		calendarPanel,
		historyPanel,
		healthPanel,
		healthBadge,
		observabilityPanel,
		optimizationsPanel,
		passportPanel,
		versionHistoryPanel,
		onPersonaDisplayNameChange,
		personaDisplayName,
		capabilitiesPanel,
		identityModePanel,
		accountAccessPanel,
		chatModel,
		showModelPanel = true,
		engineOptions,
		integrationsPanel,
		advancedInference,
		employeeBadge,
		formError,
		saving,
		saveDisabled,
		onCreateAndChat,
		onSave,
		onCancel,
		onOpenAdvanced,
		simple = false,
	} = props;

	// Single tab strip for the whole editor: the config sections plus the
	// folded-in Prompt Studio / Evals / Calendar views. Controlled so the
	// "Open Prompt Studio" shortcut can switch tabs programmatically.
	// Opens on Behavior — what the agent does is the first question, not which
	// engine serves it.
	const [activeTab, setActiveTab] = useState<AgentSettingsTab>(
		initialTab ?? "behavior"
	);
	// Sixty-odd settings behind nine pills: the same "which tab is it under"
	// problem the settings dialogs already solved with a row-level index. Same
	// answer here — `agent-settings-search.ts` indexes the ROWS, and picking a hit
	// switches to its tab and flashes it.
	const [settingsQuery, setSettingsQuery] = useState("");
	const [capabilityQuery, setCapabilityQuery] = useState("");
	// Scopes the reveal to the editor body, so a row title that also appears in
	// the search results list can't win over the real row in the panel.
	const editorRef = useRef<HTMLDivElement | null>(null);
	const settingsHits = useMemo(
		() => searchAgentSettings(settingsQuery),
		[settingsQuery]
	);
	const modelLabel =
		engineOptions.find((option) => option.id === chatModel)?.label ?? chatModel;
	const hasMergedSetup = Boolean(agentSetupComposer);
	const showStandaloneModelPanel = showModelPanel && !hasMergedSetup;
	// Simple mode keeps three tabs. Without the merged composer, the model
	// picker sits inside Behavior instead of earning a fourth tab.
	const showModelTab = showStandaloneModelPanel && !simple;
	// The simple editor drops the Connections tab, so Account access moves
	// under Identity there and the copy names that place.
	const simpleAccountAccess =
		simple && Boolean(identityModePanel) && Boolean(accountAccessPanel);
	const accountAccessPath = simpleAccountAccess
		? "Tools & knowledge → Identity"
		: "Connections → Account access";
	const showInlineModel = showStandaloneModelPanel && simple;

	// ── Panels ───────────────────────────────────────────────────────────────────
	// Each panel is built once and placed into the tab strip below. New and
	// existing agents share the same editor: a short form, not a wizard.

	const modelPanel = <AgentModelPanel props={props} />;

	const triggersPanel = (
		<AgentTriggersPanel accountAccessPath={accountAccessPath} props={props} />
	);

	const toolsPanel = (
		<AgentToolsPanel
			capabilityQuery={capabilityQuery}
			props={props}
			setCapabilityQuery={setCapabilityQuery}
			simpleAccountAccess={simpleAccountAccess}
		/>
	);

	const connectionsPanel = <AgentConnectionsPanel props={props} />;

	const behaviorPanel = (
		<AgentBehaviorPanel
			modelPanel={modelPanel}
			props={props}
			setActiveTab={setActiveTab}
			showInlineModel={showInlineModel}
		/>
	);

	const advancedPanel = (
		<section aria-label="Advanced" className="flex flex-col gap-6">
			<ProfileCardSection
				agentTitle={agentTitle}
				badge={employeeBadge}
				bannerAgentId={props.bannerAgentId}
				bannerPreferenceStore={props.bannerPreferenceStore}
				isLocked={isLocked}
				marketplaceWallpapers={props.marketplaceWallpapers}
				name={name}
				onAgentTitleChange={onAgentTitleChange}
				onInstallWallpaper={props.onInstallWallpaper}
				onPersonaDisplayNameChange={onPersonaDisplayNameChange}
				personaDisplayName={personaDisplayName}
			/>
			{capabilitiesPanel}
			{advancedInference}
		</section>
	);

	// Evals / Calendar / History are all read-only views of what the agent has
	// already done, so they share one "Activity" tab with an inner strip instead
	// of spending three pills of the top-level tab bar.
	const activityViews: { content: ReactNode; id: string; label: string }[] = [];
	if (passportPanel) {
		activityViews.push({
			content: passportPanel,
			id: "passport",
			label: "Agent passport",
		});
	}
	if (observabilityPanel) {
		activityViews.push({
			content: observabilityPanel,
			id: "observability",
			label: "Observability",
		});
	}
	if (evalsPanel) {
		activityViews.push({
			content: evalsPanel,
			id: "evals",
			label: "Quality tests",
		});
	}
	if (optimizationsPanel) {
		activityViews.push({
			content: optimizationsPanel,
			id: "optimizations",
			label: "Optimizations",
		});
	}
	if (historyPanel) {
		activityViews.push({
			content: historyPanel,
			id: "history",
			label: "Run history",
		});
	}
	if (calendarPanel) {
		activityViews.push({
			content: calendarPanel,
			id: "calendar",
			label: "Calendar",
		});
	}

	const firstActivityView = activityViews[0];
	const activityPanel = firstActivityView ? (
		<Tabs defaultValue={firstActivityView.id} spacing="comfortable">
			<TabsList variant="line">
				{activityViews.map((view) => (
					<TabsTrigger key={view.id} value={view.id}>
						{view.label}
					</TabsTrigger>
				))}
			</TabsList>
			{activityViews.map((view) => (
				<TabsContent key={view.id} layout="agent-activity" value={view.id}>
					{view.content}
				</TabsContent>
			))}
		</Tabs>
	) : null;

	// Two tiers, like the agent profiles in Grok, Notion, and Meta: a few
	// essentials everyone needs (what it does, what it can use, when it runs),
	// then everything else behind them. Simple mode (Bot) shows only the
	// essentials; the advanced tier lives in the Agent workspace.
	const essentialTabs: EditorTab[] = [
		{
			content: behaviorPanel,
			hint: "What this agent does, which model runs it, and how it answers.",
			id: "behavior",
			label: "Behavior",
		},
		...(showModelTab
			? [
					{
						content: modelPanel,
						hint: "Which AI runs this agent.",
						id: "model" as const,
						label: "Model",
					},
				]
			: []),
		{
			content: toolsPanel,
			hint: "What it may use, read, and remember.",
			id: "tools",
			label: "Tools & knowledge",
		},
		{
			content: triggersPanel,
			hint: "When it should run on its own, without you asking.",
			id: "triggers",
			label: "Triggers",
		},
	];
	const advancedTabs: EditorTab[] = simple
		? []
		: [
				{
					content: connectionsPanel,
					hint: "Apps it acts through, the accounts it may use, and where you can reach it.",
					id: "connections",
					label: "Connections",
				},
				...(integrationsPanel
					? [
							{
								content: integrationsPanel,
								hint: "Call this agent from code, CI, MCP hosts, or a Ryu App.",
								id: "integrations" as const,
								label: "Integrations",
							},
						]
					: []),
				...(healthPanel
					? [
							{
								content: healthPanel,
								hint: "Common setup checks that update as you edit this agent.",
								id: "health" as const,
								label: "Health",
							},
						]
					: []),
				...(activityPanel
					? [
							{
								content: activityPanel,
								hint: "What this agent has done, and how well it scored.",
								id: "activity" as const,
								label: "Activity",
							},
						]
					: []),
				...(promptStudioPanel
					? [
							{
								content: promptStudioPanel,
								hint: "Write and version the full instructions with the editor.",
								id: "prompt-studio" as const,
								label: "Prompt Studio",
							},
						]
					: []),
				...(versionHistoryPanel
					? [
							{
								content: versionHistoryPanel,
								hint: "Compare and restore complete saved agent configurations.",
								id: "versions" as const,
								label: "Versions",
							},
						]
					: []),
				{
					content: advancedPanel,
					hint: "Profile card, model capabilities, orchestration, and engine defaults.",
					id: "advanced",
					label: "Advanced",
				},
			];
	const editorTabs = [...essentialTabs, ...advancedTabs];
	const availableTabIds = new Set(editorTabs.map((tab) => tab.id));

	// A tab can disappear underneath the selection (the model panel merges into
	// the composer, an injected panel is withdrawn, or the editor switches to
	// simple mode). Fall back to Behavior instead of rendering an empty body.
	const activeTabAvailable = editorTabs.some((tab) => tab.id === activeTab);
	useEffect(() => {
		if (!activeTabAvailable) {
			setActiveTab("behavior");
		}
	}, [activeTabAvailable]);

	// A host asked to open on one setting. Its tab can arrive a render late (the
	// panel waits on the record), so this waits for the tab, then reveals once.
	// The simple editor shows Account access under Identity instead.
	const initialSettingTab = (() => {
		const entry = AGENT_SETTINGS_ENTRIES.find(
			(candidate) => candidate.id === initialSettingId
		);
		if (!entry) {
			return null;
		}
		const tab =
			entry.id === AGENT_ACCOUNT_ACCESS_SETTING_ID && simpleAccountAccess
				? "tools"
				: entry.tab;
		return availableTabIds.has(tab) ? { entry, tab } : null;
	})();
	const initialSettingShown = useRef(false);
	const cancelInitialReveal = useRef<(() => void) | null>(null);
	useEffect(() => {
		if (initialSettingShown.current || !initialSettingTab) {
			return;
		}
		initialSettingShown.current = true;
		setActiveTab(initialSettingTab.tab);
		cancelInitialReveal.current = revealAgentSetting(
			initialSettingTab.entry,
			editorRef.current ?? document
		);
	}, [initialSettingTab]);
	useEffect(() => () => cancelInitialReveal.current?.(), []);

	const activeHint = editorTabs.find((tab) => tab.id === activeTab)?.hint ?? "";

	// A hit filed under an absent tab would switch to a pill that isn't there
	// and leave the editor showing nothing. Drop those instead of a dead row.
	const visibleHits = settingsHits.filter((hit) =>
		availableTabIds.has(hit.tab)
	);

	// Switch to the hit's tab, then flash the row. The reveal polls, because the
	// panel is a commit (or, for one that fetches first, a few hundred ms) away
	// from being in the DOM when this runs.
	const handleSelectSetting = (entry: AgentSettingsEntry) => {
		setActiveTab(entry.tab);
		setSettingsQuery("");
		revealAgentSetting(entry, editorRef.current ?? document);
	};

	const actions = (
		<AgentFormActions
			formError={formError}
			isLocked={isLocked}
			isNew={isNew}
			onCancel={onCancel}
			onCreateAndChat={onCreateAndChat}
			onSave={onSave}
			saveDisabled={saveDisabled}
			saving={saving}
		/>
	);

	// Search only earns its place once the advanced tier is there; four
	// essentials tabs are short enough to scan.
	const settingsSearch = simple ? null : (
		<AgentSettingsSearchBox
			handleSelectSetting={handleSelectSetting}
			setSettingsQuery={setSettingsQuery}
			settingsQuery={settingsQuery}
			visibleHits={visibleHits}
		/>
	);

	return (
		<div className="mx-auto w-full max-w-3xl" ref={editorRef}>
			<div className="flex min-w-0 flex-col gap-6">
				<ProfileHeader
					agentIcon={agentIcon}
					builtIn={isBuiltIn}
					description={description}
					healthBadge={simple ? undefined : healthBadge}
					isLocked={isLocked}
					isNew={isNew}
					modelLabel={modelLabel}
					name={name}
					onCreateAndChat={onCreateAndChat}
					onDescriptionChange={onDescriptionChange}
					onNameChange={onNameChange}
					onSave={onSave}
					saveDisabled={saveDisabled}
					saving={saving}
				/>

				<Tabs onValueChange={setActiveTab} spacing="relaxed" value={activeTab}>
					<div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
						{/* Unmanaged: children render in order, so the divider stays between
						    the two tiers, and an overflowing strip scrolls with arrows instead
						    of folding tabs into a menu. */}
						<TabsList
							className="min-w-0 max-w-full"
							manageLayout={false}
							variant="pills"
						>
							{essentialTabs.map((tab) => (
								<TabsTrigger key={tab.id} value={tab.id}>
									{tab.label}
								</TabsTrigger>
							))}
							{advancedTabs.length > 0 ? (
								<Separator
									className="mx-1 h-4 self-center"
									orientation="vertical"
								/>
							) : null}
							{advancedTabs.map((tab) => (
								<TabsTrigger key={tab.id} tone="muted" value={tab.id}>
									{tab.label}
								</TabsTrigger>
							))}
						</TabsList>
						{settingsSearch}
						{simple && onOpenAdvanced ? (
							<Button onClick={onOpenAdvanced} size="sm" variant="ghost-muted">
								Advanced settings in the Agent workspace
							</Button>
						) : null}
					</div>

					{activeHint ? (
						<p className="px-1 text-muted-foreground text-xs">{activeHint}</p>
					) : null}

					{editorTabs.map((tab) => (
						<TabsContent key={tab.id} layout="agent-settings" value={tab.id}>
							{tab.content}
						</TabsContent>
					))}
				</Tabs>

				{actions}
			</div>
		</div>
	);
}
