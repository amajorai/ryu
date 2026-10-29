import { LockedIcon, Rocket01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AgentBannerPreferenceStore } from "@ryu/blocks/desktop/agent-banner-dialog.tsx";
import {
	AgentByoaView,
	AgentIntegrationsView,
	AgentSettingsForm,
	type ComposioAccountOption,
	type SlotOption,
} from "@ryu/blocks/desktop/agent-edit.tsx";
import { promptEditCacheWarning } from "@ryu/blocks/desktop/agent-elements/prompt-cache.ts";
import {
	type AgentIntegrationSnippetLang,
	buildAgentIntegrationSnippet,
	buildGitHubActionsSnippet,
} from "@ryu/blocks/desktop/agent-integration-snippets.ts";
import {
	ScorecardBadge,
	ScorecardPanel,
} from "@ryu/marketplace/catalog/detail/scorecard-panel";
import {
	type AgentHealthInput,
	runAgentScorecard,
} from "@ryu/marketplace/catalog/scorecard";
import { getMarketplaceBackdrops } from "@ryu/ui/components/backdrop/marketplace-backdrops.ts";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import { composeRules, parseRules } from "@ryuhq/protocol/agent-rules";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { WEB_URL } from "@/lib/app-urls.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { AcpAgentSettingsPanel } from "@/src/components/agents/AcpAgentSettingsPanel.tsx";
import { AcpSessionControls } from "@/src/components/agents/AcpSessionControls.tsx";
import { AgentAccountAccessPanel } from "@/src/components/agents/AgentAccountAccessPanel.tsx";
import { AgentBudgetPanel } from "@/src/components/agents/AgentBudgetPanel.tsx";
import { AgentCalendarView } from "@/src/components/agents/AgentCalendarView.tsx";
import { AgentCapabilitiesPanel } from "@/src/components/agents/AgentCapabilitiesPanel.tsx";
import { AgentChannelsSection } from "@/src/components/agents/AgentChannelsSection.tsx";
import { AgentEmailAliasSection } from "@/src/components/agents/AgentEmailAliasSection.tsx";
import { AgentEvalsView } from "@/src/components/agents/AgentEvalsView.tsx";
import { AgentExecutionPolicyPanel } from "@/src/components/agents/AgentExecutionPolicyPanel.tsx";
import { AgentGoalPanel } from "@/src/components/agents/AgentGoalPanel.tsx";
import {
	AgentIdentityModePicker,
	AgentRemotePeerIdentityNote,
	identityModeAccountWarning,
	isRemotePeerEngine,
	modeHasOwnAccounts,
	modeUsesYourAccounts,
} from "@/src/components/agents/AgentIdentityModePicker.tsx";
import { AgentImageField } from "@/src/components/agents/AgentImageField.tsx";
import { AgentLanyardCard } from "@/src/components/agents/AgentLanyardCard.tsx";
import {
	AgentLaunchWarning,
	agentIsConfined,
	agentModelsLimited,
	MANAGED_PI_NOTE,
	RYU_ENGINE_ID,
} from "@/src/components/agents/AgentLaunchWarning.tsx";
import { AgentObservabilityView } from "@/src/components/agents/AgentObservabilityView.tsx";
import { AgentOptimizationsView } from "@/src/components/agents/AgentOptimizationsView.tsx";
import { AgentPassportPanel } from "@/src/components/agents/AgentPassportPanel.tsx";
import { AgentPendingIdentityModeNotice } from "@/src/components/agents/AgentPendingIdentityModeNotice.tsx";
import { AgentRoutePoolEditor } from "@/src/components/agents/AgentRoutePoolEditor.tsx";
import { AgentRoutinesPanel } from "@/src/components/agents/AgentRoutinesPanel.tsx";
import { AgentRunHistoryView } from "@/src/components/agents/AgentRunHistoryView.tsx";
import { AgentSetupComposer } from "@/src/components/agents/AgentSetupComposer.tsx";
import { AgentSmartRouteOverride } from "@/src/components/agents/AgentSmartRouteOverride.tsx";
import { AgentVersionHistoryPanel } from "@/src/components/agents/AgentVersionHistoryPanel.tsx";
import {
	pausedTriggerIds,
	savedModeHasOwnApps,
} from "@/src/components/agents/agent-account-keys.ts";
import { ClaudeGatewayConfig } from "@/src/components/agents/ClaudeGatewayConfig.tsx";
import { CodexGatewayConfig } from "@/src/components/agents/CodexGatewayConfig.tsx";
import { GatewayRoutingConfig } from "@/src/components/agents/GatewayRoutingConfig.tsx";
import { OrchestrationPanel } from "@/src/components/agents/OrchestrationPanel.tsx";
import { RulesAgentEditPanel } from "@/src/components/agents/RulesAgentEditPanel.tsx";
import { RyuPiConfig } from "@/src/components/agents/RyuPiConfig.tsx";
import {
	type PromptCacheConfirmation,
	PromptCacheConfirmDialog,
} from "@/src/components/chat/PromptCacheConfirmDialog.tsx";
import { PublishDialog } from "@/src/components/marketplace/PublishDialog.tsx";
import { PromptStudio } from "@/src/components/PromptStudio.tsx";
import { SettingsSection } from "@/src/components/settings/shared/settings-items.tsx";
import type { VersionSource } from "@/src/components/versioning/VersionHistory.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useTitleBar } from "@/src/contexts/TitleBarContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgentLaunchCheck } from "@/src/hooks/useAgentLaunchCheck.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useAssistantBuilder } from "@/src/hooks/useAssistantBuilder.ts";
import {
	useAgentComposioConnections,
	useComposioActions,
	useComposioConnections,
	useComposioStatus,
	useComposioToolkits,
	useComposioTriggers,
} from "@/src/hooks/useComposioCatalog.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { useResponseModeConfirm } from "@/src/hooks/useResponseModeConfirm.tsx";
import {
	encodeSkillAllowlist,
	encodeToolAllowlist,
	hydrateSkillSelection,
	hydrateToolSelection,
} from "@/src/lib/agent-capabilities.ts";
import { agentEngineOptionId } from "@/src/lib/agent-engine.ts";
import { AgentLogo } from "@/src/lib/agent-logos.tsx";
import { buildNewAgentChatSeed } from "@/src/lib/agent-onboarding.ts";
import {
	glyphToPersonaFields,
	personaToGlyphValue,
} from "@/src/lib/agent-persona.ts";
import {
	legacyRulesToConfig,
	saveAgentRulesConfig,
} from "@/src/lib/api/agent-rules.ts";
import {
	type Agent,
	type AgentIdentityMode,
	type AgentLifecycleStatus,
	type AgentSafetyProfile,
	type AgentTools,
	bumpPatchVersion,
	createAgentVersion,
	fetchAgent,
	fetchAgentTools,
	getAgentVersionSource,
	listAgentVersions,
	restoreAgentVersion,
	updateAgentAccountSettings,
	updateAgentPosture,
} from "@/src/lib/api/agents.ts";
import { runCatalogScan } from "@/src/lib/api/catalog-scan.ts";
import { type ApiTarget, apiUrl } from "@/src/lib/api/client.ts";
import {
	deleteTriggerSubscription,
	fetchTriggerSubscriptions,
	subscribeTrigger,
	type TriggerSubscription,
} from "@/src/lib/api/composio-triggers.ts";
import {
	fetchGatewayConfig,
	type GatewayApiKey,
	generateGatewayKey,
	registerByoaKey,
} from "@/src/lib/api/gateway.ts";
import type { SamplingConfig } from "@/src/lib/api/inference.ts";
import { fetchMcpTools } from "@/src/lib/api/mcp.ts";
import { listOutputStyles } from "@/src/lib/api/output-styles.ts";
import { getPreference, setPreference } from "@/src/lib/api/preferences.ts";
import { type InstalledSkill, listSkills } from "@/src/lib/api/skills.ts";
import { fetchSpaces } from "@/src/lib/api/spaces.ts";
import {
	createScheduledAgentWorkflow,
	phraseToSchedule,
	type SchedulePhrase,
} from "@/src/lib/automations.ts";
import { usePluginBackgrounds } from "@/src/lib/plugin-backgrounds.ts";
import {
	setProductMode,
	useProductMode,
	useProductModeStore,
} from "@/src/lib/product-mode.ts";
import { promptLayerChanges } from "@/src/lib/prompt-layer-changes.ts";
import { installWallpaper } from "@/src/lib/wallpaper-library.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

// ── BYOA panel ────────────────────────────────────────────────────────────────

interface ByoaPanelProps {
	agentId: string;
	target: ApiTarget;
}

function ByoaPanel({ target, agentId }: ByoaPanelProps) {
	const [gatewayUrl, setGatewayUrl] = useState<string | null>(null);
	const [existingKeys, setExistingKeys] = useState<GatewayApiKey[]>([]);
	const [generatedKey, setGeneratedKey] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState<"url" | "key" | null>(null);

	const keyName = `byoa:${agentId}`;

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const cfg = await fetchGatewayConfig(target);
			const keys = cfg.auth?.api_keys ?? [];
			setExistingKeys(keys);
		} catch {
			setError("Gateway config unavailable");
		} finally {
			setLoading(false);
		}
	}, [target]);

	useEffect(() => {
		load();
	}, [load]);

	useEffect(() => {
		const coreBase = target.url.replace(PORT_SUFFIX_RE, "");
		setGatewayUrl(`${coreBase}:7981`);
	}, [target.url]);

	const existingKey = existingKeys.find((k) => k.name === keyName);
	const hasKey = Boolean(existingKey);

	const handleGenerate = async () => {
		setSaving(true);
		setError(null);
		const newKey = generateGatewayKey();
		try {
			const entry: GatewayApiKey = {
				name: keyName,
				key: newKey,
				trusted_forwarder: true,
			};
			await registerByoaKey(target, entry);
			setGeneratedKey(newKey);
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to generate key");
		} finally {
			setSaving(false);
		}
	};

	const copyToClipboard = async (text: string, kind: "url" | "key") => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(kind);
			setTimeout(() => setCopied(null), 2000);
		} catch {
			// Clipboard access may be blocked in some Tauri contexts — ignore.
		}
	};

	return (
		<AgentByoaView
			agentId={agentId}
			copied={copied}
			error={error}
			gatewayUrl={gatewayUrl}
			generatedKey={generatedKey}
			hasKey={hasKey}
			loading={loading}
			onCopyKey={() =>
				generatedKey ? copyToClipboard(generatedKey, "key") : undefined
			}
			onCopyUrl={() =>
				gatewayUrl ? copyToClipboard(`${gatewayUrl}/v1`, "url") : undefined
			}
			onGenerate={() => handleGenerate()}
			saving={saving}
		/>
	);
}

