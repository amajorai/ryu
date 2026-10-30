// apps/desktop/src/components/panels/CoworkContextPanel.tsx
//
// The "Cowork" context rail (Codex / Claude-cowork style). A read-only summary of
// what the current run is doing and touching, surfaced beside the transcript:
//
//   • Plans     — every ACP/Pi plan snapshot, saved to the Artifacts Space and
//                 opened in the artifact viewer.
//   • Progress  — the agent's live plan (the latest `tool-TodoWrite` snapshot in
//                 the message stream), rendered as an in-place checklist.
//   • Artifacts — files the agent created this run (worktree diff, kind="added").
//   • Context   — the selected project folder + branch (workspace + git status).
//   • Changes   — the aggregate worktree diff with Apply / Open PR (DiffReviewPane).
//   • Sources   — chat attachments and connectors the run actually used
//                 (web search, GitHub, Gmail, MCP servers, apps, integrations,
//                 local files).
//   • Side chats— persisted `/btw` asides for this conversation (see Phase 2).
//
// Everything except Artifacts/Changes is derived from the live stream, so it is
// correct while a run unfolds but resets on reload (matching Codex's "Steps will
// show as the task unfolds." empty state). Artifacts/Changes come from Core's
// per-run worktree diff and survive reload.

import {
	BrowserIcon,
	File01Icon,
	GitBranchIcon,
	Globe02Icon,
	MessageQuestionIcon,
	PlusSignIcon,
	Robot01Icon,
	Target02Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffReviewPane } from "@/src/components/chat/DiffReviewPane.tsx";
import {
	invalidateWorktreeDiff,
	useWorktreeDiff,
} from "@/src/hooks/useGitStatus.ts";
import type { BtwEntry } from "@/src/lib/api/btw.ts";
import { deleteBtw, listBtw } from "@/src/lib/api/btw.ts";
import type { FileSummary } from "@/src/lib/api/git.ts";
import { extractArtifacts } from "@/src/lib/live-artifact-extractor.ts";
import { deriveTodoProgress } from "@/src/lib/todo-progress.ts";
import {
	type ContextSectionItem,
	ContextSections,
} from "./cowork-context/context-sections.tsx";
import {
	PlansList,
	RenderedArtifactsList,
	SubagentsList,
} from "./cowork-context/cowork-lists.tsx";
import {
	FileRow,
	OverflowRow,
	ProgressSection,
	SectionActionButton,
	SectionIcon,
	SectionTitle,
	SourcesList,
} from "./cowork-context/cowork-rows.tsx";
import { extractSources } from "./cowork-context/cowork-sources.ts";
import { extractSubagents } from "./cowork-context/cowork-subagents.ts";
import type { CoworkContextPanelProps } from "./cowork-context/cowork-types.ts";
import { SideChatsList } from "./cowork-context/side-chats-list.tsx";

export { SubagentActivityChips } from "./cowork-context/cowork-lists.tsx";
export { SectionTitle } from "./cowork-context/cowork-rows.tsx";
export { extractSources } from "./cowork-context/cowork-sources.ts";
export {
	extractSubagents,
	type SubagentSummary,
	subagentTaskTitle,
} from "./cowork-context/cowork-subagents.ts";
export type {
	CoworkContextPanelProps,
	CoworkPlanTodo,
	DerivedSource,
	SourceItem,
} from "./cowork-context/cowork-types.ts";
export {
	SourcesWorkspacePanel,
	SubagentsWorkspacePanel,
} from "./cowork-context/cowork-workspace-panels.tsx";

// ── Main panel ──────────────────────────────────────────────────────────────────

