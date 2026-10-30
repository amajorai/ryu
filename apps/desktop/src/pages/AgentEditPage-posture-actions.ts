import { useCallback } from "react";
import { glyphToPersonaFields } from "@/src/lib/agent-persona.ts";
import {
	type AgentLifecycleStatus,
	type AgentSafetyProfile,
	fetchAgent,
	updateAgentPosture,
} from "@/src/lib/api/agents.ts";
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
	postureResourceFor,
	releasePostureResource,
} from "./AgentEditPage-posture-resource.ts";
import type { AgentEditSave } from "./AgentEditPage-save.ts";

export type AgentEditPostureActions = ReturnType<
	typeof useAgentEditPostureActions
>;

export function useAgentEditPostureActions(
	ctx: AgentEditBase &
		AgentEditFormState &
		AgentEditComposio &
		AgentEditLoaders &
		AgentEditHydrate &
		AgentEditSave
) {
	const {
		isNew,
		isBuiltIn,
		simpleEditor,
		agentId,
		editorMounted,
		activeRecordScope,
		recordScope,
		postureLoadedScope,
		effectiveAgentId,
		setLifecycleStatus,
		setScheduleEnabled,
		setSafetyProfile,
		setPostureError,
		target,
		posturePendingScope,
		recordReadGeneration,
		setPostureSaving,
		setExisting,
		reload,
		draftId,
		chatModel,
		setFormError,
		selectedUninstalledAgent,
		create,
		name,
		agentTitle,
		description,
		agentModel,
		agentModelEngine,
		acpCommand,
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
		setDraftId,
		capabilitiesHydratedRef,
		setHydrated,
	} = ctx;
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
	return { canPublish, savePosture, resolveAgentId, onAgentChanged };
}