// ── Connect with code panel ─────────────────────────────────────────────────────

interface IntegrationsPanelProps {
	agentId: string;
	target: ApiTarget;
}

const TRAILING_SLASH_RE = /\/+$/;
const PORT_SUFFIX_RE = /:\d+$/;
const INTEGRATION_DOCS_PATH = "/docs/extend/develop/agent-integration-guide";

/** Strip the trailing slash so we never build `…//api/chat/stream`. */
function normalizeBase(url: string): string {
	return url.replace(TRAILING_SLASH_RE, "");
}

function openIntegrationDocs(): void {
	void openExternal(
		`${WEB_URL.replace(TRAILING_SLASH_RE, "")}${INTEGRATION_DOCS_PATH}`
	).catch(() => undefined);
}

export function IntegrationsPanel({ target, agentId }: IntegrationsPanelProps) {
	const [lang, setLang] = useState<AgentIntegrationSnippetLang>("typescript");
	const [copied, setCopied] = useState(false);

	const base = useMemo(() => normalizeBase(target.url), [target.url]);
	const hasToken = Boolean(target.token);
	const snippet = useMemo(
		() =>
			buildAgentIntegrationSnippet({
				agentId,
				baseUrl: base,
				hasToken,
				language: lang,
			}),
		[agentId, base, hasToken, lang]
	);
	const githubActionsSnippet = useMemo(
		() => buildGitHubActionsSnippet(agentId),
		[agentId]
	);

	const copySnippet = async () => {
		try {
			await navigator.clipboard.writeText(snippet);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard access may be blocked in some Tauri contexts.
		}
	};

	return (
		<AgentIntegrationsView
			agentId={agentId}
			byoaPanel={<ByoaPanel agentId={agentId} target={target} />}
			copied={copied}
			coreUrl={base}
			githubActionsSnippet={githubActionsSnippet}
			hasToken={hasToken}
			lang={lang}
			onCopy={() => {
				void copySnippet();
			}}
			onLangChange={setLang}
			onOpenDocs={openIntegrationDocs}
			snippet={snippet}
		/>
	);
}

type ToneOption = "neutral" | "professional" | "friendly" | "pirate" | "custom";

const TONE_OPTIONS: { value: ToneOption; label: string }[] = [
	{ value: "neutral", label: "Neutral (default)" },
	{ value: "professional", label: "Professional" },
	{ value: "friendly", label: "Friendly" },
	{ value: "pirate", label: "Pirate" },
	{ value: "custom", label: "Custom" },
];

/** Client-only sentinel for an agent that does not use a reusable profile. */
const AGENT_OWN_VOICE_PROFILE = "__agent_own_voice__";

// ── Fallback tool list (used when GET /api/mcp/tools returns empty) ───────────
// Core's agent allowlist matches a tool id, bare tool name, or owning server, so
// the fallback offers built-in server names that always resolve.

const FALLBACK_TOOLS = [
	"web",
	"web_fetch",
	"browser",
	"memory",
	"spaces",
	"artifact",
	"sandbox",
];

// Schedule phrase → workflow conversion lives in `lib/automations.ts` (shared
// with the calendar's New automation dialog). `SchedulePhrase` and
// `phraseToSchedule` are imported above.

// ── Preview label derivations ─────────────────────────────────────────────────

function toneLabel(tone: ToneOption, customTone: string): string | null {
	if (tone === "neutral") {
		return null;
	}
	if (tone === "custom") {
		return customTone.trim() || null;
	}
	return TONE_OPTIONS.find((o) => o.value === tone)?.label ?? null;
}

function scheduleSummary(
	enabled: boolean,
	phrase: SchedulePhrase,
	dailyTime: string,
	weeklyDay: string,
	weeklyTime: string
): string | null {
	if (!enabled) {
		return null;
	}
	if (phrase === "everyminute") {
		return "Runs every minute";
	}
	if (phrase === "hourly") {
		return "Runs hourly";
	}
	if (phrase === "daily") {
		return `Runs daily at ${dailyTime}`;
	}
	if (phrase === "weekdays") {
		return `Runs weekdays at ${dailyTime}`;
	}
	if (phrase === "weekends") {
		return `Runs weekends at ${dailyTime}`;
	}
	if (phrase === "weekly") {
		const day = weeklyDay.charAt(0).toUpperCase() + weeklyDay.slice(1);
		return `Runs weekly · ${day} ${weeklyTime}`;
	}
	return "Custom schedule";
}

// ── Main page ──────────────────────────────────────────────────────────────────

/** Engine-picker sentinel for the BYO "Custom ACP command…" option. */
const ACP_CUSTOM_ENGINE = "__acp_exec_custom__";
/** Engine prefix Core treats as a literal ACP spawn command (`agent_route`). */
const ACP_EXEC_PREFIX = "acp-exec:";

function isInstalledChatModel(
	chatModel: string,
	installedAgentEngineIds: Set<string>
): boolean {
	return (
		chatModel === ACP_CUSTOM_ENGINE || installedAgentEngineIds.has(chatModel)
	);
}

function saveBlockedMessage(
	installedAgentEngineCount: number,
	selectedUninstalledAgent: boolean
): string | null {
	if (installedAgentEngineCount === 0) {
		return "No agents are installed yet, so there's nothing to run this agent. Install an agent to turn on saving.";
	}
	if (selectedUninstalledAgent) {
		return "This agent is not installed yet. Add it from the agent catalog before selecting it here.";
	}
	return null;
}

// This is an advisory signal for the local scorecard, not an authorization
// check. Core and Gateway remain the authorities that classify and enforce tool
// effects; the editor only helps a person notice a broad or write-capable setup.
const HIGH_IMPACT_TOOL_RE =
	/(?:^|[._:-])(write|delete|remove|update|create|send|publish|execute|exec|run|post|patch|put)(?:$|[._:-])/i;

function isHighImpactTool(toolName: string): boolean {
	return HIGH_IMPACT_TOOL_RE.test(toolName);
}

interface AgentPostureResource {
	endpoint: string;
	listeners: Set<() => void>;
	pending: Promise<void> | null;
	settledScope: object | null;
}
// An in-flight write belongs to the physical record, independent of editor or
// query-client lifetime. Rendering and publication still belong to recordScope.
const agentPostureResources = new Map<string, AgentPostureResource>();
function postureResourceFor(
	target: ApiTarget,
	id: string | null
): AgentPostureResource | null {
	if (!(id && target.url.replace(/\/+$/, ""))) {
		return null;
	}
	const endpoint = apiUrl(target, `/api/agents/${encodeURIComponent(id)}`);
	let resource = agentPostureResources.get(endpoint);
	if (!resource) {
		resource = {
			endpoint,
			pending: null,
			settledScope: null,
			listeners: new Set(),
		};
		agentPostureResources.set(endpoint, resource);
	}
	return resource;
}

