// apps/desktop/src/components/memory/MemoryLibrary.tsx
//
// The Memory section of the unified Library (`/library/memory`): browse, filter,
// search, create, edit, and delete long-term memories with their metadata (scope
// level, category, importance, when-to-use, tags). A first-class management
// surface over Core's `/api/memory` endpoints, distinct from the Settings →
// Memory tab (which owns the recall/index toggles), so users can curate what Ryu
// durably remembers.

import {
	Add01Icon,
	AiBrain01Icon,
	GitBranchIcon,
	MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	STORE_LOAD_ERROR_SENTENCE,
	StoreErrorDetails,
} from "@ryu/blocks/desktop/store-error-details.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Skeleton, SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	deleteMemory,
	getMemoryGraph,
	listMemories,
	type Memory,
	type MemoryCategory,
	type MemoryGraphSnapshot,
	type MemoryScope,
	memoryCategoryLabels,
	memoryScopeLabels,
} from "@/src/lib/api/memory.ts";
import { MemoryDeleteDialog } from "./MemoryDeleteDialog.tsx";
import { MemoryDreamReview } from "./MemoryDreamReview.tsx";
import { MemoryEditor } from "./MemoryEditor.tsx";
import {
	MemoryGitSourceCard,
	storedMemoryGitRoot,
} from "./MemoryGitSourceCard.tsx";
import { MemoryGraph } from "./MemoryGraph.tsx";
import { MemoryLibraryFilters } from "./MemoryLibraryFilters.tsx";
import {
	ALL,
	MemoryRow,
	type MemoryView,
	MemoryViewNav,
} from "./MemoryLibraryParts.tsx";
import { MemoryReflectDashboard } from "./MemoryReflectDashboard.tsx";

export type { MemoryView } from "./MemoryLibraryParts.tsx";

