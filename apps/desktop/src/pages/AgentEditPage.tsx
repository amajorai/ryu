import { LockedIcon, Rocket01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AgentByoaView,
	AgentConnectView,
	AgentSettingsForm,
	type SlotOption,
	type SnippetLang,
} from "@ryu/blocks/desktop/agent-edit";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Checkbox } from "@ryu/ui/components/checkbox";
import { Label } from "@ryu/ui/components/label";
import { Spinner } from "@ryu/ui/components/spinner";
import { Textarea } from "@ryu/ui/components/textarea";
import { composeRules, parseRules } from "@ryuhq/protocol/agent-rules";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AcpSessionControls } from "@/src/components/agents/AcpSessionControls.tsx";
import { AgentCalendarView } from "@/src/components/agents/AgentCalendarView.tsx";
import { AgentCapabilitiesPanel } from "@/src/components/agents/AgentCapabilitiesPanel.tsx";
import { AgentChannelsSection } from "@/src/components/agents/AgentChannelsSection.tsx";
import { AgentEvalsView } from "@/src/components/agents/AgentEvalsView.tsx";
import { AgentImageField } from "@/src/components/agents/AgentImageField.tsx";
import { AgentLanyardCard } from "@/src/components/agents/AgentLanyardCard.tsx";
import { AgentRunHistoryView } from "@/src/components/agents/AgentRunHistoryView.tsx";
import { AgentSmartRouteOverride } from "@/src/components/agents/AgentSmartRouteOverride.tsx";
import { ClaudeGatewayConfig } from "@/src/components/agents/ClaudeGatewayConfig.tsx";
import { CodexGatewayConfig } from "@/src/components/agents/CodexGatewayConfig.tsx";
import { GatewayRoutingConfig } from "@/src/components/agents/GatewayRoutingConfig.tsx";
import { OrchestrationPanel } from "@/src/components/agents/OrchestrationPanel.tsx";
import { RyuPiConfig } from "@/src/components/agents/RyuPiConfig.tsx";
import { AdvancedInferenceSection } from "@/src/components/inference/AdvancedInferenceSection.tsx";
import { ModelLaunchConfigSection } from "@/src/components/inference/ModelLaunchConfigSection.tsx";
import { PublishDialog } from "@/src/components/marketplace/PublishDialog.tsx";
import { PromptStudio } from "@/src/components/PromptStudio.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useTitleBar } from "@/src/contexts/TitleBarContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useAssistantBuilder } from "@/src/hooks/useAssistantBuilder.ts";
import {
	useComposioActions,
	useComposioStatus,
	useComposioToolkits,
	useComposioTriggers,
} from "@/src/hooks/useComposioCatalog.ts";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import { useIdentities } from "@/src/hooks/useIdentities.ts";
import { AgentLogo } from "@/src/lib/agent-logos.tsx";
import {
	type Agent,
	type AgentSummary,
	type AgentTools,
	bumpPatchVersion,
	fetchAgent,
	fetchAgentTools,
} from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
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
import { isLocalEngine, type SamplingConfig } from "@/src/lib/api/inference.ts";
import type { PublishRequest } from "@/src/lib/api/marketplace.ts";
import { fetchMcpTools } from "@/src/lib/api/mcp.ts";
import { getActiveModel } from "@/src/lib/api/models.ts";
import { type InstalledSkill, listSkills } from "@/src/lib/api/skills.ts";
import { fetchSpaces } from "@/src/lib/api/spaces.ts";
import {
	createScheduledAgentWorkflow,
	phraseToSchedule,
	type SchedulePhrase,
} from "@/src/lib/automations.ts";
import { friendlyModelDisplay } from "@/src/lib/catalog/friendly.ts";
import {
	type AgentPublishSource,
	buildAgentPublishBody,
	type PublishListing,
} from "@/src/lib/publish/packaging.ts";

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

