import type { SlotOption } from "@ryu/blocks/desktop/agent-edit.tsx";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { useMemo, useRef, useState } from "react";
import type { PromptCacheConfirmation } from "@/src/components/chat/PromptCacheConfirmDialog.tsx";
import { useResponseModeConfirm } from "@/src/hooks/useResponseModeConfirm.tsx";
import type {
	Agent,
	AgentIdentityMode,
	AgentLifecycleStatus,
	AgentSafetyProfile,
	AgentTools,
} from "@/src/lib/api/agents.ts";
import { apiUrl } from "@/src/lib/api/client.ts";
import type { SamplingConfig } from "@/src/lib/api/inference.ts";
import type { InstalledSkill } from "@/src/lib/api/skills.ts";
import type { SchedulePhrase } from "@/src/lib/automations.ts";
import type { AgentEditBase } from "./AgentEditPage-base.ts";
import {
	AGENT_OWN_VOICE_PROFILE,
	isInstalledChatModel,
	type ToneOption,
} from "./AgentEditPage-options.ts";

export type AgentEditFormState = ReturnType<typeof useAgentEditFormState>;

export function useAgentEditFormState(ctx: AgentEditBase) {
	const {
		installedAgentEngineIds,
		isNew,
		agentId,
		target,
		recordScope,
		personalityProfilesQuery,
	} = ctx;
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
	return {
		name,
		setName,
		agentTitle,
		setAgentTitle,
		description,
		setDescription,
		systemPrompt,
		setSystemPrompt,
		promptEditConfirmation,
		setPromptEditConfirmation,
		promptEditConfirmed,
		confirmLevelChange,
		responseModeDialog,
		chatModel,
		setChatModel,
		agentModel,
		setAgentModel,
		agentModelEngine,
		setAgentModelEngine,
		selectedUninstalledAgent,
		draftId,
		setDraftId,
		newAgentChatOpenedRef,
		acpCommand,
		setAcpCommand,
		existing,
		setExisting,
		dismissingPendingMode,
		setDismissingPendingMode,
		lifecycleStatus,
		setLifecycleStatus,
		safetyProfile,
		setSafetyProfile,
		postureSaving,
		setPostureSaving,
		postureError,
		setPostureError,
		postureLoadedScope,
		effectiveAgentId,
		postureEndpoint,
		agentToolsData,
		setAgentToolsData,
		recordLoading,
		setRecordLoading,
		savingScope,
		setSavingScope,
		saving,
		formError,
		setFormError,
		hydrated,
		setHydrated,
		publishOpen,
		setPublishOpen,
		personaDisplayName,
		setPersonaDisplayName,
		tone,
		setTone,
		customTone,
		setCustomTone,
		personalityProfileId,
		setPersonalityProfileId,
		personalityProfileOptions,
		avatarGlyph,
		setAvatarGlyph,
		sampling,
		setSampling,
		orchestrator,
		setOrchestrator,
		canCreateAgents,
		setCanCreateAgents,
		rules,
		setRules,
		availableTools,
		setAvailableTools,
		selectedTools,
		setSelectedTools,
		toolsLoading,
		setToolsLoading,
		availableSkills,
		setAvailableSkills,
		selectedSkills,
		setSelectedSkills,
		skillsLoading,
		setSkillsLoading,
		capabilitiesHydratedRef,
		selectedIdentities,
		setSelectedIdentities,
		identityMode,
		setIdentityMode,
		accountAccess,
		setAccountAccess,
		availableSpaces,
		setAvailableSpaces,
		memorySpaceIds,
		setMemorySpaceIds,
		memoryReadLevels,
		setMemoryReadLevels,
		memoryWriteEnabled,
		setMemoryWriteEnabled,
		selectedComposio,
		setSelectedComposio,
		composioToolkit,
		setComposioToolkit,
		scheduleEnabled,
		setScheduleEnabled,
		schedulePhrase,
		setSchedulePhrase,
		dailyTime,
		setDailyTime,
		weeklyDay,
		setWeeklyDay,
		weeklyTime,
		setWeeklyTime,
		customCron,
		setCustomCron,
	};
}