function releasePostureResource(resource: AgentPostureResource) {
	if (
		!resource.pending &&
		resource.listeners.size === 0 &&
		agentPostureResources.get(resource.endpoint) === resource
	) {
		agentPostureResources.delete(resource.endpoint);
	}
}

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
	const { agentId: routeAgentId } = useParams<{ agentId: string }>();
	const agentId = agentIdProp ?? routeAgentId;
	const navigate = useNavigate();
	const openTab = useTabSelector((state) => state.openTab);
	const openAgentsCatalog = useCallback(() => {
		openTab("/store/agents", { title: "Customize" });
	}, [openTab]);
	// Stable identity so the callbacks that close over it don't churn every render.
	const goBack = useCallback(() => {
		if (onClose) {
			onClose();
		} else {
			navigate("/library/agent");
		}
	}, [onClose, navigate]);
	const isNew = agentId === "new" || !agentId;
	const { agents, activeEngine, loading, create, reload, update } = useAgents();
	// Bot gets the essentials-only editor; Agent and OS get every tab.
	const productMode = useProductMode();
	const simpleEditor = productMode === "bot";
	const consoleAccess = useProductModeStore((state) => state.consoleAccess);

	const activeNode = useActiveNode();
	const projectCwd = useWorkspaceStore((state) => state.folder);
	const pluginContributions = usePluginContributions();
	const target: ApiTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);
	// Each actual authority/agent transition gets a new opaque identity, including
	// A→B→A. Equivalent node snapshots retain the current unsaved draft.
	const recordScope = useMemo(() => ({}), [agentId, isNew, target]);
	const editorMounted = useRef(true);
	useEffect(() => {
		editorMounted.current = true;
		return () => {
			editorMounted.current = false;
		};
	}, []);
	const activeRecordScope = useRef(recordScope);
	activeRecordScope.current = recordScope;
	const loadedRecordScope = useRef<object | null>(null);
	const recordReadGeneration = useRef(0);
	const posturePendingScope = useRef<object | null>(null);
	const pluginBackgrounds = usePluginBackgrounds();
	const marketplaceWallpapers = useMemo(
		() => getMarketplaceBackdrops(pluginBackgrounds),
		[pluginBackgrounds]
	);
	const agentBannerPreferenceStore = useMemo<AgentBannerPreferenceStore>(
		() => ({
			get: (agentId) =>
				getPreference(
					target,
					`ryu.agent-banner.v1:${encodeURIComponent(agentId)}`
				),
			set: async (agentId, value) => {
				await setPreference(
					target,
					`ryu.agent-banner.v1:${encodeURIComponent(agentId)}`,
					value
				);
			},
		}),
		[target]
	);
	const personalityProfilesQuery = useQuery({
		queryKey: ["agent-personality-profiles", target.url, target.token],
		queryFn: () => listOutputStyles(target),
		staleTime: 30_000,
		retry: false,
	});
	const agentEditPanels = useMemo(
		() =>
			pluginContributions.agent_edit_panels.filter(
				(panel) => panel.type === "rules"
			),
		[pluginContributions.agent_edit_panels]
	);

	const installedAgentEngineOptions = useMemo(() => {
		const options: SlotOption[] = [];
		const seen = new Set<string>();
		for (const agent of agents) {
			const id = agentEngineOptionId(agent);
			if (!id || seen.has(id)) {
				continue;
			}
			seen.add(id);
			options.push({
				id,
				label:
					activeEngine?.active === id ? `${agent.name} (active)` : agent.name,
			});
		}
		return options;
	}, [agents, activeEngine]);
	const installedAgentEngineIds = useMemo(
		() => new Set(installedAgentEngineOptions.map((option) => option.id)),
		[installedAgentEngineOptions]
	);

	// Sentinel engine option that reveals a free-text command box so the user can
	// point this agent at ANY ACP-compatible binary/command (a binary-only
	// registry agent they installed — goose/cursor/opencode/… — a private/
	// in-house agent, or a future one). Saved as the `acp-exec:<command>` engine
	// Core runs as an ACP subprocess; all session controls + diff rendering apply.
	const engineOptions: SlotOption[] = useMemo(
		() => [
			...installedAgentEngineOptions,
			{ id: ACP_CUSTOM_ENGINE, label: "Run a custom agent command…" },
		],
		[installedAgentEngineOptions]
	);

	// ── Core form state ──────────────────────────────────────────────────────────
	const [name, setName] = useState("");
	const [agentTitle, setAgentTitle] = useState("");
	const [description, setDescription] = useState("");
	const [systemPrompt, setSystemPrompt] = useState("");
	const [promptEditConfirmation, setPromptEditConfirmation] =
		useState<PromptCacheConfirmation | null>(null);
	const promptEditConfirmed = useRef(false);
	// Opening the advanced editor moves Ryu Work to Console, which switches the
	// response mode in every Ryu assistant thread's system prompt.
	const { confirmLevelChange, dialog: responseModeDialog } =
		useResponseModeConfirm();
	const [chatModel, setChatModel] = useState("");
	const [agentModel, setAgentModel] = useState("");
	const [agentModelEngine, setAgentModelEngine] = useState<string | null>(null);
	const selectedUninstalledAgent =
		Boolean(chatModel) &&
		!isInstalledChatModel(chatModel, installedAgentEngineIds);
	// For a brand-new agent, the builder chat needs a real record to edit. We
	// lazily create a draft on the first builder message and adopt its id here;
	// from then on the page edits the draft instead of creating a new agent.
	const [draftId, setDraftId] = useState<string | null>(null);
	// A `/agents/new/edit` tab stays mounted after it opens the first chat. Keep
	// the hand-off one-shot so returning to the editor and saving an update does
	// not create another welcome thread.
	const newAgentChatOpenedRef = useRef(false);
	// Free-text ACP command shown when the "Custom ACP command…" engine is picked.
	const [acpCommand, setAcpCommand] = useState("");
	const [existing, setExisting] = useState<Agent | null>(null);
	const [dismissingPendingMode, setDismissingPendingMode] = useState(false);
	const [lifecycleStatus, setLifecycleStatus] =
		useState<AgentLifecycleStatus>("trial");
	const [safetyProfile, setSafetyProfile] =
		useState<AgentSafetyProfile>("read_only");
	const [postureSaving, setPostureSaving] = useState(false);
	const [postureError, setPostureError] = useState<{
		scope: object;
		message: string;
		readRetry: boolean;
	} | null>(null);
	const postureLoadedScope = useRef<object | null>(null);
	const effectiveAgentId = isNew ? draftId : (agentId ?? null);
	const postureEndpoint = useMemo(
		() =>
			effectiveAgentId && target.url.replace(/\/+$/, "")
				? apiUrl(target, `/api/agents/${encodeURIComponent(effectiveAgentId)}`)
				: null,
		[target, effectiveAgentId]
	);
	const [agentToolsData, setAgentToolsData] = useState<AgentTools | null>(null);
	const [recordLoading, setRecordLoading] = useState(!isNew);
	const [savingScope, setSavingScope] = useState<object | null>(null);
	const saving = savingScope === recordScope;
	const [formError, setFormError] = useState<string | null>(null);
	const [hydrated, setHydrated] = useState(false);
	// Marketplace publish dialog (Phase 5a). Only offered for a saved, custom
	// (non-built-in) agent — a built-in is Ryu's to publish, and a brand-new
	// unsaved agent has no record to package yet.
	const [publishOpen, setPublishOpen] = useState(false);

	// ── Persona state ────────────────────────────────────────────────────────────
	const [personaDisplayName, setPersonaDisplayName] = useState("");
	const [tone, setTone] = useState<ToneOption>("neutral");
	const [customTone, setCustomTone] = useState("");
	const [personalityProfileId, setPersonalityProfileId] = useState(
		AGENT_OWN_VOICE_PROFILE
	);
	const personalityProfileOptions = useMemo<SlotOption[]>(() => {
		const options: SlotOption[] = [
			{ id: AGENT_OWN_VOICE_PROFILE, label: "Agent's own voice" },
		];
		const styles = personalityProfilesQuery.data?.styles ?? [];
		for (const style of styles) {
			options.push({ id: style.id, label: style.name });
		}
		if (
			personalityProfileId !== AGENT_OWN_VOICE_PROFILE &&
			personalityProfileId &&
			!options.some((option) => option.id === personalityProfileId)
		) {
			// Keep a profile selected in the editor when its plugin/file is currently
			// unavailable; saving must not silently clear an agent's configuration.
			options.push({
				id: personalityProfileId,
				label: `Unavailable (${personalityProfileId})`,
			});
		}
		return options;
	}, [personalityProfileId, personalityProfilesQuery.data?.styles]);
	// Custom agent avatar — single GlyphValue covering avatar/icon/emoji/
	// dicebear/expressive/dither. Null = use the engine logo.
	const [avatarGlyph, setAvatarGlyph] = useState<GlyphValue>(null);

	// ── Advanced inference (per-agent sampling defaults) ─────────────────────────
	const [sampling, setSampling] = useState<SamplingConfig>({});

	// ── Orchestration capabilities ───────────────────────────────────────────────
	// Effective values (null in the record collapses to the code default here:
	// delegation on, creation off). Saved as explicit booleans on the agent body.
	const [orchestrator, setOrchestrator] = useState(true);
	const [canCreateAgents, setCanCreateAgents] = useState(false);

	// ── Rules state (folded into the system prompt on save) ──────────────────────
	const [rules, setRules] = useState<string[]>([]);

	// ── Tools state ──────────────────────────────────────────────────────────────
	const [availableTools, setAvailableTools] = useState<string[]>([]);
	const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
	const [toolsLoading, setToolsLoading] = useState(false);

	// ── Skills state (new cards hydrate with all globally enabled skills) ──────────
	const [availableSkills, setAvailableSkills] = useState<InstalledSkill[]>([]);
	const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
	const [skillsLoading, setSkillsLoading] = useState(false);
	const capabilitiesHydratedRef = useRef(false);

	// ── Identity Vault binding state (per-agent profile allowlist; empty = none) ─
	const [selectedIdentities, setSelectedIdentities] = useState<Set<string>>(
		new Set()
	);

	// ── Identity mode + account allowlist ────────────────────────────────────────
	// `managed` with a `null` allowlist is Core's legacy default: the agent acts
	// as the user with every account they connected. Both save with the form.
	const [identityMode, setIdentityMode] =
		useState<AgentIdentityMode>("managed");
	const [accountAccess, setAccountAccess] = useState<string[] | null>(null);

	// ── Memory / Spaces slot state ───────────────────────────────────────────────
	// `memorySpaceIds`: Space ids the agent may read (empty = none injected).
	// `memoryReadLevels`: recallable memory levels (empty = all personal levels).
	// `memoryWriteEnabled`: may the agent record new memories.
	const [availableSpaces, setAvailableSpaces] = useState<
		{ id: string; name: string }[]
	>([]);
	const [memorySpaceIds, setMemorySpaceIds] = useState<Set<string>>(new Set());
	const [memoryReadLevels, setMemoryReadLevels] = useState<Set<string>>(
		new Set()
	);
	const [memoryWriteEnabled, setMemoryWriteEnabled] = useState(false);

	// ── Composio actions state (per-agent allowlist; gateway-route only) ─────────
	const [selectedComposio, setSelectedComposio] = useState<Set<string>>(
		new Set()
	);
	const [composioToolkit, setComposioToolkit] = useState<string | null>(null);

	// ── Coming-soon attribute slots (collapsed by default) ───────────────────────

	// ── Schedule/trigger state ───────────────────────────────────────────────────
	const [scheduleEnabled, setScheduleEnabled] = useState(false);
	const [schedulePhrase, setSchedulePhrase] = useState<SchedulePhrase>("daily");
	const [dailyTime, setDailyTime] = useState("09:00");
	const [weeklyDay, setWeeklyDay] = useState("monday");
	const [weeklyTime, setWeeklyTime] = useState("09:00");
	const [customCron, setCustomCron] = useState("");

	// ── Composio browse (gateway-route actions) ──────────────────────────────────
	const composioStatus = useComposioStatus();
	const composioConfigured = composioStatus.data?.configured ?? false;
	const composioThroughConnect =
		composioStatus.data?.executionOwner === "connect";
	const composioToolkitsQuery = useComposioToolkits(composioConfigured);
	const composioActionsQuery = useComposioActions(composioToolkit);
	const composioTriggersQuery = useComposioTriggers(composioToolkit);
	const composioConnectionsQuery = useComposioConnections(
		"",
		composioConfigured
	);
	// The identity mode Core holds for this agent. Core keeps apps on an
	// agent's own identity only once it is saved as Its own identity or Both
	// (it answers 409 for one saved as Acts as you), so an unsaved switch offers
	// none until it is saved.
	const savedIdentityMode = existing?.identityMode ?? null;
	const ownAppsAvailable =
		modeHasOwnAccounts(identityMode) && savedModeHasOwnApps(savedIdentityMode);
	// The apps connected to this agent's own identity (Its own identity or
	// Both). Core answers 501 when a Connect service does not enable agent
	// accounts.
	const ownComposioConnectionsQuery = useAgentComposioConnections(
		isNew ? null : (agentId ?? null),
		ownAppsAvailable && composioConfigured && !isNew
	);
	// Accounts an event trigger may watch: the user's connected accounts that
	// this agent may use, and the active apps connected to its own identity
	// that its account access allows (only once the saved mode has them). A
	// limit narrows each to the ticked ones. Core re-checks both on subscribe
	// and on every event.
	const composioAccountOptions = useMemo<ComposioAccountOption[]>(() => {
		const labelOf = (connection: {
			active: boolean;
			id: string;
			status: string;
			toolkit: string;
		}) =>
			`${connection.toolkit} · ${connection.active ? "Active" : connection.status.toLowerCase() || "inactive"} · ${connection.id}`;
		const yours = modeUsesYourAccounts(identityMode)
			? (composioConnectionsQuery.data ?? []).filter(
					(connection) =>
						accountAccess === null ||
						accountAccess.includes(`composio:${connection.id}`)
				)
			: [];
		// A Connect service has no triggers on an agent's own apps (Core
		// answers 501), so none are offered there.
		const own =
			ownAppsAvailable && !composioThroughConnect
				? (ownComposioConnectionsQuery.data?.connections ?? []).filter(
						(connection) =>
							connection.active &&
							(accountAccess === null ||
								accountAccess.includes(`agent-composio:${connection.id}`))
					)
				: [];
		// Name the owner only when the agent may watch both kinds.
		const both = yours.length > 0 && own.length > 0;
		return [
			...yours.map(
				(connection): ComposioAccountOption => ({
					id: connection.id,
					label: labelOf(connection),
					owner: both ? "you" : undefined,
					toolkit: connection.toolkit,
				})
			),
			...own.map(
				(connection): ComposioAccountOption => ({
					id: connection.id,
					label: labelOf(connection),
					owner: "agent",
					toolkit: connection.toolkit,
				})
			),
		];
	}, [
		composioThroughConnect,
		accountAccess,
		composioConnectionsQuery.data,
		identityMode,
		ownAppsAvailable,
		ownComposioConnectionsQuery.data,
	]);

	// ── Composio event-trigger subscriptions for this agent ──────────────────────
	const [triggerSubs, setTriggerSubs] = useState<TriggerSubscription[]>([]);
	const [triggerSlug, setTriggerSlug] = useState("");
	const [connectedAccountId, setConnectedAccountId] = useState("");
	const [subscribing, setSubscribing] = useState(false);
	const [triggerError, setTriggerError] = useState<string | null>(null);

	const toggleComposio = (name: string) => {
		setSelectedComposio((prev) => {
			const next = new Set(prev);
			if (next.has(name)) {
				next.delete(name);
			} else {
				next.add(name);
			}
			return next;
		});
	};

	// "All tools" for the selected connection: bulk-add every action currently
	// listed for the chosen toolkit. Snapshot semantics — tools Composio adds to
	// the toolkit later need a re-select (see the live-wildcard follow-up).
	const selectAllComposio = () => {
		const names = (composioActionsQuery.data ?? []).map((a) => a.name);
		if (names.length === 0) {
			return;
		}
		setSelectedComposio((prev) => {
			const next = new Set(prev);
			for (const name of names) {
				next.add(name);
			}
			return next;
		});
	};

	// Clear just the current toolkit's actions from the selection (leaves other
	// connections' selected actions intact).
	const clearComposioActions = () => {
		const names = new Set((composioActionsQuery.data ?? []).map((a) => a.name));
		setSelectedComposio((prev) => {
			const next = new Set(prev);
			for (const name of names) {
				next.delete(name);
			}
			return next;
		});
	};

	// ── Composio trigger subscriptions: load + subscribe + delete ────────────────
	const loadTriggerSubs = useCallback(async () => {
		if (isNew || !agentId) {
			return;
		}
		try {
			const subs = await fetchTriggerSubscriptions(target);
			setTriggerSubs(subs.filter((s) => s.agentId === agentId));
		} catch {
			// Non-fatal: triggers list is best-effort.
		}
	}, [agentId, isNew, target]);

	useEffect(() => {
		loadTriggerSubs();
	}, [loadTriggerSubs]);

	const handleSubscribeTrigger = async () => {
		if (lifecycleStatus !== "active") {
			setTriggerError("Promote this agent to Active before adding a trigger.");
			return;
		}
		if (
			!(agentId && composioToolkit && triggerSlug && connectedAccountId.trim())
		) {
			setTriggerError(
				"Pick a trigger event and enter the id of the account it should watch."
			);
			return;
		}
		setSubscribing(true);
		setTriggerError(null);
		try {
			const accountId = connectedAccountId.trim();
			await subscribeTrigger(target, {
				agentId,
				toolkit: composioToolkit,
				triggerSlug,
				connectedAccountId: accountId,
				ownAccount:
					composioAccountOptions.find((option) => option.id === accountId)
						?.owner === "agent",
			});
			setTriggerSlug("");
			setConnectedAccountId("");
			await loadTriggerSubs();
		} catch (e) {
			setTriggerError(e instanceof Error ? e.message : "Failed to subscribe");
		} finally {
			setSubscribing(false);
		}
	};

	const handleDeleteTrigger = async (id: string) => {
		try {
			await deleteTriggerSubscription(target, id);
			await loadTriggerSubs();
		} catch {
			// Non-fatal.
		}
	};

	// ── Load available MCP tools ─────────────────────────────────────────────────
	useEffect(() => {
		const load = async () => {
			setToolsLoading(true);
			try {
				const mcpTools = await fetchMcpTools(target);
				const names = mcpTools.map((t) => t.name);
				setAvailableTools(names.length > 0 ? names : FALLBACK_TOOLS);
			} catch {
				setAvailableTools(FALLBACK_TOOLS);
			} finally {
				setToolsLoading(false);
			}
		};
		load();
	}, [target]);

	// ── Load installed skills (for the per-agent allowlist picker) ───────────────
	useEffect(() => {
		const load = async () => {
			setSkillsLoading(true);
			try {
				setAvailableSkills(await listSkills(target));
			} catch {
				setAvailableSkills([]);
			} finally {
				setSkillsLoading(false);
			}
		};
		load();
	}, [target]);

	// A new card starts with every currently available capability selected. An
	// existing empty list is the legacy all-enabled value; explicit subsets and
	// explicit no-capabilities markers remain narrow. Hydrate once per record so
	// a late catalog refresh never overwrites a user's edits.
	useEffect(() => {
		capabilitiesHydratedRef.current = false;
		loadedRecordScope.current = null;
		setExisting(null);
		setHydrated(false);
		setPostureError(null);
	}, [recordScope]);

	useEffect(() => {
		if (
			capabilitiesHydratedRef.current ||
			(!isNew && loadedRecordScope.current !== recordScope) ||
			toolsLoading ||
			skillsLoading ||
			!(isNew || existing)
		) {
			return;
		}
		setSelectedTools(
			hydrateToolSelection(existing?.tools ?? [], availableTools, isNew)
		);
		setSelectedSkills(
			hydrateSkillSelection(existing?.skills ?? [], availableSkills, isNew)
		);
		capabilitiesHydratedRef.current = true;
	}, [
		availableSkills,
		availableTools,
		recordScope,
		existing,
		isNew,
		skillsLoading,
		toolsLoading,
	]);

	// ── Load Spaces (for the Memory / Spaces slot multi-select) ──────────────────
	useEffect(() => {
		const load = async () => {
			try {
				const spaces = await fetchSpaces(target);
				setAvailableSpaces(spaces.map((s) => ({ id: s.id, name: s.name })));
			} catch {
				setAvailableSpaces([]);
			}
		};
		load();
	}, [target]);

	// ── Load agent record for edits ──────────────────────────────────────────────
	const loadRecord = useCallback(
		async (reconcilePosture = false) => {
			if (isNew || !agentId) {
				return;
			}
			const generation = ++recordReadGeneration.current;
			if (reconcilePosture) {
				postureLoadedScope.current = null;
				setPostureError(null);
			}
			setRecordLoading(true);
			setFormError(null);
			try {
				const [record, toolList] = await Promise.all([
					fetchAgent(target, agentId),
					fetchAgentTools(target, agentId).catch(() => null),
				]);
				if (
					!editorMounted.current ||
					activeRecordScope.current !== recordScope ||
					recordReadGeneration.current !== generation
				) {
					return;
				}
				loadedRecordScope.current = recordScope;
				postureLoadedScope.current = recordScope;
				if (reconcilePosture) {
					setPostureError(null);
				}
				setExisting(record);
				setLifecycleStatus(record.lifecycleStatus);
				setSafetyProfile(record.safetyProfile);
				if (record.lifecycleStatus !== "active") {
					setScheduleEnabled(false);
				}
				setAgentToolsData(toolList);
			} catch (e) {
				if (
					!editorMounted.current ||
					activeRecordScope.current !== recordScope ||
					recordReadGeneration.current !== generation
				) {
					return;
				}
				const message = e instanceof Error ? e.message : "Failed to load agent";
				setFormError(message);
				if (reconcilePosture) {
					setPostureError({ scope: recordScope, message, readRetry: true });
				}
			} finally {
				if (
					editorMounted.current &&
					activeRecordScope.current === recordScope &&
					recordReadGeneration.current === generation
				) {
					setRecordLoading(false);
				}
			}
		},
		[agentId, isNew, target, recordScope]
	);

	useEffect(() => {
		loadRecord();
	}, [loadRecord]);

	useEffect(() => {
		const postureResource = postureResourceFor(target, effectiveAgentId);
		if (!postureResource) {
			posturePendingScope.current = null;
			setPostureSaving(false);
			return;
		}
		let observedPending = false;
		const current = () =>
			editorMounted.current && activeRecordScope.current === recordScope;
		const observe = () => {
			if (!current()) {
				return;
			}
			const pending = Boolean(postureResource.pending);
			if (observedPending && !pending) {
				observedPending = false;
				if (postureResource.settledScope === recordScope) {
					posturePendingScope.current = null;
					setPostureSaving(false);
					return;
				}
				posturePendingScope.current = recordScope;
				setPostureSaving(true);
				// A retired owner may have changed the physical record. Read with
				// this editor's current authority before enabling another write.
				void loadRecord(true).finally(() => {
					if (current() && !postureResource.pending) {
						posturePendingScope.current = null;
						setPostureSaving(false);
					}
				});
				return;
			}
			observedPending = pending;
			posturePendingScope.current = pending ? recordScope : null;
			setPostureSaving(pending);
		};
		postureResource.listeners.add(observe);
		observe();
		return () => {
			postureResource.listeners.delete(observe);
			releasePostureResource(postureResource);
		};
	}, [loadRecord, target, effectiveAgentId, recordScope]);

	const retryPostureRead = useCallback(async () => {
		const postureResource = postureEndpoint
			? agentPostureResources.get(postureEndpoint)
			: null;
		const current = () =>
			editorMounted.current && activeRecordScope.current === recordScope;
		if (
			!current() ||
			postureResource?.pending ||
			posturePendingScope.current === recordScope
		) {
			return;
		}
		posturePendingScope.current = recordScope;
		setPostureSaving(true);
		await loadRecord(true);
		if (current() && !postureResource?.pending) {
			posturePendingScope.current = null;
			setPostureSaving(false);
		}
	}, [loadRecord, postureEndpoint, recordScope]);

	// An applied optimization changed the saved record (model or tools) behind
	// the form. Re-hydrate from the server so a later Save cannot write the
	// stale values back over it.
	const reloadAfterOptimization = useCallback(async () => {
		// Clear the capability latch first: its effect re-runs when the new record
		// lands. The form latch is cleared after, so it re-hydrates from that record.
		capabilitiesHydratedRef.current = false;
		await loadRecord();
		setHydrated(false);
		await reload();
	}, [loadRecord, reload]);

	// ── Hydrate form from loaded record ──────────────────────────────────────────
	// legacy component
	useEffect(() => {
		if (
			hydrated ||
			loading ||
			(!isNew && loadedRecordScope.current !== recordScope)
		) {
			return;
		}
		if (existing) {
			setName(existing.name);
			setLifecycleStatus(existing.lifecycleStatus);
			setSafetyProfile(existing.safetyProfile);
			setAgentTitle(existing.title ?? "");
			setDescription(existing.description ?? "");
			// Split the stored prompt back into free-form instructions + the
			// structured rules list (round-trips the fenced rules block).
			const { instructions, rules: parsedRules } = parseRules(
				existing.systemPrompt ?? ""
			);
			setSystemPrompt(instructions);
			setRules(parsedRules);
			// A custom BYO ACP agent stores its command as `acp-exec:<cmd>`: route
			// the picker to the sentinel and surface the command in the text box.
			if (existing.engine?.startsWith(ACP_EXEC_PREFIX)) {
				setChatModel(ACP_CUSTOM_ENGINE);
				setAcpCommand(existing.engine.slice(ACP_EXEC_PREFIX.length));
			} else {
				setChatModel(existing.engine ?? "");
			}
			setAgentModel(existing.chatModel?.modelId ?? existing.model ?? "");
			setAgentModelEngine(existing.chatModel?.engine ?? null);
			setSelectedComposio(new Set(existing.composioActions ?? []));
			setSelectedIdentities(new Set(existing.identityProfileIds ?? []));
			setIdentityMode(existing.identityMode);
			setAccountAccess(existing.accountAccess);
			// Memory / Spaces slot round-trips from the record. Empty read_levels
			// stays empty here (the "all personal levels" default is applied by Core).
			setMemorySpaceIds(new Set(existing.memory?.space_ids ?? []));
			setMemoryReadLevels(new Set(existing.memory?.read_levels ?? []));
			setMemoryWriteEnabled(existing.memory?.write_enabled ?? false);
			setSampling(existing.inference ?? {});
			// null = "use default": orchestrator on, creation off.
			setOrchestrator(existing.orchestrator ?? true);
			setCanCreateAgents(existing.canCreateAgents ?? false);
			// Persona (display name + tone) round-trips from the saved record so
			// reopening an agent shows the saved values instead of blank defaults
			// (and a subsequent save no longer overwrites them with defaults).
			const persona = existing.persona;
			setPersonaDisplayName(persona?.display_name ?? "");
			setAvatarGlyph(personaToGlyphValue(persona));
			setPersonalityProfileId(
				persona?.output_style_id?.trim() || AGENT_OWN_VOICE_PROFILE
			);
			const savedTone = persona?.tone ?? null;
			const presetTone = savedTone
				? TONE_OPTIONS.find(
						(o) =>
							o.value === savedTone &&
							o.value !== "custom" &&
							o.value !== "neutral"
					)
				: undefined;
			if (presetTone) {
				setTone(presetTone.value);
				setCustomTone("");
			} else if (savedTone) {
				setTone("custom");
				setCustomTone(savedTone);
			} else {
				setTone("neutral");
				setCustomTone("");
			}
			setHydrated(true);
		} else if (isNew) {
			if (installedAgentEngineOptions.length > 0) {
				setChatModel(installedAgentEngineOptions[0].id);
			}
			setHydrated(true);
		}
	}, [
		existing,
		isNew,
		installedAgentEngineOptions,
		loading,
		hydrated,
		recordScope,
	]);

	const isBuiltIn = existing?.builtIn ?? false;
	const isLocked = existing?.locked ?? false;
	// Composio now works on ACP-bound agents too (#477): the MCP bridge surfaces
	// the selected Composio actions on the ACP plane and routes their execution
	// through Core's registry, so there is no longer a gateway-only restriction.

	// ── Toggle a tool in the checklist ───────────────────────────────────────────
	const toggleTool = (toolName: string) => {
		setSelectedTools((prev) => {
			const next = new Set(prev);
			if (next.has(toolName)) {
				next.delete(toolName);
			} else {
				next.add(toolName);
			}
			return next;
		});
	};

	// ── Toggle a skill in the per-agent allowlist ────────────────────────────────
	const toggleSkill = (skillId: string) => {
		setSelectedSkills((prev) => {
			const next = new Set(prev);
			if (next.has(skillId)) {
				next.delete(skillId);
			} else {
				next.add(skillId);
			}
			return next;
		});
	};

	const savedTools = useMemo(
		() => encodeToolAllowlist(availableTools, selectedTools),
		[availableTools, selectedTools]
	);
	const savedSkills = useMemo(
		() => encodeSkillAllowlist(availableSkills, selectedSkills),
		[availableSkills, selectedSkills]
	);

	// ── Toggle an Identity Vault profile binding ─────────────────────────────────
	const toggleIdentity = (profileId: string) => {
		setSelectedIdentities((prev) => {
			const next = new Set(prev);
			if (next.has(profileId)) {
				next.delete(profileId);
			} else {
				next.add(profileId);
			}
			return next;
		});
	};

	// ── Toggle a readable Space in the Memory slot ───────────────────────────────
	const toggleMemorySpace = (spaceId: string) => {
		setMemorySpaceIds((prev) => {
			const next = new Set(prev);
			if (next.has(spaceId)) {
				next.delete(spaceId);
			} else {
				next.add(spaceId);
			}
			return next;
		});
	};

	// ── Toggle a memory access level (agent/user/node/project/org) ───────────────
	const toggleMemoryReadLevel = (level: string) => {
		setMemoryReadLevels((prev) => {
			const next = new Set(prev);
			if (next.has(level)) {
				next.delete(level);
			} else {
				next.add(level);
			}
			return next;
		});
	};

	// ── Save handler ─────────────────────────────────────────────────────────────
	// legacy component
	const handleSave = async () => {
		if (!editorMounted.current || activeRecordScope.current !== recordScope) {
			return;
		}
		if (
			(postureEndpoint &&
				agentPostureResources.get(postureEndpoint)?.pending) ||
			posturePendingScope.current === recordScope ||
			(!isNew && postureLoadedScope.current !== recordScope)
		) {
			return;
		}
		if (!name.trim()) {
			setFormError("Name is required");
			return;
		}
		if (!chatModel) {
			setFormError("Select a chat model");
			return;
		}
		if (chatModel === ACP_CUSTOM_ENGINE && !acpCommand.trim()) {
			setFormError(
				"Enter the command that starts your agent (for example, goose acp)."
			);
			return;
		}
		if (selectedUninstalledAgent) {
			setFormError("Install this agent before selecting it here.");
			return;
		}
		if (isLocked) {
			setFormError("This agent is locked. Unlock it before saving changes.");
			return;
		}
		// Instructions, name, tone, output style and skills are all part of the
		// system prompt Core assembles for this bot, so changing any of them on a
		// saved bot is a one-time prompt-cache miss for each of its threads. Ask
		// first; `promptEditConfirmed` carries the user's "Apply now" back in.
		if (existing && !promptEditConfirmed.current) {
			const warning = promptEditCacheWarning(
				promptLayerChanges(existing, {
					displayName: personaDisplayName,
					outputStyleId:
						personalityProfileId === AGENT_OWN_VOICE_PROFILE
							? null
							: personalityProfileId.trim() || null,
					skills: savedSkills,
					systemPrompt:
						(agentEditPanels.length > 0
							? systemPrompt.trim()
							: composeRules(systemPrompt, rules).trim()) || null,
					tone: (() => {
						const value =
							tone === "custom" ? customTone.trim() || "neutral" : tone;
						return value === "neutral" ? null : value;
					})(),
				}),
				"bot"
			);
			if (warning) {
				setPromptEditConfirmation(warning);
				return;
			}
		}
		promptEditConfirmed.current = false;
		const current = () =>
			editorMounted.current && activeRecordScope.current === recordScope;
		const fullResource = postureResourceFor(target, effectiveAgentId);
		let releaseFull = () => {};
		const fullPending = new Promise<void>((resolve) => {
			releaseFull = resolve;
		});
		if (fullResource) {
			// Full AgentInput carries safety_profile, so it owns the same node barrier.
			fullResource.pending = fullPending;
			++recordReadGeneration.current;
			for (const listener of fullResource.listeners) {
				listener();
			}
		}
		setSavingScope(recordScope);
		setFormError(null);

		const nextVersion = existing?.version
			? bumpPatchVersion(existing.version)
			: undefined;

		// Build persona tone value: use custom text when "custom" is selected.
		const toneValue = tone === "custom" ? customTone.trim() || "neutral" : tone;

		const input = {
			name: name.trim(),
			title: agentTitle.trim(),
			description: description.trim() || null,
			model: agentModel.trim() || null,
			chatModel: {
				engine: agentModelEngine,
				modelId: agentModel.trim() || null,
			},
			// An enabled Rules contribution persists rules in its own Ryu preference.
			// If the plugin is disabled/unavailable, retain the legacy prompt block so
			// opening and saving an agent can never silently discard existing rules.
			systemPrompt:
				(agentEditPanels.length > 0
					? systemPrompt.trim()
					: composeRules(systemPrompt, rules).trim()) || null,
			engine:
				chatModel === ACP_CUSTOM_ENGINE
					? `${ACP_EXEC_PREFIX}${acpCommand.trim()}`
					: chatModel,
			tools: savedTools,
			composioActions: Array.from(selectedComposio),
			skills: savedSkills,
			identityProfileIds: Array.from(selectedIdentities),
			identityMode,
			// `null` is sent as-is: it is how an unrestricted agent stays unrestricted.
			accountAccess,
			version: nextVersion,
			// Persona fields — passed through; Core stores them when the field exists.
			// The three avatar sources are mutually exclusive: only the active one
			// is non-null (the field clears the others when a new source is picked).
			persona: {
				display_name: personaDisplayName.trim() || null,
				output_style_id:
					personalityProfileId === AGENT_OWN_VOICE_PROFILE
						? null
						: personalityProfileId.trim() || null,
				tone: toneValue === "neutral" ? null : toneValue,
				...glyphToPersonaFields(avatarGlyph),
			},
			// Advanced sampling defaults — passed through to Core's agent record.
			inference: sampling,
			// Orchestration capabilities (delegation/discovery + agent creation).
			orchestrator,
			canCreateAgents,
			safetyProfile,
			// Memory / Spaces slot. Empty read_levels means "all personal levels"
			// (Core's back-compat default), so we send the raw selection as-is.
			memory: {
				space_ids: Array.from(memorySpaceIds),
				read_levels: Array.from(memoryReadLevels),
				write_enabled: memoryWriteEnabled,
			},
		};

		// A new agent edits a lazily-created draft once the builder chat (or save)
		// has minted one; otherwise it creates fresh on save.
		const targetId = isNew ? draftId : agentId;

		try {
			let savedId: string;
			if (targetId) {
				const updated = await update(targetId, input);
				if (!current()) {
					return;
				}
				savedId = updated.id;
				// The save response carries no app identity: keep the request the
				// user has not settled, and clear it once this save accepted it.
				const pendingMode = existing?.appIdentity?.pendingMode ?? null;
				setExisting({
					...updated,
					appIdentity:
						existing?.appIdentity && pendingMode !== null
							? {
									appMode:
										identityMode === pendingMode
											? pendingMode
											: existing.appIdentity.appMode,
									pendingMode:
										identityMode === pendingMode ? null : pendingMode,
								}
							: existing?.appIdentity,
				});
			} else {
				const created = await create(input);
				if (!current()) {
					return;
				}
				savedId = created.id;
				setDraftId(savedId);
				setExisting(created);
			}

			// The API intentionally creates every custom agent in Trial. A new
			// editor may explicitly save as Draft, but it can never skip the Trial
			// checkpoint to become Active in one step.
			if (lifecycleStatus === "draft") {
				const drafted = await updateAgentPosture(target, savedId, {
					lifecycleStatus: "draft",
					safetyProfile,
				});
				if (!current()) {
					return;
				}
				setExisting(drafted);
			} else if (lifecycleStatus === "trial" && existing === null) {
				setLifecycleStatus("trial");
			}

			// A brand-new editor has no id while it is being filled, so its
			// contribution panel cannot persist yet. Write the migrated/default
			// config immediately after creation and keep the editor open if that
			// preference write fails rather than silently dropping its rules.
			if (!targetId && agentEditPanels.length > 0) {
				const ruleWrites = await Promise.all(
					agentEditPanels.map((panel) =>
						saveAgentRulesConfig(
							target,
							`${panel.pref_key_prefix ?? "agent-rules:"}${encodeURIComponent(savedId)}`,
							legacyRulesToConfig(rules)
						)
					)
				);
				if (!current()) {
					return;
				}
				if (ruleWrites.some((ok) => !ok)) {
					setFormError(
						"Agent created, but its rules could not be saved. Check the node and try again."
					);
					return;
				}
			}

			// Scheduling an agent is modelled as a 1-node workflow (the standalone
			// Automations page was merged into Workflows). Best-effort and non-fatal
			// so a scheduling failure never blocks the agent save.
			if (scheduleEnabled && savedId) {
				const schedule = phraseToSchedule(
					schedulePhrase,
					dailyTime,
					weeklyDay,
					weeklyTime,
					customCron
				);
				try {
					await createScheduledAgentWorkflow(target, {
						agentId: savedId,
						agentName: name.trim(),
						schedule,
					});
				} catch {
					// Non-fatal: a scheduling failure should not block the agent save.
				}
			}

			if (!current()) {
				return;
			}
			if (
				isNew &&
				lifecycleStatus !== "draft" &&
				!newAgentChatOpenedRef.current
			) {
				newAgentChatOpenedRef.current = true;
				localStorage.setItem("ryu_default_agent", savedId);
				openTab("/chat", buildNewAgentChatSeed(savedId, name.trim()));
			} else {
				goBack();
			}
		} catch (e) {
			if (current()) {
				setFormError(e instanceof Error ? e.message : "Failed to save agent");
			}
		} finally {
			setSavingScope((scope) => (scope === recordScope ? null : scope));
			if (fullResource?.pending === fullPending) {
				fullResource.settledScope = current() ? recordScope : null;
				fullResource.pending = null;
			}
			releaseFull();
			if (fullResource) {
				for (const listener of fullResource.listeners) {
					listener();
				}
				releasePostureResource(fullResource);
			}
		}
	};

	// Publish is offered only for a saved, custom agent (built-ins are Ryu's; a
	// brand-new unsaved agent has no record to package yet).
	const canPublish = !(isNew || isBuiltIn || simpleEditor) && Boolean(agentId);

	// The id the builder chat edits: the existing agent, or a draft (lazily
	// created on first builder message for brand-new agents).
	const savePosture = useCallback(
		async (posture: {
			lifecycleStatus?: AgentLifecycleStatus;
			safetyProfile?: AgentSafetyProfile;
		}) => {
			const current = () =>
				editorMounted.current && activeRecordScope.current === recordScope;
			if (
				!current() ||
				(!isNew && postureLoadedScope.current !== recordScope)
			) {
				return;
			}
			if (!effectiveAgentId) {
				// New unsaved agents have a local draft; saved agents retain their
				// acknowledged posture until the node accepts the sparse write.
				if (posture.lifecycleStatus !== undefined) {
					setLifecycleStatus(posture.lifecycleStatus);
					if (posture.lifecycleStatus !== "active") {
						setScheduleEnabled(false);
					}
				}
				if (posture.safetyProfile !== undefined) {
					setSafetyProfile(posture.safetyProfile);
				}
				setPostureError(null);
				return;
			}
			const postureResource = postureResourceFor(target, effectiveAgentId);
			if (
				!postureResource ||
				postureResource.pending ||
				posturePendingScope.current === recordScope
			) {
				return;
			}
			let release = () => {};
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			postureResource.pending = pending;
			posturePendingScope.current = recordScope;
			++recordReadGeneration.current;
			setPostureSaving(true);
			setPostureError(null);
			for (const listener of postureResource.listeners) {
				listener();
			}
			try {
				const updated = await updateAgentPosture(
					target,
					effectiveAgentId,
					posture
				);
				if (!current()) {
					return;
				}
				setExisting(updated);
				setLifecycleStatus(updated.lifecycleStatus);
				setSafetyProfile(updated.safetyProfile);
				if (updated.lifecycleStatus !== "active") {
					setScheduleEnabled(false);
				}
				await reload();
			} catch (error) {
				if (!current()) {
					return;
				}
				setPostureError({
					scope: recordScope,
					message:
						error instanceof Error
							? error.message
							: "Could not update lifecycle",
					readRetry: false,
				});
			} finally {
				if (current()) {
					posturePendingScope.current = null;
					setPostureSaving(false);
				}
				if (postureResource.pending === pending) {
					postureResource.settledScope = current() ? recordScope : null;
					postureResource.pending = null;
				}
				release();
				for (const listener of postureResource.listeners) {
					listener();
				}
				releasePostureResource(postureResource);
			}
		},
		[effectiveAgentId, isNew, recordScope, reload, target]
	);

	// Lazily ensure a real record exists so the builder chat has something to
	// patch. Returns null if we can't (e.g. no engine picked yet).
	const resolveAgentId = useCallback(async (): Promise<string | null> => {
		if (!isNew && agentId) {
			return agentId;
		}
		if (draftId) {
			return draftId;
		}
		if (!chatModel) {
			setFormError("Pick a chat model before building with the assistant.");
			return null;
		}
		if (selectedUninstalledAgent) {
			setFormError("Install this agent before selecting it here.");
			return null;
		}
		try {
			const created = await create({
				name: name.trim() || "Untitled agent",
				title: agentTitle.trim(),
				description: description.trim() || null,
				model: agentModel.trim() || null,
				chatModel: {
					engine: agentModelEngine,
					modelId: agentModel.trim() || null,
				},
				systemPrompt: null,
				engine:
					chatModel === ACP_CUSTOM_ENGINE
						? `${ACP_EXEC_PREFIX}${acpCommand.trim()}`
						: chatModel,
				tools: savedTools,
				composioActions: Array.from(selectedComposio),
				skills: savedSkills,
				identityProfileIds: Array.from(selectedIdentities),
				identityMode,
				accountAccess,
				persona: {
					display_name: personaDisplayName.trim() || null,
					output_style_id:
						personalityProfileId === AGENT_OWN_VOICE_PROFILE
							? null
							: personalityProfileId.trim() || null,
					tone:
						tone === "custom"
							? customTone.trim() || null
							: tone === "neutral"
								? null
								: tone,
					...glyphToPersonaFields(avatarGlyph),
				},
				orchestrator,
				canCreateAgents,
				safetyProfile,
			});
			setDraftId(created.id);
			setExisting(created);
			return created.id;
		} catch (e) {
			setFormError(
				e instanceof Error ? e.message : "Could not create a draft agent"
			);
			return null;
		}
	}, [
		isNew,
		agentId,
		draftId,
		chatModel,
		agentModel,
		agentModelEngine,
		acpCommand,
		name,
		agentTitle,
		description,
		savedTools,
		selectedComposio,
		savedSkills,
		selectedIdentities,
		identityMode,
		accountAccess,
		personaDisplayName,
		personalityProfileId,
		tone,
		customTone,
		avatarGlyph,
		orchestrator,
		canCreateAgents,
		safetyProfile,
		selectedUninstalledAgent,
		create,
	]);

	// After the builder applies an edit, reload the record and re-hydrate the
	// config panel so the change shows on the right immediately.
	const onAgentChanged = useCallback(
		async (id: string) => {
			try {
				const rec = await fetchAgent(target, id);
				setExisting(rec);
				capabilitiesHydratedRef.current = false;
				setHydrated(false);
			} catch {
				// Non-fatal: the next save/load reconciles.
			}
		},
		[target]
	);

	// Complete agent-definition history. Prompt Studio owns prompt-only snapshots;
	// this source covers the persisted agent record so model, capabilities, safety,
	// persona, and instructions can be compared and restored together.
	const agentVersionSource = useMemo<VersionSource<
		Awaited<ReturnType<typeof restoreAgentVersion>>,
		Awaited<ReturnType<typeof createAgentVersion>>
	> | null>(() => {
		if (isNew || !agentId) {
			return null;
		}
		return {
			scope: recordScope,
			getValue: (versionId) =>
				getAgentVersionSource(target, agentId, versionId),
			list: async () =>
				(await listAgentVersions(target, agentId)).map((version) => ({
					createdAt: version.createdAt,
					id: version.id,
					label: version.label,
					title: `${version.name} · v${version.version}`,
				})),
			restore: (versionId) => restoreAgentVersion(target, agentId, versionId),
			snapshot: (label) => createAgentVersion(target, agentId, label),
		};
	}, [agentId, isNew, target, recordScope]);

	const handleAgentVersionRestored = useCallback(async () => {
		if (!agentId) {
			return;
		}
		try {
			if (!editorMounted.current || activeRecordScope.current !== recordScope) {
				return;
			}
			const restored = await fetchAgent(target, agentId);
			if (!editorMounted.current || activeRecordScope.current !== recordScope) {
				return;
			}
			loadedRecordScope.current = recordScope;
			setExisting(restored);
			capabilitiesHydratedRef.current = false;
			setHydrated(false);
			setFormError(null);
		} catch (error) {
			if (!editorMounted.current || activeRecordScope.current !== recordScope) {
				return;
			}
			setFormError(
				error instanceof Error
					? `Version restored, but the editor could not reload: ${error.message}`
					: "Version restored, but the editor could not reload"
			);
		}
	}, [agentId, target, recordScope]);

	const currentAgentVersionValue =
		existing?.source ??
		(existing
			? JSON.stringify({ ...existing, source: undefined }, null, 2)
			: "");

	// Compact snapshot of the current config, fed to the builder's preamble.
	const agentSnapshot = useMemo(
		() =>
			JSON.stringify({
				id: effectiveAgentId,
				name: name.trim(),
				title: agentTitle.trim(),
				description: description.trim(),
				engine: chatModel,
				model: agentModel,
				modelEngine: agentModelEngine,
				tools: savedTools,
				skills: savedSkills,
				composioActions: Array.from(selectedComposio),
				identityMode,
				tone,
				personalityProfile:
					personalityProfileId === AGENT_OWN_VOICE_PROFILE
						? null
						: personalityProfileId,
			}),
		[
			effectiveAgentId,
			name,
			agentTitle,
			description,
			chatModel,
			agentModel,
			agentModelEngine,
			savedTools,
			savedSkills,
			selectedComposio,
			identityMode,
			tone,
			personalityProfileId,
		]
	);

	// Page header lives in the shared TitleBar (no in-page header bar). Title = the
	// agent's identity; the config surfaces (Prompt Studio / Evals / Calendar /
	// Integrations) are
	// tabs inside the settings form, so the title bar carries no view toggle.
	const titleBarTitle = useMemo(
		() => (
			<span className="flex min-w-0 items-center gap-2">
				<span className="truncate font-medium">
					{isNew ? "New agent" : name.trim() || "Edit agent"}
				</span>
				<Badge
					className="shrink-0"
					variant={lifecycleStatus === "active" ? "secondary" : "outline"}
				>
					{lifecycleStatus === "draft"
						? "Draft"
						: lifecycleStatus === "trial"
							? "Trial"
							: "Active"}
				</Badge>
				{/* The shared status glyph, not a second LockedIcon badge: the "Locked"
				    chip on the very next line already wears that mark, and two identical
				    padlocks side by side said nothing about which was which. */}
				{isBuiltIn ? <StatusBadge kind="builtin" /> : null}
				{isLocked && !isBuiltIn ? (
					<Badge variant="secondary">
						<HugeiconsIcon className="size-3" icon={LockedIcon} />
						Locked
					</Badge>
				) : null}
			</span>
		),
		[isBuiltIn, isLocked, isNew, lifecycleStatus, name]
	);

	useTitleBar(titleBarTitle);

	// Hand the docked Ask Ryu panel over to the agent builder while this page is
	// focused: it drives the `agent_builder.*` tools (with the allow/deny
	// permission prompt) and refreshes the config form after each change. This
	// replaced the old inline builder chat pane — the left rail now shows the badge.
	useAssistantBuilder({
		kind: "agent",
		onChanged: (id) => onAgentChanged(id),
		resolveId: resolveAgentId,
		snapshot: agentSnapshot,
		targetId: effectiveAgentId,
		targetName: name,
	});

	// Merge MCP tools from the loaded agent record with the available tools list
	// so tools already on the agent show up even if the MCP endpoint returned empty.
	const mcpToolNames = agentToolsData?.mcp.map((t) => t.name) ?? [];
	const mergedTools = Array.from(
		new Set([...availableTools, ...mcpToolNames, ...(existing?.tools ?? [])])
	);

	// Live-preview derivations — kept side-effect-free so the card mirrors the form.
	const modelLabel =
		installedAgentEngineOptions.find((e) => e.id === chatModel)?.label ??
		(chatModel || null);
	const toneLabelValue = toneLabel(tone, customTone);
	const scheduleSummaryValue = scheduleSummary(
		scheduleEnabled,
		schedulePhrase,
		dailyTime,
		weeklyDay,
		weeklyTime
	);
	const selectedToolsList = Array.from(selectedTools);
	const enabledSkillCount = availableSkills.filter(
		(skill) => skill.enabled
	).length;
	const runtimeStatus: AgentHealthInput["runtime"]["status"] = chatModel
		? selectedUninstalledAgent
			? "unavailable"
			: chatModel === ACP_CUSTOM_ENGINE
				? acpCommand.trim()
					? "custom"
					: "missing"
				: "ready"
		: "missing";
	// Event triggers whose events Core would skip under the identity and
	// account access on screen (the same check it makes on every event). Each
	// is marked paused; the ones that fire today are counted in the warning.
	const pausedTriggers = new Set(
		pausedTriggerIds(identityMode, accountAccess, triggerSubs)
	);
	const savedPausedTriggers = existing
		? new Set(
				pausedTriggerIds(
					existing.identityMode,
					existing.accountAccess,
					triggerSubs
				)
			)
		: pausedTriggers;
	const stoppingTriggerCount = [...pausedTriggers].filter(
		(id) => !savedPausedTriggers.has(id)
	).length;
	const triggerRows = triggerSubs.map((sub) => ({
		...sub,
		paused: pausedTriggers.has(sub.id),
	}));
	// Shown under the Identity cards when the chosen mode switches off accounts
	// that are selected right now, or stops triggers that fire today. The
	// selection is kept for switching back.
	// A mode a newer version of this app's agent asked for. Core keeps the saved
	// mode until the user accepts it (by saving the agent with it) or dismisses it.
	const pendingIdentityMode = existing?.appIdentity?.pendingMode ?? null;
	const keepCurrentIdentityMode = async () => {
		if (!(agentId && existing) || dismissingPendingMode) {
			return;
		}
		const recordScope = activeRecordScope.current;
		setDismissingPendingMode(true);
		try {
			await updateAgentAccountSettings(target, agentId, {
				dismissPendingIdentityMode: true,
			});
			if (editorMounted.current && activeRecordScope.current === recordScope) {
				setIdentityMode(existing.identityMode);
				setExisting((previous) =>
					previous?.appIdentity
						? {
								...previous,
								appIdentity: {
									appMode:
										previous.appIdentity.pendingMode ??
										previous.appIdentity.appMode,
									pendingMode: null,
								},
							}
						: previous
				);
			}
		} catch {
			if (editorMounted.current) {
				setFormError("Couldn't dismiss the identity request. Try again.");
			}
		} finally {
			if (editorMounted.current) {
				setDismissingPendingMode(false);
			}
		}
	};
	const identityModeWarning = identityModeAccountWarning(
		identityMode,
		accountAccess,
		selectedIdentities.size,
		stoppingTriggerCount
	);
	// The engine as it would be saved, and Core's answer for whether it starts
	// under the identity and account access on screen (`useAgentLaunchCheck`).
	const launchEngine =
		chatModel === ACP_CUSTOM_ENGINE
			? `${ACP_EXEC_PREFIX}${acpCommand.trim()}`
			: chatModel || null;
	const launch = useAgentLaunchCheck({
		accountAccess,
		agentId: effectiveAgentId,
		engine: launchEngine,
		identityMode,
	});
	// A remote A2A peer runs on another node under that node's accounts, so the
	// editor shows a note instead of the identity choice and account access, and
	// saves the record's identity and access unchanged.
	const remotePeer = isRemotePeerEngine(launchEngine);
	const agentConfined = agentIsConfined(identityMode, accountAccess);
	// Core's refusal for a limited agent, when its engine won't start.
	const limitedLaunchRefusal = agentConfined
		? (launch.check?.reason ?? null)
		: null;
	// Shown in the Codex and custom-agent routing settings of a limited agent:
	// those switches decide whether its engine may start at all. Claude Code's
	// switch does not (it always calls Anthropic itself), so its settings show
	// only Core's refusal.
	const limitedRoutingNotice = agentConfined
		? (limitedLaunchRefusal ??
			"This agent's account access is limited, so this routing decides whether its engine may start. Ryu checks again before every start.")
		: null;
	const agentHealthInput = useMemo<AgentHealthInput>(
		() => ({
			access: {
				composioActionCount: selectedComposio.size,
				highImpactCount:
					selectedToolsList.filter(isHighImpactTool).length +
					selectedComposio.size +
					selectedIdentities.size +
					(memoryWriteEnabled ? 1 : 0),
				identityProfileCount: selectedIdentities.size,
			},
			automation: {
				scheduleEnabled,
				triggerCount: triggerSubs.length,
			},
			description,
			instructions: systemPrompt,
			lifecycleStatus,
			memoryWriteEnabled,
			model: {
				configured: Boolean(agentModel.trim()),
				required: chatModel !== ACP_CUSTOM_ENGINE,
			},
			name,
			runtime: {
				label: modelLabel,
				status: runtimeStatus,
			},
			safetyProfile,
			skills: {
				allSelected:
					enabledSkillCount > 0 &&
					selectedSkills.size === enabledSkillCount &&
					availableSkills
						.filter((skill) => skill.enabled)
						.every((skill) => selectedSkills.has(skill.id)),
				availableCount: enabledSkillCount,
				loaded: !skillsLoading,
				selectedCount: selectedSkills.size,
			},
			tools: {
				allSelected:
					availableTools.length > 0 &&
					selectedTools.size === availableTools.length &&
					availableTools.every((tool) => selectedTools.has(tool)),
				availableCount: availableTools.length,
				loaded: !toolsLoading,
				selectedCount: selectedTools.size,
			},
		}),
		[
			agentModel,
			availableSkills,
			availableTools,
			chatModel,
			description,
			enabledSkillCount,
			lifecycleStatus,
			memoryWriteEnabled,
			modelLabel,
			name,
			runtimeStatus,
			safetyProfile,
			selectedComposio,
			selectedIdentities,
			selectedSkills,
			selectedTools,
			selectedToolsList,
			scheduleEnabled,
			skillsLoading,
			systemPrompt,
			toolsLoading,
			triggerSubs.length,
		]
	);
	const agentHealthScorecard = useMemo(
		() => runAgentScorecard(agentHealthInput),
		[agentHealthInput]
	);

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
					accountAccessPanel={
						remotePeer ? null : (
							<AgentAccountAccessPanel
								accountAccess={accountAccess}
								agentId={effectiveAgentId}
								disabled={isLocked}
								engine={launchEngine}
								identityMode={identityMode}
								launchNoticesShownElsewhere={simpleEditor}
								onAccountAccessChange={setAccountAccess}
								onToggleIdentity={toggleIdentity}
								savedIdentityMode={savedIdentityMode}
								selectedIdentities={selectedIdentities}
							/>
						)
					}
					acpCommand={acpCommand}
					acpSessionPanel={
						!isNew && effectiveAgentId ? (
							<AcpSessionControls agentId={effectiveAgentId} />
						) : null
					}
					advancedInference={
						<SettingsSection caption="Engine launch options and sampling defaults apply across agents.">
							<p className="text-muted-foreground text-sm leading-relaxed">
								Choose Store → Engines, select the runtime, then edit its
								Advanced configuration. Request-level overrides remain available
								to the chat caller.
							</p>
						</SettingsSection>
					}
					agentIcon={
						<AgentImageField
							disabled={isLocked}
							fallback={<AgentLogo engine={chatModel} size="24px" />}
							onChange={setAvatarGlyph}
							value={avatarGlyph}
						/>
					}
					agentSetupComposer={
						<AgentSetupComposer
							agents={agents}
							disabled={isLocked}
							engine={chatModel}
							engineNote={
								launch.check?.runsOnManagedPi ? MANAGED_PI_NOTE : null
							}
							identityMode={identityMode}
							instructions={systemPrompt}
							model={agentModel}
							modelEngine={agentModelEngine}
							onEngineChange={setChatModel}
							onInstructionsChange={setSystemPrompt}
							onModelChange={setAgentModel}
							onModelEngineChange={setAgentModelEngine}
						/>
					}
					agentTitle={agentTitle}
					bannerAgentId={effectiveAgentId ?? undefined}
					bannerPreferenceStore={
						effectiveAgentId ? agentBannerPreferenceStore : undefined
					}
					budgetPanel={
						!isNew && effectiveAgentId ? (
							<AgentBudgetPanel
								agentId={effectiveAgentId}
								disabled={isLocked}
							/>
						) : null
					}
					calendarPanel={
						isNew || !agentId ? null : <AgentCalendarView agentId={agentId} />
					}
					capabilitiesPanel={
						<>
							{effectiveAgentId ? (
								<AgentCapabilitiesPanel
									agentId={effectiveAgentId}
									disabled={isLocked}
								/>
							) : null}
							{!isNew && effectiveAgentId && effectiveAgentId !== "ryu" ? (
								<AcpAgentSettingsPanel
									agentId={effectiveAgentId}
									disabled={isLocked}
									limitedOnManagedPi={launch.check?.runsOnManagedPi ?? false}
								/>
							) : null}
							<OrchestrationPanel
								canCreateAgents={canCreateAgents}
								disabled={isLocked}
								onChangeCanCreateAgents={setCanCreateAgents}
								onChangeOrchestrator={setOrchestrator}
								orchestrator={orchestrator}
							/>
						</>
					}
					channelsPanel={
						<>
							<AgentChannelsSection agentId={effectiveAgentId} />
							<AgentEmailAliasSection
								agentId={isNew ? null : effectiveAgentId}
							/>
						</>
					}
					chatModel={chatModel}
					chatSlotDisabled={
						isLocked || (isBuiltIn && installedAgentEngineOptions.length === 0)
					}
					claudeConfig={
						agentId === "acp:claude" ? (
							<ClaudeGatewayConfig limitedNotice={limitedLaunchRefusal} />
						) : null
					}
					codexConfig={
						agentId === "acp:codex" ? (
							<CodexGatewayConfig limitedNotice={limitedRoutingNotice} />
						) : null
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
					employeeBadge={
						<AgentLanyardCard
							builtIn={isBuiltIn}
							description={description}
							engine={chatModel}
							name={name}
							node={activeNode.name}
							role={modelLabel}
							version={existing?.version ?? "1.0.0"}
						/>
					}
					engineOptions={engineOptions}
					evalsPanel={
						isNew ? null : (
							<AgentEvalsView
								agentId={agentId ?? null}
								defaultModel={agentModel}
								target={target}
							/>
						)
					}
					executionPolicyPanel={
						<AgentExecutionPolicyPanel
							disabled={
								isLocked ||
								(!isNew && postureLoadedScope.current !== recordScope)
							}
							isNew={isNew}
							lifecycleStatus={lifecycleStatus}
							onLifecycleStatusChange={(status) =>
								savePosture({ lifecycleStatus: status })
							}
							onPostureRetry={
								postureError?.scope === recordScope && postureError.readRetry
									? retryPostureRead
									: undefined
							}
							onSafetyProfileChange={(profile) =>
								savePosture({ safetyProfile: profile })
							}
							postureError={
								postureError?.scope === recordScope
									? postureError.message
									: null
							}
							postureSaving={
								Boolean(
									postureEndpoint &&
										agentPostureResources.get(postureEndpoint)?.pending
								) ||
								(postureSaving && posturePendingScope.current === recordScope)
							}
							safetyProfile={safetyProfile}
						/>
					}
					formError={formError ?? saveBlockedReason}
					gatewayRoutingConfig={
						!isNew && agentId ? (
							<div className="flex flex-col gap-6">
								{chatModel === ACP_CUSTOM_ENGINE ? (
									<GatewayRoutingConfig
										agentId={agentId}
										limitedNotice={limitedRoutingNotice}
									/>
								) : null}
								<AgentSmartRouteOverride agentId={agentId} />
								<AgentRoutePoolEditor agentId={agentId} />
							</div>
						) : null
					}
					goalPanel={
						isNew || !effectiveAgentId ? null : (
							<AgentGoalPanel
								agentId={effectiveAgentId}
								disabled={isLocked}
								target={target}
							/>
						)
					}
					healthBadge={<ScorecardBadge scorecard={agentHealthScorecard} />}
					healthPanel={
						<ScorecardPanel
							agentScan={() =>
								runCatalogScan(target, {
									kind: "agent",
									id: agentId || "draft",
									name: name.trim() || "Untitled agent",
									description,
									metadata: { configuration: agentHealthInput },
									scorecard: agentHealthScorecard,
								})
							}
							dataTestId="agent-health-scorecard"
							disclaimer={
								<p className="text-muted-foreground text-xs leading-relaxed">
									These checks update as you edit the agent. They inspect its
									configuration only; they do not run the agent or replace Core
									and Gateway authorization.
								</p>
							}
							key={JSON.stringify([target.url, agentId, agentHealthInput])}
							onOpenConversation={(conversationId) =>
								openTab("/chat", { conversationId })
							}
							rulesetLabel="Agent ruleset"
							scorecard={agentHealthScorecard}
							title="Agent health"
						/>
					}
					historyPanel={
						isNew || !agentId ? null : <AgentRunHistoryView agentId={agentId} />
					}
					identityModePanel={
						remotePeer ? (
							<AgentRemotePeerIdentityNote />
						) : (
							<div className="flex flex-col gap-3">
								{pendingIdentityMode && existing ? (
									<AgentPendingIdentityModeNotice
										busy={dismissingPendingMode || savingScope !== null}
										disabled={isLocked}
										keptMode={existing.identityMode}
										onAccept={setIdentityMode}
										onKeepCurrent={() => void keepCurrentIdentityMode()}
										pendingMode={pendingIdentityMode}
										selectedMode={identityMode}
									/>
								) : null}
								<AgentIdentityModePicker
									disabled={isLocked}
									onChange={setIdentityMode}
									value={identityMode}
								/>
								{identityModeWarning ? (
									<p
										className="px-3.5 text-status-warning text-xs leading-snug"
										role="status"
									>
										{identityModeWarning}
									</p>
								) : null}
								<AgentLaunchWarning
									check={launch.check}
									disabled={isLocked}
									engine={launchEngine}
									modelsLimited={agentModelsLimited(
										identityMode,
										accountAccess
									)}
									onUseRyu={
										isBuiltIn
											? undefined
											: () => {
													setChatModel(RYU_ENGINE_ID);
													setAgentModel("");
													setAgentModelEngine(null);
												}
									}
								/>
							</div>
						)
					}
					initialSettingId={initialSettingId}
					integrationsPanel={
						isNew || !agentId ? null : (
							<IntegrationsPanel agentId={agentId} target={target} />
						)
					}
					isBuiltIn={isBuiltIn}
					isLocked={isLocked}
					isNew={isNew}
					marketplaceWallpapers={marketplaceWallpapers}
					memoryReadLevels={memoryReadLevels}
					memorySpaceIds={memorySpaceIds}
					memoryWriteEnabled={memoryWriteEnabled}
					name={name}
					observabilityPanel={
						isNew || !agentId ? null : (
							<AgentObservabilityView
								agentId={agentId}
								defaultModel={agentModel}
								onOpenRun={(conversationId) =>
									openTab("/chat", { conversationId })
								}
								target={target}
							/>
						)
					}
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
					optimizationsPanel={
						isNew || !agentId ? null : (
							<AgentOptimizationsView
								agentId={agentId}
								disabled={isLocked}
								onApplied={reloadAfterOptimization}
								target={target}
							/>
						)
					}
					ownAccountsAllowed={modeHasOwnAccounts(identityMode)}
					passportPanel={
						isNew || !effectiveAgentId || !existing ? null : (
							<AgentPassportPanel
								agent={existing}
								organizationId={activeNode.orgId ?? null}
								target={target}
							/>
						)
					}
					personaDisplayName={personaDisplayName}
					personalityProfile={personalityProfileId}
					personalityProfiles={personalityProfileOptions}
					piConfig={agentId === "ryu" ? <RyuPiConfig /> : null}
					preview={previewProps}
					promptStudioPanel={
						isNew ? null : (
							<PromptStudio
								agentId={agentId ?? null}
								engine={chatModel}
								locked={isLocked}
								model={agentModel}
								onChange={setSystemPrompt}
								target={target}
								value={systemPrompt}
								version={existing?.version ?? "1.0.0"}
							/>
						)
					}
					routinesPanel={
						isNew || !agentId ? null : (
							<AgentRoutinesPanel agentId={agentId} disabled={isLocked} />
						)
					}
					rules={rules}
					rulesPanel={
						effectiveAgentId && agentEditPanels.length > 0
							? agentEditPanels.map((panel) => (
									<RulesAgentEditPanel
										agentId={effectiveAgentId}
										key={`${panel.plugin}:${panel.id}`}
										legacyRules={rules}
										locked={isLocked}
										prefKeyPrefix={panel.pref_key_prefix}
										projectCwd={projectCwd}
										target={target}
										title={panel.title}
									/>
								))
							: null
					}
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
					versionHistoryPanel={
						agentVersionSource ? (
							<AgentVersionHistoryPanel
								currentValue={currentAgentVersionValue}
								disabled={isLocked}
								onRestored={handleAgentVersionRestored}
								source={agentVersionSource}
							/>
						) : null
					}
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