interface ConnectPanelProps {
	agentId: string;
	target: ApiTarget;
}

const TRAILING_SLASH_RE = /\/+$/;
const PORT_SUFFIX_RE = /:\d+$/;

/** Strip the trailing slash so we never build `…//api/chat/stream`. */
function normalizeBase(url: string): string {
	return url.replace(TRAILING_SLASH_RE, "");
}

/** Swap the Core port (7980) for the gateway port (7981) for SDK snippets. */
function gatewayBaseFrom(url: string): string {
	const base = normalizeBase(url);
	return PORT_SUFFIX_RE.test(base)
		? base.replace(PORT_SUFFIX_RE, ":7981")
		: `${base}:7981`;
}

function buildSnippet(
	lang: SnippetLang,
	base: string,
	agentId: string,
	hasToken: boolean
): string {
	const tokenPlaceholder = "YOUR_NODE_TOKEN";
	if (lang === "curl") {
		const authLine = hasToken
			? `\n  -H "Authorization: Bearer ${tokenPlaceholder}" \\`
			: "";
		return `curl -N ${base}/api/chat/stream \\${authLine}
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"${agentId}","messages":[{"role":"user","content":"Hello!"}]}'`;
	}
	if (lang === "typescript") {
		const authProp = hasToken
			? `\n    Authorization: "Bearer ${tokenPlaceholder}",`
			: "";
		return `// Stream a turn from the "${agentId}" agent on this Ryu node.
const res = await fetch("${base}/api/chat/stream", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",${authProp}
  },
  body: JSON.stringify({
    agent_id: "${agentId}",
    messages: [{ role: "user", content: "Hello!" }],
  }),
});

// The body streams Vercel AI SDK events — read them as they arrive.
const reader = res.body!.getReader();
const decoder = new TextDecoder();
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  process.stdout.write(decoder.decode(value));
}`;
	}
	// Ryu SDK — gateway-mandatory model client. Routes by model id; tag this
	// agent's firewall/budget via a gateway key (see "Bring external agent").
	const gatewayBase = gatewayBaseFrom(base);
	return `import { defineModel } from "@ryuhq/sdk";

// Every call is routed through this node's Ryu gateway. Generate a
// gateway key in "Bring external agent" below to apply the "${agentId}"
// agent's firewall, budget, and routing.
const model = defineModel("your-model-id", {
  baseUrl: "${gatewayBase}",
  token: "YOUR_GATEWAY_KEY",
});

const reply = await model.chat([
  { role: "user", content: "Hello!" },
]);
console.log(reply.content);`;
}

function ConnectPanel({ target, agentId }: ConnectPanelProps) {
	const [lang, setLang] = useState<SnippetLang>("curl");
	const [copied, setCopied] = useState(false);

	const base = useMemo(() => normalizeBase(target.url), [target.url]);
	const hasToken = Boolean(target.token);
	const snippet = useMemo(
		() => buildSnippet(lang, base, agentId, hasToken),
		[lang, base, agentId, hasToken]
	);

	const copySnippet = async () => {
		try {
			await navigator.clipboard.writeText(snippet);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard access may be blocked in some Tauri contexts — ignore.
		}
	};

	return (
		<AgentConnectView
			agentId={agentId}
			copied={copied}
			hasToken={hasToken}
			lang={lang}
			onCopy={() => copySnippet()}
			onLangChange={setLang}
			snippet={snippet}
		/>
	);
}

// ── Tone options ──────────────────────────────────────────────────────────────

type ToneOption = "neutral" | "professional" | "friendly" | "pirate" | "custom";

const TONE_OPTIONS: { value: ToneOption; label: string }[] = [
	{ value: "neutral", label: "Neutral (default)" },
	{ value: "professional", label: "Professional" },
	{ value: "friendly", label: "Friendly" },
	{ value: "pirate", label: "Pirate" },
	{ value: "custom", label: "Custom" },
];