export function CoworkContextPanel({
	messages,
	runId,
	target,
	chatStatus,
	planArtifacts,
	onOpenArtifact,
	onOpenSideChat,
	onOpenSubagent,
	onOpenSources,
	onOpenSubagents,
	sideChatsRefreshKey,
	sideChatsEnabled = true,
	leadingItems,
	maxItemsPerSection,
	variant = "cards",
}: CoworkContextPanelProps) {
	const todos = useMemo(() => {
		const snapshot = deriveTodoProgress(messages);
		return (
			snapshot?.items.map(({ label, status }) => ({
				content: label,
				status,
			})) ?? []
		);
	}, [messages]);
	const sources = useMemo(() => extractSources(messages), [messages]);
	const subagents = useMemo(() => extractSubagents(messages), [messages]);
	const artifacts = useMemo(() => extractArtifacts(messages), [messages]);

	// Created files come from the run's worktree diff, read live from Core through
	// the shared query every git surface reads — the panel no longer keeps its own
	// copy, which is how its file list could disagree with the Changes section
	// rendered directly underneath it.
	const diff = useWorktreeDiff(target, runId);
	const createdFiles: FileSummary[] = useMemo(
		() => diff.files.filter((f) => f.kind === "added"),
		[diff.files]
	);
	const diffHasChanges = diff.has_changes;
	// Side chats (persisted /btw asides) — lifted here so the section can hide
	// itself entirely when there are none.
	const [sideChats, setSideChats] = useState<BtwEntry[]>([]);
	const [sideChatListError, setSideChatListError] = useState(false);
	const [sideChatRetryKey, setSideChatRetryKey] = useState(0);
	const [deletingSideChatIds, setDeletingSideChatIds] = useState<string[]>([]);
	const [sideChatDeleteError, setSideChatDeleteError] = useState<string | null>(
		null
	);
	const sideChatScope = JSON.stringify([
		target.url,
		target.token,
		target.userJwt,
		runId,
		sideChatsEnabled,
	]);
	const sideChatScopeRef = useRef(sideChatScope);
	sideChatScopeRef.current = sideChatScope;
	const pendingSideChatDeletes = useRef(new Set<string>());
	const sideChatMutationRevision = useRef(0);

	const targetUrlRef = useRef(target);
	targetUrlRef.current = target;

	// A turn that just finished has written its files: invalidate so the diff is
	// re-read once, at the transition, instead of on a timer. `chatStatus` is a
	// TRIGGER, not something the body reads — it only flips on turn transitions
	// (submitted/streaming/ready), never per stream tick.
	useEffect(() => {
		if (runId) {
			invalidateWorktreeDiff(runId);
		}
	}, [runId, chatStatus]);

	useEffect(() => {
		setSideChats([]);
		setSideChatListError(false);
		setDeletingSideChatIds([]);
		setSideChatDeleteError(null);
	}, [sideChatScope]);

	useEffect(() => {
		if (!(sideChatsEnabled && runId)) {
			setSideChats([]);
			return;
		}
		const controller = new AbortController();
		const mutationRevision = sideChatMutationRevision.current;
		setSideChatListError(false);
		listBtw(targetUrlRef.current, runId, controller.signal)
			.then((list) => {
				if (
					!controller.signal.aborted &&
					sideChatMutationRevision.current === mutationRevision
				) {
					setSideChats(list);
				}
			})
			.catch(() => {
				if (
					!controller.signal.aborted &&
					sideChatMutationRevision.current === mutationRevision
				) {
					setSideChatListError(true);
				}
			});
		return () => controller.abort();
		// `sideChatsRefreshKey` is bumped by the composer after a `/btw` aside is
		// persisted; without it the new aside never appears until the run changes.
	}, [
		runId,
		sideChatsEnabled,
		sideChatsRefreshKey,
		sideChatRetryKey,
		target.url,
		target.token,
		target.userJwt,
	]);

	const handleDeleteSideChat = useCallback(async (id: string) => {
		const scope = sideChatScopeRef.current;
		const pendingKey = `${scope}:${id}`;
		if (pendingSideChatDeletes.current.has(pendingKey)) {
			return;
		}
		pendingSideChatDeletes.current.add(pendingKey);
		setDeletingSideChatIds((previous) => [...previous, id]);
		setSideChatDeleteError(null);
		try {
			await deleteBtw(targetUrlRef.current, id);
			if (sideChatScopeRef.current === scope) {
				sideChatMutationRevision.current += 1;
				setSideChatListError(false);
				setSideChats((previous) => previous.filter((entry) => entry.id !== id));
			}
		} catch {
			if (sideChatScopeRef.current === scope) {
				setSideChatDeleteError("Could not delete side chat. Try again.");
			}
		} finally {
			pendingSideChatDeletes.current.delete(pendingKey);
			if (sideChatScopeRef.current === scope) {
				setDeletingSideChatIds((previous) =>
					previous.filter((pendingId) => pendingId !== id)
				);
			}
		}
	}, []);

	// One flush list of disclosures for the whole panel. `leadingItems` (the pinned card's
	// Environment section) go first; each derived section is only added when it
	// has something to show, so empty sections disappear rather than showing a
	// hint. The project/branch/commit summary lives in leadingItems now, not
	// here (see PinnedSummaryPanel).
	const summary = variant === "summary";
	const items: ContextSectionItem[] = (leadingItems ?? []).map((item) =>
		summary ? { ...item, icon: undefined } : item
	);

	if (planArtifacts && planArtifacts.length > 0) {
		items.push({
			id: "plans",
			icon: summary ? undefined : <SectionIcon icon={File01Icon} />,
			title: <SectionTitle count={planArtifacts.length} title="Plans" />,
			description: <PlansList onOpen={onOpenArtifact} plans={planArtifacts} />,
		});
	}

	if (todos.length > 0) {
		items.push({
			id: "progress",
			icon: summary ? undefined : <SectionIcon icon={Target02Icon} />,
			title: <SectionTitle count={todos.length} title="Progress" />,
			description: (
				<ProgressSection
					chatStatus={chatStatus}
					limit={maxItemsPerSection}
					todos={todos}
				/>
			),
		});
	}

	if (createdFiles.length > 0) {
		items.push({
			id: "artifacts",
			icon: summary ? undefined : <SectionIcon icon={PlusSignIcon} />,
			title: <SectionTitle count={createdFiles.length} title="Artifacts" />,
			description: (
				<div className="flex flex-col">
					{createdFiles.slice(0, maxItemsPerSection).map((file) => (
						<FileRow file={file} key={file.path} />
					))}
					{maxItemsPerSection !== undefined &&
						createdFiles.length > maxItemsPerSection && (
							<ul>
								<OverflowRow
									count={createdFiles.length - maxItemsPerSection}
									label="files"
								/>
							</ul>
						)}
				</div>
			),
		});
	}

	if (runId && diffHasChanges) {
		items.push({
			id: "changes",
			icon: summary ? undefined : <SectionIcon icon={GitBranchIcon} />,
			title: <SectionTitle count={diff.files.length} title="Changes" />,
			description: <DiffReviewPane runId={runId} target={target} />,
		});
	}

	if (artifacts.length > 0) {
		items.push({
			id: "rendered-artifacts",
			icon: summary ? undefined : <SectionIcon icon={BrowserIcon} />,
			title: (
				<SectionTitle count={artifacts.length} title="Rendered artifacts" />
			),
			description: (
				<RenderedArtifactsList
					artifacts={artifacts}
					limit={maxItemsPerSection}
					onOpen={onOpenArtifact}
				/>
			),
		});
	}

	if (sources.length > 0) {
		items.push({
			id: "sources",
			icon: summary ? undefined : <SectionIcon icon={Globe02Icon} />,
			action:
				summary && onOpenSources ? (
					<SectionActionButton
						label="Open all sources"
						onClick={onOpenSources}
					/>
				) : undefined,
			title: <SectionTitle count={sources.length} title="Sources" />,
			description: (
				<SourcesList
					limit={maxItemsPerSection}
					onShowAll={onOpenSources}
					sources={sources}
				/>
			),
		});
	}

	if (subagents.length > 0) {
		items.push({
			id: "subagents",
			icon: summary ? undefined : <SectionIcon icon={Robot01Icon} />,
			action:
				summary && onOpenSubagents ? (
					<SectionActionButton
						label="Open all subagents"
						onClick={onOpenSubagents}
					/>
				) : undefined,
			title: <SectionTitle count={subagents.length} title="Subagents" />,
			description: (
				<SubagentsList
					limit={maxItemsPerSection}
					onOpen={onOpenSubagent}
					onShowAll={onOpenSubagents}
					subagents={subagents}
				/>
			),
		});
	}

	if (
		sideChatsEnabled &&
		runId &&
		(sideChats.length > 0 || sideChatListError)
	) {
		items.push({
			id: "side-chats",
			icon: summary ? undefined : <SectionIcon icon={MessageQuestionIcon} />,
			title: <SectionTitle count={sideChats.length} title="Side chats" />,
			description: (
				<div>
					<SideChatsList
						deletingIds={deletingSideChatIds}
						entries={sideChats}
						limit={maxItemsPerSection}
						onDelete={handleDeleteSideChat}
						onOpen={onOpenSideChat}
					/>
					{sideChatListError && (
						<div className="flex items-center gap-2 py-1 text-xs">
							<p role="alert">Could not load side chats.</p>
							<Button
								onClick={() => setSideChatRetryKey((key) => key + 1)}
								size="xs"
								variant="ghost-muted"
							>
								Retry side chats
							</Button>
						</div>
					)}
					{sideChatDeleteError && (
						<p className="py-1 text-status-destructive text-xs" role="alert">
							{sideChatDeleteError}
						</p>
					)}
				</div>
			),
		});
	}

	if (items.length === 0) {
		return null;
	}

	return (
		<div
			className={cn("h-full overflow-y-auto", summary ? "p-0" : "px-3 py-1")}
			data-testid={summary ? "pinned-summary" : "cowork-context-panel"}
		>
			<ContextSections defaultValue={items[0]?.id ?? null} items={items} />
		</div>
	);
}
