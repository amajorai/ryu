import {
	type Agent,
	type AgentIdentityMode,
	type AgentInput,
	bumpPatchVersion,
	createAgent,
	launchCheck,
	updateAgent,
} from "@ryuhq/core-client/agents";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { samplingConfigSchema } from "@ryuhq/core-client/inference";
import {
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
	useCallback,
} from "react";
import { RYU_ENGINE_ID } from "../../core/agentIdentity.ts";
import { tf } from "../../i18n/translate.ts";
import type { JsonObject } from "../../overlays/settings/inference.tsx";
import type { useToast } from "../../ui/toast.tsx";
import { errText } from "./index-shared.tsx";

/** The agent editor's save: a launch check, then create or update in Core. */
export function useAgentSave({
	target,
	agentId,
	isNew,
	name,
	title,
	engine,
	model,
	description,
	systemPrompt,
	personaDisplayName,
	personaTone,
	orchestrator,
	canCreateAgents,
	sampling,
	samplingTouched,
	toolAllowlist,
	skillAllowlist,
	identityMode,
	accountAccess,
	accountAccessTouched,
	existing,
	notify,
	onClose,
	savingRef,
	setError,
	setSaving,
}: {
	accountAccess: string[] | null;
	accountAccessTouched: boolean;
	agentId: string;
	canCreateAgents: boolean | null;
	description: string;
	engine: string;
	existing: Agent | null;
	identityMode: AgentIdentityMode;
	isNew: boolean;
	model: string;
	name: string;
	notify: ReturnType<typeof useToast>["notify"];
	onClose: () => void;
	orchestrator: boolean | null;
	personaDisplayName: string;
	personaTone: string;
	sampling: JsonObject;
	samplingTouched: boolean;
	savingRef: MutableRefObject<boolean>;
	setError: Dispatch<SetStateAction<string | null>>;
	setSaving: Dispatch<SetStateAction<boolean>>;
	skillAllowlist: string[];
	systemPrompt: string;
	target: ApiTarget;
	title: string;
	toolAllowlist: string[];
}) {
	return useCallback(() => {
		if (savingRef.current) {
			return;
		}
		if (existing?.locked) {
			setError("This agent is locked. Unlock it before saving changes.");
			return;
		}
		if (name.trim().length === 0) {
			setError("Name is required");
			return;
		}
		const engineValue = isNew
			? engine.trim() || null
			: (existing?.engine ?? null);
		const input: AgentInput = {
			name: name.trim(),
			title: title.trim() || null,
			description: description.trim() || null,
			systemPrompt: systemPrompt.trim() || null,
			engine: engineValue,
			model: model.trim() || null,
			persona: {
				// Spreading the loaded persona retains avatar/style fields returned by
				// current Core versions even when an older client type does not expose
				// them. Editing the name or tone must not clear the saved avatar.
				...existing?.persona,
				display_name: personaDisplayName.trim() || null,
				tone:
					personaTone.trim() && personaTone.trim() !== "neutral"
						? personaTone.trim()
						: null,
			},
			tools: toolAllowlist,
			skills: skillAllowlist,
			composioActions: existing?.composioActions ?? [],
			orchestrator,
			canCreateAgents,

			version: existing?.version
				? bumpPatchVersion(existing.version)
				: undefined,
		};
		if (samplingTouched || existing?.inference) {
			const parsedSampling = samplingConfigSchema.safeParse(sampling);
			if (!parsedSampling.success) {
				setError(
					"Sampling settings contain invalid generation values. Correct them before saving."
				);
				return;
			}
			input.inference = parsedSampling.data;
		}
		if (isNew || identityMode !== existing?.identityMode) {
			input.identityMode = identityMode;
		}
		// `null` is meaningful: it clears the allowlist to "no limit".
		if (accountAccessTouched) {
			input.accountAccess = accountAccess;
		}
		setSaving(true);
		setError(null);
		// Ask Core whether the engine would start under this identity and account
		// access, as the desktop editor does before it enables Save. A check that
		// cannot be made does not block the save; Core still checks at launch.
		const check = engineValue
			? launchCheck(target, {
					accountAccess,
					agentId: isNew ? null : agentId,
					engine: engineValue,
					identityMode,
				}).catch(() => null)
			: Promise.resolve(null);
		check
			.then((result) => {
				if (result && !result.launchable) {
					const reason =
						result.reason ?? "Core says this agent's engine would not start.";
					const hint =
						engineValue === RYU_ENGINE_ID
							? ""
							: isNew
								? ` ${tf("Set the engine to {engineId} to run it on Ryu instead.", { engineId: RYU_ENGINE_ID })}`
								: ` ${tf("Change how it works or its account access, or switch its engine with '{command}'.", { command: `ryu-cli agents identity ${agentId} ${identityMode} --engine ${RYU_ENGINE_ID}` })}`;
					throw new Error(`${reason} Nothing was saved.${hint}`);
				}
				return isNew
					? createAgent(target, input)
					: updateAgent(target, agentId, input);
			})
			.then(() => {
				notify(isNew ? "Agent created" : "Agent saved", "success");
				onClose();
			})
			.catch((err) => setError(errText(err)))
			.finally(() => setSaving(false));
	}, [
		target,
		agentId,
		isNew,
		name,
		title,
		engine,
		model,
		description,
		systemPrompt,
		personaDisplayName,
		personaTone,
		orchestrator,
		canCreateAgents,
		sampling,
		samplingTouched,
		toolAllowlist,
		skillAllowlist,
		identityMode,
		accountAccess,
		accountAccessTouched,
		existing,
		notify,
		onClose,
	]);
}