// ── Fallback tool list (used when GET /api/mcp/tools returns empty) ───────────

const FALLBACK_TOOLS = [
	"search",
	"semantic_search",
	"web_browse",
	"code_execute",
	"file_read",
	"file_write",
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

function agentEngineOptionId(agent: AgentSummary): string | null {
	if (!agent.builtIn) {
		return null;
	}
	if (agent.id === "ryu") {
		return "acp:pi";
	}
	return agent.id;
}

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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
export default function AgentEditPage({
	agentIdProp,
	onClose,
}: {
	agentIdProp?: string;
	onClose?: () => void;
} = {}) {
	const { agentId: routeAgentId } = useParams<{ agentId: string }>();
	const agentId = agentIdProp ?? routeAgentId;
	const navigate = useNavigate();
	const { openTab } = useTabsContext();
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
	const { agents, activeEngine, loading, create, update } = useAgents();

	const activeNode = useActiveNode();
	const target: ApiTarget = useMemo(
		() => ({ url: activeNode.url, token: activeNode.token ?? null }),
		[activeNode.url, activeNode.token]
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
	const [description, setDescription] = useState("");
	const [systemPrompt, setSystemPrompt] = useState("");
	const [chatModel, setChatModel] = useState("");
	const selectedUninstalledAgent =
		Boolean(chatModel) &&
		!isInstalledChatModel(chatModel, installedAgentEngineIds);
	// For a brand-new agent, the builder chat needs a real record to edit. We
	// lazily create a draft on the first builder message and adopt its id here;
	// from then on the page edits the draft instead of creating a new agent.
	const [draftId, setDraftId] = useState<string | null>(null);
	// Free-text ACP command shown when the "Custom ACP command…" engine is picked.
	const [acpCommand, setAcpCommand] = useState("");
	const [existing, setExisting] = useState<Agent | null>(null);
	const [agentToolsData, setAgentToolsData] = useState<AgentTools | null>(null);
	const [recordLoading, setRecordLoading] = useState(!isNew);
	const [saving, setSaving] = useState(false);
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
	// Custom agent avatar (a cropped image stored inline as a data URL). Null =
	// use the engine logo.
	const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

	// ── Advanced inference (per-agent sampling defaults) ─────────────────────────
	const [sampling, setSampling] = useState<SamplingConfig>({});

	// ── Orchestration capabilities ───────────────────────────────────────────────
	// Effective values (null in the record collapses to the code default here:
	// delegation on, creation off). Saved as explicit booleans on the agent body.
	const [orchestrator, setOrchestrator] = useState(true);
	const [canCreateAgents, setCanCreateAgents] = useState(false);

	// ── Engine / hardware launch config (only for local-engine agents) ───────────
	// The launch flags are keyed by the model the local engine actually serves —
	// the active served model — matching what Core resolves at spawn time. We only
	// surface the editor when this agent's chat engine is a local one we can tune.
	const [friendly] = useFriendlyMode();
	const localEngineSelected = isLocalEngine(chatModel);
	const activeModelQuery = useQuery({
		queryKey: ["models", "active", target.url, chatModel],
		queryFn: () => getActiveModel(target),
		enabled: localEngineSelected,
	});
	const launchModelId =
		activeModelQuery.data?.active || activeModelQuery.data?.default || "";
	const rawLaunchModelName = activeModelQuery.data?.repoId ?? launchModelId;
	// The served-model name is a raw HF repo slug (e.g. "unsloth/gemma-4-12B-it-GGUF")
	// or a served-file stem that may embed a quant. In friendly mode show the
	// readable name + friendly compression (never "Q4_K_M"); the raw id + quant
	// explanation stays available on hover.
	const launchModelDisplay = rawLaunchModelName
		? friendlyModelDisplay(rawLaunchModelName)
		: null;
	const launchModelName =
		friendly && launchModelDisplay
			? launchModelDisplay.label
			: rawLaunchModelName;
	const launchModelTitle =
		friendly && launchModelDisplay ? launchModelDisplay.tooltip : undefined;

	// ── Rules state (folded into the system prompt on save) ──────────────────────
	const [rules, setRules] = useState<string[]>([]);

	// ── Tools state ──────────────────────────────────────────────────────────────
	const [availableTools, setAvailableTools] = useState<string[]>([]);
	const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
	const [toolsLoading, setToolsLoading] = useState(false);

	// ── Skills state (per-agent allowlist; empty Set = all enabled skills) ───────
	const [availableSkills, setAvailableSkills] = useState<InstalledSkill[]>([]);
	const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
	const [skillsLoading, setSkillsLoading] = useState(false);

	// ── Identity Vault binding state (per-agent profile allowlist; empty = none) ─
	const [selectedIdentities, setSelectedIdentities] = useState<Set<string>>(
		new Set()
	);

	// ── Memory / Spaces slot state ───────────────────────────────────────────────
	// `memorySpaceIds`: Space ids the agent may read (empty = none injected).
	// `memoryReadLevels`: recallable memory levels (empty = all three levels).
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
	const [moreSlotsOpen, setMoreSlotsOpen] = useState(false);

	// Paywall gate: Prompt Studio and background agent schedules are Band-2 (pro)
	// features — a one-time Lifetime license or a subscription unlocks them.
	const { canUse, requestUpgrade } = useEntitlementContext();

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
	const composioToolkitsQuery = useComposioToolkits(composioConfigured);
	const composioActionsQuery = useComposioActions(composioToolkit);
	const composioTriggersQuery = useComposioTriggers(composioToolkit);

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
			await subscribeTrigger(target, {
				agentId,
				toolkit: composioToolkit,
				triggerSlug,
				connectedAccountId: connectedAccountId.trim(),
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
	const loadRecord = useCallback(async () => {
		if (isNew || !agentId) {
			return;
		}
		setRecordLoading(true);
		setFormError(null);
		try {
			const [record, toolList] = await Promise.all([
				fetchAgent(target, agentId),
				fetchAgentTools(target, agentId).catch(() => null),
			]);
			setExisting(record);
			setAgentToolsData(toolList);
		} catch (e) {
			setFormError(e instanceof Error ? e.message : "Failed to load agent");
		} finally {
			setRecordLoading(false);
		}
	}, [agentId, isNew, target]);

	useEffect(() => {
		loadRecord();
	}, [loadRecord]);

	// ── Hydrate form from loaded record ──────────────────────────────────────────
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
	useEffect(() => {
		if (hydrated || loading) {
			return;
		}
		if (existing) {
			setName(existing.name);
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
			// Pre-select the agent's existing tools
			setSelectedTools(new Set(existing.tools ?? []));
			setSelectedComposio(new Set(existing.composioActions ?? []));
			setSelectedSkills(new Set(existing.skills ?? []));
			setSelectedIdentities(new Set(existing.identityProfileIds ?? []));
			// Memory / Spaces slot round-trips from the record. Empty read_levels
			// stays empty here (the "all three levels" default is applied by Core).
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
			setAvatarUrl(persona?.avatar_url ?? null);
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
	}, [existing, isNew, installedAgentEngineOptions, loading, hydrated]);

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

	// ── Toggle a memory access level (user/node/project) ─────────────────────────
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
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
	const handleSave = async (navigateToChat = false) => {
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
		setSaving(true);
		setFormError(null);

		const nextVersion = existing?.version
			? bumpPatchVersion(existing.version)
			: undefined;

		// Build persona tone value: use custom text when "custom" is selected.
		const toneValue = tone === "custom" ? customTone.trim() || "neutral" : tone;

		// Fold the structured rules list into the stored prompt.
		const composedPrompt = composeRules(systemPrompt, rules);

		const input = {
			name: name.trim(),
			description: description.trim() || null,
			systemPrompt: composedPrompt.trim() ? composedPrompt.trim() : null,
			engine:
				chatModel === ACP_CUSTOM_ENGINE
					? `${ACP_EXEC_PREFIX}${acpCommand.trim()}`
					: chatModel,
			tools: Array.from(selectedTools),
			composioActions: Array.from(selectedComposio),
			skills: Array.from(selectedSkills),
			identityProfileIds: Array.from(selectedIdentities),
			version: nextVersion,
			// Persona fields — passed through; Core stores them when the field exists.
			persona: {
				display_name: personaDisplayName.trim() || null,
				tone: toneValue === "neutral" ? null : toneValue,
				avatar_url: avatarUrl,
			},
			// Advanced sampling defaults — passed through to Core's agent record.
			inference: sampling,
			// Orchestration capabilities (delegation/discovery + agent creation).
			orchestrator,
			canCreateAgents,
			// Memory / Spaces slot. Empty read_levels means "all three levels"
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
				savedId = updated.id;
				setExisting((prev) =>
					prev ? { ...prev, version: updated.version } : prev
				);
			} else {
				const created = await create(input);
				savedId = created.id;
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

			if (navigateToChat && isNew) {
				localStorage.setItem("ryu_default_agent", savedId);
			}
			goBack();
		} catch (e) {
			setFormError(e instanceof Error ? e.message : "Failed to save agent");
		} finally {
			setSaving(false);
		}
	};

	// ── Marketplace publish packaging ────────────────────────────────────────────
	// Build the publish body from the CURRENT form state, dropping every
	// non-portable / per-user binding: Identity Vault profiles and Memory space_ids
	// are never passed to the packager, and a custom `acp-exec:` command is scrubbed
	// inside it. The agent record itself carries no keys (BYOK/gateway keys live
	// behind the separate gateway endpoints), so no secret can leak by construction.
	const buildPublishBody = useCallback(
		(listing: PublishListing): PublishRequest => {
			const source: AgentPublishSource = {
				systemPrompt: composeRules(systemPrompt, rules).trim() || null,
				// The saved engine binding; the packager scrubs a custom `acp-exec:`
				// command (a local binary path is never shipped).
				engine:
					chatModel === ACP_CUSTOM_ENGINE
						? `${ACP_EXEC_PREFIX}${acpCommand.trim()}`
						: chatModel || null,
				tools: Array.from(selectedTools),
				composioActions: Array.from(selectedComposio),
				skills: Array.from(selectedSkills),
				// Recallable memory LEVELS only — never the node-local space_ids.
				memoryReadLevels: Array.from(memoryReadLevels),
				orchestrator,
				canCreateAgents,
				description: description.trim() || null,
				version: existing?.version ?? "1.0.0",
			};
			return buildAgentPublishBody(
				source,
				listing
			) as unknown as PublishRequest;
		},
		[
			systemPrompt,
			rules,
			chatModel,
			acpCommand,
			selectedTools,
			selectedComposio,
			selectedSkills,
			memoryReadLevels,
			orchestrator,
			canCreateAgents,
			description,
			existing?.version,
		]
	);

	// Publish is offered only for a saved, custom agent (built-ins are Ryu's; a
	// brand-new unsaved agent has no record to package yet).
	const canPublish = !(isNew || isBuiltIn) && Boolean(agentId);

	// The id the builder chat edits: the existing agent, or a draft (lazily
	// created on first builder message for brand-new agents).
	const effectiveAgentId = isNew ? draftId : (agentId ?? null);

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
				description: description.trim() || null,
				systemPrompt: null,
				engine:
					chatModel === ACP_CUSTOM_ENGINE
						? `${ACP_EXEC_PREFIX}${acpCommand.trim()}`
						: chatModel,
				tools: Array.from(selectedTools),
				composioActions: Array.from(selectedComposio),
				skills: Array.from(selectedSkills),
				identityProfileIds: Array.from(selectedIdentities),
				orchestrator,
				canCreateAgents,
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
		acpCommand,
		name,
		description,
		selectedTools,
		selectedComposio,
		selectedSkills,
		selectedIdentities,
		orchestrator,
		canCreateAgents,
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
				setHydrated(false);
			} catch {
				// Non-fatal: the next save/load reconciles.
			}
		},
		[target]
	);

	// Compact snapshot of the current config, fed to the builder's preamble.
	const agentSnapshot = useMemo(
		() =>
			JSON.stringify({
				id: effectiveAgentId,
				name: name.trim(),
				description: description.trim(),
				engine: chatModel,
				tools: Array.from(selectedTools),
				skills: Array.from(selectedSkills),
				composioActions: Array.from(selectedComposio),
				tone,
			}),
		[
			effectiveAgentId,
			name,
			description,
			chatModel,
			selectedTools,
			selectedSkills,
			selectedComposio,
			tone,
		]
	);

	// Page header lives in the shared TitleBar (no in-page header bar). Title = the
	// agent's identity; the config surfaces (Prompt Studio / Evals / Calendar) are
	// tabs inside the settings form, so the title bar carries no view toggle.
	const titleBarTitle = useMemo(
		() => (
			<span className="flex min-w-0 items-center gap-2">
				<span className="truncate font-semibold">
					{isNew ? "New agent" : name.trim() || "Edit agent"}
				</span>
				{isBuiltIn ? (
					<Badge className="gap-1" variant="secondary">
						<HugeiconsIcon className="size-3" icon={LockedIcon} />
						Built-in
					</Badge>
				) : null}
				{isLocked && !isBuiltIn ? (
					<Badge className="gap-1" variant="secondary">
						<HugeiconsIcon className="size-3" icon={LockedIcon} />
						Locked
					</Badge>
				) : null}
			</span>
		),
		[isNew, name, isBuiltIn, isLocked]
	);

	useTitleBar(titleBarTitle);

	// Hand the docked Ask Ryu panel over to the agent builder while this page is
	// focused: it drives the `agent_builder__*` tools (with the allow/deny
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

	if ((loading || recordLoading) && !hydrated) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}

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
		instructions: composeRules(systemPrompt, rules),
		locked: isLocked && !isBuiltIn,
		modelLabel,
		name,
		scheduleSummary: scheduleSummaryValue,
		toneLabel: toneLabelValue,
		tools: [...selectedToolsList, ...Array.from(selectedComposio)],
	};

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="scroll-fade-effect-y min-h-0 flex-1 overflow-auto p-4 lg:p-6">
				{canPublish ? (
					<div className="mb-4 flex items-center justify-end">
						<Button
							onClick={() => setPublishOpen(true)}
							size="sm"
							variant="outline"
						>
							<HugeiconsIcon className="size-4" icon={Rocket01Icon} />
							Publish to marketplace
						</Button>
					</div>
				) : null}
				{canPublish ? (
					<PublishDialog
						buildBody={buildPublishBody}
						defaultDescription={description}
						defaultDisplayName={personaDisplayName.trim() || name}
						kindLabel="agent"
						onOpenChange={setPublishOpen}
						open={publishOpen}
					/>
				) : null}
				<AgentSettingsForm
					acpCommand={acpCommand}
					acpSessionPanel={
						!isNew && effectiveAgentId ? (
							<AcpSessionControls agentId={effectiveAgentId} />
						) : null
					}
					advancedInference={
						<AdvancedInferenceSection
							disabled={isLocked}
							localEngine={isLocalEngine(chatModel)}
							onChange={setSampling}
							value={sampling}
						/>
					}
					agentIcon={
						<AgentImageField
							disabled={isLocked}
							fallback={<AgentLogo engine={chatModel} size="24px" />}
							onChange={setAvatarUrl}
							value={avatarUrl}
						/>
					}
					byoaPanel={
						isNew || !agentId ? null : (
							<ByoaPanel agentId={agentId} target={target} />
						)
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
							<OrchestrationPanel
								canCreateAgents={canCreateAgents}
								disabled={isLocked}
								onChangeCanCreateAgents={setCanCreateAgents}
								onChangeOrchestrator={setOrchestrator}
								orchestrator={orchestrator}
							/>
						</>
					}
					channelsPanel={<AgentChannelsSection agentId={effectiveAgentId} />}
					chatModel={chatModel}
					chatSlotDisabled={
						isLocked || (isBuiltIn && installedAgentEngineOptions.length === 0)
					}
					claudeConfig={
						agentId === "acp:claude" ? <ClaudeGatewayConfig /> : null
					}
					codexConfig={agentId === "acp:codex" ? <CodexGatewayConfig /> : null}
					composioActions={composioActionsQuery.data ?? []}
					composioActionsLoading={composioActionsQuery.isLoading}
					composioConfigured={composioConfigured}
					composioToolkit={composioToolkit}
					composioToolkitItems={composioToolkitItems}
					composioTriggers={composioTriggersQuery.data ?? []}
					connectedAccountId={connectedAccountId}
					connectPanel={
						isNew || !agentId ? null : (
							<ConnectPanel agentId={agentId} target={target} />
						)
					}
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
								defaultModel={chatModel}
								target={target}
							/>
						)
					}
					formError={formError ?? saveBlockedReason}
					gatewayRoutingConfig={
						!isNew && agentId && chatModel === ACP_CUSTOM_ENGINE ? (
							<div className="flex flex-col gap-6">
								<GatewayRoutingConfig agentId={agentId} />
								<AgentSmartRouteOverride agentId={agentId} />
							</div>
						) : null
					}
					historyPanel={
						isNew || !agentId ? null : <AgentRunHistoryView agentId={agentId} />
					}
					identityPanel={
						<IdentityPanel
							disabled={isLocked}
							onToggle={toggleIdentity}
							selected={selectedIdentities}
						/>
					}
					instructionsEditor={
						<Textarea
							className="min-h-40"
							disabled={isLocked}
							id="agent-prompt"
							onChange={(event) => setSystemPrompt(event.target.value)}
							placeholder="Describe how this agent should behave, what it should avoid, and how it should respond."
							readOnly={isLocked}
							value={systemPrompt}
						/>
					}
					isBuiltIn={isBuiltIn}
					isLocked={isLocked}
					isNew={isNew}
					launchConfig={
						localEngineSelected && launchModelId ? (
							<ModelLaunchConfigSection
								modelId={launchModelId}
								subtitle={launchModelName}
								subtitleTitle={launchModelTitle}
							/>
						) : null
					}
					memoryReadLevels={memoryReadLevels}
					memorySpaceIds={memorySpaceIds}
					memoryWriteEnabled={memoryWriteEnabled}
					moreSlotsOpen={moreSlotsOpen}
					name={name}
					onAcpCommandChange={setAcpCommand}
					onAddMoreAgentProviders={openAgentsCatalog}
					onAddRule={() => setRules((prev) => [...prev, ""])}
					onCancel={() => goBack()}
					onChatModelChange={setChatModel}
					onClearComposio={clearComposioActions}
					onComposioToolkitChange={setComposioToolkit}
					onConnectedAccountIdChange={setConnectedAccountId}
					onCreateAndChat={() => handleSave(true)}
					onCustomCronChange={setCustomCron}
					onCustomToneChange={setCustomTone}
					onDailyTimeChange={setDailyTime}
					onDeleteTrigger={handleDeleteTrigger}
					onDescriptionChange={setDescription}
					onMemoryWriteEnabledChange={setMemoryWriteEnabled}
					onNameChange={setName}
					onPersonaDisplayNameChange={setPersonaDisplayName}
					onRemoveRule={(index) =>
						setRules((prev) => prev.filter((_, i) => i !== index))
					}
					onRuleChange={(index, value) =>
						setRules((prev) => prev.map((r, i) => (i === index ? value : r)))
					}
					onSave={() => handleSave(false)}
					onScheduleEnabledChange={(next) => {
						if (next && !canUse("local-background-runs")) {
							requestUpgrade();
							return;
						}
						setScheduleEnabled(next);
					}}
					onSchedulePhraseChange={(v) => setSchedulePhrase(v as SchedulePhrase)}
					onSelectAllComposio={selectAllComposio}
					onSubscribeTrigger={() => handleSubscribeTrigger()}
					onToggleComposio={toggleComposio}
					onToggleMemoryReadLevel={toggleMemoryReadLevel}
					onToggleMemorySpace={toggleMemorySpace}
					onToggleMoreSlots={() => setMoreSlotsOpen((o) => !o)}
					onToggleSkill={toggleSkill}
					onToggleTool={toggleTool}
					onToneChange={(v) => setTone(v as ToneOption)}
					onTriggerSlugChange={setTriggerSlug}
					onWeeklyDayChange={setWeeklyDay}
					onWeeklyTimeChange={setWeeklyTime}
					personaDisplayName={personaDisplayName}
					piConfig={agentId === "ryu" ? <RyuPiConfig /> : null}
					preview={previewProps}
					promptStudioPanel={
						isNew || !canUse("prompt-studio") ? null : (
							<PromptStudio
								agentId={agentId ?? null}
								locked={isLocked}
								model={chatModel}
								onChange={setSystemPrompt}
								target={target}
								value={systemPrompt}
								version={existing?.version ?? "1.0.0"}
							/>
						)
					}
					rules={rules}
					saveDisabled={
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
					showComposioTriggers={composioConfigured && !isNew}
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
					triggerSubs={triggerSubs}
					weeklyDay={weeklyDay}
					weeklyTime={weeklyTime}
				/>
			</div>
		</div>
	);
}

