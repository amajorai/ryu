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
	Delete01Icon,
	PencilEdit01Icon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	type ChangeEvent,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	deleteMemory,
	listMemories,
	MEMORY_CATEGORIES,
	MEMORY_CATEGORY_LABELS,
	MEMORY_SCOPE_LABELS,
	MEMORY_SCOPES,
	type Memory,
	type MemoryCategory,
	type MemoryScope,
} from "@/src/lib/api/memory.ts";
import { MemoryEditor } from "./MemoryEditor.tsx";

const ALL = "all";

/** A single memory row: content, metadata badges, tags, and hover actions. */
function MemoryRow({
	memory,
	onDelete,
	onEdit,
}: {
	memory: Memory;
	onDelete: (memory: Memory) => void;
	onEdit: (memory: Memory) => void;
}) {
	return (
		<li className="group/mem rounded-lg border border-border/60 bg-muted/30 p-4">
			<div className="flex items-start justify-between gap-3">
				<p className="min-w-0 flex-1 whitespace-pre-wrap text-foreground text-sm">
					{memory.content}
				</p>
				<div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/mem:opacity-100">
					<Button
						aria-label="Edit memory"
						onClick={() => onEdit(memory)}
						size="icon"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={PencilEdit01Icon} />
					</Button>
					<Button
						aria-label="Delete memory"
						className="text-destructive hover:text-destructive"
						onClick={() => onDelete(memory)}
						size="icon"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Delete01Icon} />
					</Button>
				</div>
			</div>

			{memory.whenToUse ? (
				<p className="mt-2 text-muted-foreground text-xs">
					<span className="font-medium">When to use: </span>
					{memory.whenToUse}
				</p>
			) : null}

			<div className="mt-3 flex flex-wrap items-center gap-1.5">
				<Badge variant="secondary">{MEMORY_SCOPE_LABELS[memory.scope]}</Badge>
				<Badge variant="outline">
					{MEMORY_CATEGORY_LABELS[memory.category]}
				</Badge>
				<Badge variant="outline">Importance {memory.importance}</Badge>
				{memory.tags.map((tag) => (
					<Badge key={tag} variant="secondary">
						#{tag}
					</Badge>
				))}
			</div>
		</li>
	);
}

export function MemoryLibrary() {
	const activeNode = useActiveNode();
	const target: ApiTarget = useMemo(
		() => ({ url: activeNode.url, token: activeNode.token ?? null }),
		[activeNode.url, activeNode.token]
	);

	const [memories, setMemories] = useState<Memory[]>([]);
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

	return (
		<div className="relative flex h-full flex-col overflow-hidden">
			<div className="min-h-0 flex-1 overflow-y-auto px-4 pt-12 pb-24">
				<div className="mx-auto flex max-w-3xl flex-col gap-4">
					<div className="flex items-center justify-between gap-3">
						<div>
							<h1 className="font-semibold text-lg">Memory</h1>
							<p className="text-muted-foreground text-sm">
								Durable facts Ryu recalls across your conversations.
							</p>
						</div>
						<Button onClick={openNew}>
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							New memory
						</Button>
					</div>

					{/* Filters */}
					<div className="flex flex-wrap items-center gap-2">
						<div className="relative min-w-48 flex-1">
							<HugeiconsIcon
								className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
								icon={Search01Icon}
							/>
							<Input
								aria-label="Search memories"
								className="pl-9"
								onChange={(e: ChangeEvent<HTMLInputElement>) =>
									setQuery(e.target.value)
								}
								placeholder="Search memories…"
								value={query}
							/>
						</div>
						<Select
							onValueChange={(v) =>
								setScopeFilter(v as MemoryScope | typeof ALL)
							}
							value={scopeFilter}
						>
							<SelectTrigger aria-label="Filter by scope">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ALL}>All scopes</SelectItem>
								{MEMORY_SCOPES.map((s) => (
									<SelectItem key={s} value={s}>
										{MEMORY_SCOPE_LABELS[s]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Select
							onValueChange={(v) =>
								setCategoryFilter(v as MemoryCategory | typeof ALL)
							}
							value={categoryFilter}
						>
							<SelectTrigger aria-label="Filter by category">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ALL}>All categories</SelectItem>
								{MEMORY_CATEGORIES.map((c) => (
									<SelectItem key={c} value={c}>
										{MEMORY_CATEGORY_LABELS[c]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{presentTags.length > 0 ? (
							<Select
								onValueChange={(v) => setTagFilter(v as string)}
								value={tagFilter}
							>
								<SelectTrigger aria-label="Filter by tag">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={ALL}>All tags</SelectItem>
									{presentTags.map((tag) => (
										<SelectItem key={tag} value={tag}>
											#{tag}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						) : null}
					</div>

					{/* Body */}
					{loading ? (
						<div className="flex justify-center py-16">
							<Spinner />
						</div>
					) : loadError ? (
						<Empty className="py-12">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<HugeiconsIcon icon={AiBrain01Icon} />
								</EmptyMedia>
								<EmptyTitle>Couldn't load memories</EmptyTitle>
								<EmptyDescription>{loadError}</EmptyDescription>
							</EmptyHeader>
							<Button onClick={reload} variant="outline">
								Try again
							</Button>
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
										? "Add a memory to give Ryu durable context to recall later."
										: "No memories match your filters."}
								</EmptyDescription>
							</EmptyHeader>
							{memories.length === 0 ? (
								<Button onClick={openNew}>
									<HugeiconsIcon className="size-4" icon={Add01Icon} />
									New memory
								</Button>
							) : null}
						</Empty>
					) : (
						<ul className="flex flex-col gap-2">
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

			<MemoryEditor
				memory={editing}
				onClose={() => setEditorOpen(false)}
				onSaved={handleSaved}
				open={editorOpen}
				target={target}
			/>

			<AlertDialog
				onOpenChange={(o) => {
					if (!o) {
						setPendingDelete(null);
					}
				}}
				open={pendingDelete !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete this memory?</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingDelete
								? `"${pendingDelete.content.slice(0, 120)}${
										pendingDelete.content.length > 120 ? "…" : ""
									}" will be permanently removed. This cannot be undone.`
								: ""}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={confirmDelete} variant="destructive">
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
