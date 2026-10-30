import { useCallback, useEffect } from "react";
import {
	hydrateSkillSelection,
	hydrateToolSelection,
} from "@/src/lib/agent-capabilities.ts";
import { fetchAgent, fetchAgentTools } from "@/src/lib/api/agents.ts";
import { fetchMcpTools } from "@/src/lib/api/mcp.ts";
import { listSkills } from "@/src/lib/api/skills.ts";
import { fetchSpaces } from "@/src/lib/api/spaces.ts";
import type { AgentEditBase } from "./AgentEditPage-base.ts";
import type { AgentEditComposio } from "./AgentEditPage-composio.ts";
import type { AgentEditFormState } from "./AgentEditPage-form-state.ts";
import { FALLBACK_TOOLS } from "./AgentEditPage-options.ts";
import {
	agentPostureResources,
	postureResourceFor,
	releasePostureResource,
} from "./AgentEditPage-posture-resource.ts";

export type AgentEditLoaders = ReturnType<typeof useAgentEditLoaders>;

export function useAgentEditLoaders(
	ctx: AgentEditBase & AgentEditFormState & AgentEditComposio
) {
	const {
		setToolsLoading,
		target,
		setAvailableTools,
		setSkillsLoading,
		setAvailableSkills,
		capabilitiesHydratedRef,
		loadedRecordScope,
		setExisting,
		setHydrated,
		setPostureError,
		recordScope,
		isNew,
		toolsLoading,
		skillsLoading,
		existing,
		setSelectedTools,
		availableTools,
		setSelectedSkills,
		availableSkills,
		setAvailableSpaces,
		agentId,
		recordReadGeneration,
		postureLoadedScope,
		setRecordLoading,
		setFormError,
		editorMounted,
		activeRecordScope,
		setLifecycleStatus,
		setSafetyProfile,
		setScheduleEnabled,
		setAgentToolsData,
		effectiveAgentId,
		posturePendingScope,
		setPostureSaving,
		postureEndpoint,
		reload,
	} = ctx;
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
	return { loadRecord, retryPostureRead, reloadAfterOptimization };
}
