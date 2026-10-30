import { LockedIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import { useCallback, useMemo } from "react";
import type { VersionSource } from "@/src/components/versioning/VersionHistory.tsx";
import { useTitleBar } from "@/src/contexts/TitleBarContext.tsx";
import { useAssistantBuilder } from "@/src/hooks/useAssistantBuilder.ts";
import {
	createAgentVersion,
	fetchAgent,
	getAgentVersionSource,
	listAgentVersions,
	restoreAgentVersion,
} from "@/src/lib/api/agents.ts";
import type { AgentEditBase } from "./AgentEditPage-base.ts";
import type { AgentEditComposio } from "./AgentEditPage-composio.ts";
import type { AgentEditFormState } from "./AgentEditPage-form-state.ts";
import type { AgentEditHydrate } from "./AgentEditPage-hydrate.ts";
import type { AgentEditLoaders } from "./AgentEditPage-loaders.ts";
import { AGENT_OWN_VOICE_PROFILE } from "./AgentEditPage-options.ts";
import type { AgentEditPostureActions } from "./AgentEditPage-posture-actions.ts";
import type { AgentEditSave } from "./AgentEditPage-save.ts";

export type AgentEditVersions = ReturnType<typeof useAgentEditVersions>;

export function useAgentEditVersions(
	ctx: AgentEditBase &
		AgentEditFormState &
		AgentEditComposio &
		AgentEditLoaders &
		AgentEditHydrate &
		AgentEditSave &
		AgentEditPostureActions
) {
	const {
		isNew,
		agentId,
		recordScope,
		target,
		editorMounted,
		activeRecordScope,
		loadedRecordScope,
		setExisting,
		capabilitiesHydratedRef,
		setHydrated,
		setFormError,
		existing,
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
		lifecycleStatus,
		isBuiltIn,
		isLocked,
		onAgentChanged,
		resolveAgentId,
	} = ctx;
	const tl = useLiteralMessages();
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
					? tl("Version restored, but the editor could not reload: {message}", {
							message: error.message,
						})
					: "Version restored, but the editor could not reload"
			);
		}
	}, [agentId, target, recordScope, tl]);

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
	return {
		agentVersionSource,
		handleAgentVersionRestored,
		currentAgentVersionValue,
		agentSnapshot,
		titleBarTitle,
	};
}