/** Per-agent Identity Vault profile picker. Options come from the connections the
 *  user created on the Identities page (a profile exists only once a connection
 *  carries it). Empty selection = the agent is bound to no profiles. */
function IdentityPanel({
	selected,
	onToggle,
	disabled,
}: {
	selected: Set<string>;
	onToggle: (profileId: string) => void;
	disabled: boolean;
}) {
	const { profileIds, loading } = useIdentities();

	return (
		<SettingsSection
			caption="Bind Identity Vault profiles so this agent acts as a logged-in user on their connected domains. Leave all unchecked to bind no profiles. Create connections on the Identities page. Credentials are encrypted and never sent to the model."
			headerAction={
				selected.size > 0 ? (
					<Badge variant="secondary">{selected.size}</Badge>
				) : undefined
			}
			title="Identities"
		>
			<SettingsCard className="flex flex-col gap-3">
				{loading ? (
					<div className="flex items-center gap-2 text-muted-foreground text-xs">
						<Spinner className="size-3" />
						Loading profiles…
					</div>
				) : null}
				{!loading && profileIds.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No identity profiles yet. Create a connection on the Identities page
						to define one.
					</p>
				) : null}
				{!loading && profileIds.length > 0 ? (
					<div className="flex flex-col gap-2">
						{profileIds.map((profileId) => {
							const checkId = `identity-${profileId}`;
							return (
								<div className="flex items-start gap-3" key={profileId}>
									<Checkbox
										checked={selected.has(profileId)}
										disabled={disabled}
										id={checkId}
										onCheckedChange={() => onToggle(profileId)}
									/>
									<Label
										className="cursor-pointer font-normal text-sm"
										htmlFor={checkId}
									>
										<span className="font-medium">{profileId}</span>
									</Label>
								</div>
							);
						})}
					</div>
				) : null}
			</SettingsCard>
		</SettingsSection>
	);
}