export function MemoryLibrary({
	initialView = "library",
}: {
	initialView?: MemoryView;
} = {}) {
	const tl = useLiteralMessages();
	const activeNode = useActiveNode();
	// Both vocabularies come from the one shared table; which one shows is the
	// app-wide "Friendly names" toggle.
	const [friendly] = useFriendlyMode();
	const scopeLabels = memoryScopeLabels(friendly);
	const categoryLabels = memoryCategoryLabels(friendly);

	const target: ApiTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token]
	);
	const [view, setView] = useState<MemoryView>(initialView);
	useEffect(() => setView(initialView), [initialView]);

	const [memories, setMemories] = useState<Memory[]>([]);
	const [graph, setGraph] = useState<MemoryGraphSnapshot | null>(null);
	const [graphLoading, setGraphLoading] = useState(false);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);

	// Filters.
	const [query, setQuery] = useState("");
	const [scopeFilter, setScopeFilter] = useState<MemoryScope | typeof ALL>(ALL);
	const [categoryFilter, setCategoryFilter] = useState<
		MemoryCategory | typeof ALL
	>(ALL);
	const [tagFilter, setTagFilter] = useState<string>(ALL);

	// Editor + delete-confirm state.
	const [editorOpen, setEditorOpen] = useState(false);
	const [editing, setEditing] = useState<Memory | null>(null);
	const [pendingDelete, setPendingDelete] = useState<Memory | null>(null);
	// The Git source lives behind the header's `⋯`; the page shows one status
	// line only when a folder is bound.
	const [gitOpen, setGitOpen] = useState(false);
	const gitRoot = storedMemoryGitRoot();

	const reload = useCallback(() => {
		let cancelled = false;
		setLoading(true);
		setLoadError(null);
		listMemories(target)
			.then((list) => {
				if (!cancelled) {
					setMemories(list);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setLoadError("Couldn't load memories. Please try again.");
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target]);

	useEffect(() => reload(), [reload]);

	const reloadGraph = useCallback(() => {
		let cancelled = false;
		setGraphLoading(true);
		getMemoryGraph(target, { maxEdges: 320, maxNodes: 160 })
			.then((next) => {
				if (!cancelled) {
					setGraph(next);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setGraph({
						edges: [],
						memoryCount: 0,
						nodes: [],
						truncated: false,
					});
				}
			})
			.finally(() => {
				if (!cancelled) {
					setGraphLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target]);

	useEffect(() => {
		if (view === "graph") {
			return reloadGraph();
		}
		return undefined;
	}, [reloadGraph, view]);

	// Merge a created/updated memory into the list in place (id match = update).
	const handleSaved = useCallback((saved: Memory) => {
		setMemories((prev) => {
			const idx = prev.findIndex((m) => m.id === saved.id);
			if (idx === -1) {
				return [saved, ...prev];
			}
			const next = [...prev];
			next[idx] = saved;
			return next;
		});
	}, []);

	const openNew = () => {
		setEditing(null);
		setEditorOpen(true);
	};

	const openEdit = (memory: Memory) => {
		setEditing(memory);
		setEditorOpen(true);
	};

	const confirmDelete = async () => {
		const victim = pendingDelete;
		setPendingDelete(null);
		if (!victim) {
			return;
		}
		try {
			await deleteMemory(target, victim.id);
			setMemories((prev) => prev.filter((m) => m.id !== victim.id));
			toast.success("Memory deleted");
		} catch {
			toast.error("Couldn't delete that memory", {
				description: "Please check your connection and try again.",
			});
		}
	};

	// The set of tags actually present, so the tag filter only offers real ones.
	const presentTags = useMemo(() => {
		const set = new Set<string>();
		for (const m of memories) {
			for (const tag of m.tags) {
				set.add(tag);
			}
		}
		return [...set].sort((a, b) => a.localeCompare(b));
	}, [memories]);

	// Labels carry the "#" the dropdown rows show, so trigger and list agree.
	const tagFilterItems = useMemo(
		() => [
			{ label: "All tags", value: ALL },
			...presentTags.map((tag) => ({ label: `#${tag}`, value: tag })),
		],
		[presentTags]
	);

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return memories.filter((m) => {
			if (scopeFilter !== ALL && m.scope !== scopeFilter) {
				return false;
			}
			if (categoryFilter !== ALL && m.category !== categoryFilter) {
				return false;
			}
			if (tagFilter !== ALL && !m.tags.includes(tagFilter)) {
				return false;
			}
			if (q) {
				const inContent = m.content.toLowerCase().includes(q);
				const inWhen = m.whenToUse?.toLowerCase().includes(q) ?? false;
				const inTags = m.tags.some((t) => t.toLowerCase().includes(q));
				if (!(inContent || inWhen || inTags)) {
					return false;
				}
			}
			return true;
		});
	}, [memories, query, scopeFilter, categoryFilter, tagFilter]);

	const gitDialog = (
		<Dialog onOpenChange={setGitOpen} open={gitOpen}>
			<DialogContent className="sm:max-w-lg">
				<DialogTitle className="sr-only">Git-backed memory</DialogTitle>
				<MemoryGitSourceCard
					memories={memories}
					onImported={reload}
					target={target}
				/>
			</DialogContent>
		</Dialog>
	);

	const editorAndDelete = (
		<>
			<MemoryEditor
				memory={editing}
				onClose={() => setEditorOpen(false)}
				onSaved={handleSaved}
				open={editorOpen}
				target={target}
			/>
			<MemoryDeleteDialog
				onConfirm={confirmDelete}
				pendingDelete={pendingDelete}
				setPendingDelete={setPendingDelete}
			/>
		</>
	);

	const header = (
		<div className="flex flex-col gap-4">
			<div className="flex items-start justify-between gap-3">
				<PageHeader
					size="app"
					subtitle="Durable facts Ryu recalls across your conversations."
					title="Memory"
				/>
				<div className="flex shrink-0 items-center gap-1">
					<Button onClick={openNew} size="sm" variant="outline">
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						New memory
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									aria-label="More memory actions"
									size="icon-sm"
									variant="ghost-muted"
								>
									<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
								</Button>
							}
						/>
						<DropdownMenuContent align="end" className="min-w-48">
							<DropdownMenuItem onClick={() => setGitOpen(true)}>
								<HugeiconsIcon className="size-4" icon={GitBranchIcon} />
								Git source…
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
			<MemoryViewNav onChange={setView} value={view} />
			{gitRoot ? (
				<button
					className="flex min-w-0 items-center gap-1.5 self-start text-muted-foreground text-xs hover:text-foreground"
					onClick={() => setGitOpen(true)}
					type="button"
				>
					<HugeiconsIcon className="size-3.5 shrink-0" icon={GitBranchIcon} />
					<span className="truncate">
						{tl("Git source · {root}", { root: gitRoot })}
					</span>
				</button>
			) : null}
		</div>
	);

	if (view !== "library") {
		return (
			<div className="relative flex h-full flex-col overflow-hidden">
				<div className="scroll-fade min-h-0 flex-1 overflow-y-auto px-6 pt-6 pb-24">
					<div className="mx-auto flex max-w-3xl flex-col gap-6">
						{header}
						{view === "graph" ? (
							<div className="h-[min(70vh,680px)] min-h-[460px] overflow-hidden rounded-xl border border-border">
								{graphLoading || !graph ? (
									<Skeleton
										aria-label="Loading graph"
										className="size-full"
										role="status"
									/>
								) : (
									<MemoryGraph graph={graph} />
								)}
							</div>
						) : view === "dream" ? (
							<MemoryDreamReview target={target} />
						) : (
							<MemoryReflectDashboard target={target} />
						)}
					</div>
				</div>
				{gitDialog}
				{editorAndDelete}
			</div>
		);
	}

	return (
		<div className="relative flex h-full flex-col overflow-hidden">
			<div className="scroll-fade min-h-0 flex-1 overflow-y-auto px-6 pt-6 pb-24">
				<div className="mx-auto flex max-w-3xl flex-col gap-4">
					{header}

					<MemoryLibraryFilters
						categoryFilter={categoryFilter}
						categoryLabels={categoryLabels}
						presentTags={presentTags}
						query={query}
						scopeFilter={scopeFilter}
						scopeLabels={scopeLabels}
						setCategoryFilter={setCategoryFilter}
						setQuery={setQuery}
						setScopeFilter={setScopeFilter}
						setTagFilter={setTagFilter}
						tagFilter={tagFilter}
						tagFilterItems={tagFilterItems}
					/>

					{loading ? (
						<SkeletonRows spacing="review" />
					) : loadError ? (
						<Empty className="py-12">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<HugeiconsIcon icon={AiBrain01Icon} />
								</EmptyMedia>
								<EmptyTitle>Couldn't load memories</EmptyTitle>
								<EmptyDescription>{STORE_LOAD_ERROR_SENTENCE}</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
								<Button onClick={reload} size="sm" variant="outline">
									Try again
								</Button>
								<StoreErrorDetails message={loadError} />
							</EmptyContent>
						</Empty>
					) : visible.length === 0 ? (
						<Empty className="py-12">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<HugeiconsIcon icon={AiBrain01Icon} />
								</EmptyMedia>
								<EmptyTitle>
									{memories.length === 0 ? "No memories yet" : "No matches"}
								</EmptyTitle>
								<EmptyDescription>
									{memories.length === 0
										? "Add a fact Ryu should remember across conversations."
										: "No memories match your filters."}
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<ul className="flex flex-col">
							{visible.map((memory) => (
								<MemoryRow
									key={memory.id}
									memory={memory}
									onDelete={setPendingDelete}
									onEdit={openEdit}
								/>
							))}
						</ul>
					)}
				</div>
			</div>
			{gitDialog}
			{editorAndDelete}
		</div>
	);
}

/** Route adapters keep the registry's JSX-free route table prop-free. */
export function MemoryDreamPage() {
	return <MemoryLibrary initialView="dream" />;
}

export function MemoryReflectPage() {
	return <MemoryLibrary initialView="reflect" />;
}
