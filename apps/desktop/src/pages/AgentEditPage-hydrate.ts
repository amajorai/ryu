import { parseRules } from "@ryuhq/protocol/agent-rules";
import { useEffect, useMemo } from "react";
import {
	encodeSkillAllowlist,
	encodeToolAllowlist,
} from "@/src/lib/agent-capabilities.ts";
import { personaToGlyphValue } from "@/src/lib/agent-persona.ts";
import type { AgentEditBase } from "./AgentEditPage-base.ts";
import type { AgentEditComposio } from "./AgentEditPage-composio.ts";
import type { AgentEditFormState } from "./AgentEditPage-form-state.ts";
import type { AgentEditLoaders } from "./AgentEditPage-loaders.ts";
import {
	ACP_CUSTOM_ENGINE,
	ACP_EXEC_PREFIX,
	AGENT_OWN_VOICE_PROFILE,
	TONE_OPTIONS,
} from "./AgentEditPage-options.ts";

export type AgentEditHydrate = ReturnType<typeof useAgentEditHydrate>;

export function useAgentEditHydrate(
	ctx: AgentEditBase & AgentEditFormState & AgentEditComposio & AgentEditLoaders
) {
	const {
		hydrated,
		loading,
		isNew,
		loadedRecordScope,
		recordScope,
		existing,
		setName,
		setLifecycleStatus,
		setSafetyProfile,
		setAgentTitle,
		setDescription,
		setSystemPrompt,
		setRules,
		setChatModel,
		setAcpCommand,
		setAgentModel,
		setAgentModelEngine,
		setSelectedComposio,
		setSelectedIdentities,
		setIdentityMode,
		setAccountAccess,
		setMemorySpaceIds,
		setMemoryReadLevels,
		setMemoryWriteEnabled,
		setSampling,
		setOrchestrator,
		setCanCreateAgents,
		setPersonaDisplayName,
		setAvatarGlyph,
		setPersonalityProfileId,
		setTone,
		setCustomTone,
		setHydrated,
		installedAgentEngineOptions,
		setSelectedTools,
		setSelectedSkills,
		availableTools,
		selectedTools,
		availableSkills,
		selectedSkills,
	} = ctx;
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
	return {
		isBuiltIn,
		isLocked,
		toggleTool,
		toggleSkill,
		savedTools,
		savedSkills,
		toggleIdentity,
		toggleMemorySpace,
		toggleMemoryReadLevel,
	};
}
