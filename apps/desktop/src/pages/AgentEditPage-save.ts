import { promptEditCacheWarning } from "@ryu/blocks/desktop/agent-elements/prompt-cache.ts";
import { composeRules } from "@ryuhq/protocol/agent-rules";
import { buildNewAgentChatSeed } from "@/src/lib/agent-onboarding.ts";
import { glyphToPersonaFields } from "@/src/lib/agent-persona.ts";
import {
	legacyRulesToConfig,
	saveAgentRulesConfig,
} from "@/src/lib/api/agent-rules.ts";
import { bumpPatchVersion, updateAgentPosture } from "@/src/lib/api/agents.ts";
import {
	createScheduledAgentWorkflow,
	phraseToSchedule,
} from "@/src/lib/automations.ts";
import { promptLayerChanges } from "@/src/lib/prompt-layer-changes.ts";
import type { AgentEditBase } from "./AgentEditPage-base.ts";
import type { AgentEditComposio } from "./AgentEditPage-composio.ts";
import type { AgentEditFormState } from "./AgentEditPage-form-state.ts";
import type { AgentEditHydrate } from "./AgentEditPage-hydrate.ts";
import type { AgentEditLoaders } from "./AgentEditPage-loaders.ts";
import {
	ACP_CUSTOM_ENGINE,
	ACP_EXEC_PREFIX,
	AGENT_OWN_VOICE_PROFILE,
} from "./AgentEditPage-options.ts";
import {
	agentPostureResources,
	postureResourceFor,
	releasePostureResource,
} from "./AgentEditPage-posture-resource.ts";

export type AgentEditSave = ReturnType<typeof createAgentEditSave>;

export function createAgentEditSave(
	ctx: AgentEditBase &
		AgentEditFormState &
		AgentEditComposio &
		AgentEditLoaders &
		AgentEditHydrate
) {
	const {
		editorMounted,
		activeRecordScope,
		recordScope,
		postureEndpoint,
		posturePendingScope,
		isNew,
		postureLoadedScope,
		name,
		setFormError,
		chatModel,
		acpCommand,
		selectedUninstalledAgent,
		isLocked,
		existing,
		promptEditConfirmed,
		personaDisplayName,
		personalityProfileId,
		savedSkills,
		agentEditPanels,
		systemPrompt,
		rules,
		tone,
		customTone,
		setPromptEditConfirmation,
		target,
		effectiveAgentId,
		recordReadGeneration,
		setSavingScope,
		agentTitle,
		description,
		agentModel,
		agentModelEngine,
		savedTools,
		selectedComposio,
		selectedIdentities,
		identityMode,
		accountAccess,
		avatarGlyph,
		sampling,
		orchestrator,
		canCreateAgents,
		safetyProfile,
		memorySpaceIds,
		memoryReadLevels,
		memoryWriteEnabled,
		draftId,
		agentId,
		update,
		setExisting,
		create,
		setDraftId,
		lifecycleStatus,
		setLifecycleStatus,
		scheduleEnabled,
		schedulePhrase,
		dailyTime,
		weeklyDay,
		weeklyTime,
		customCron,
		newAgentChatOpenedRef,
		openTab,
		goBack,
	} = ctx;
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
	return { handleSave };
}
