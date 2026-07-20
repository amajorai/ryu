// apps/desktop/src/components/memory/MemoryEditor.tsx
//
// Create/edit dialog for a long-term memory. Exposes every editable field —
// content, scope level (+ scope id for project scope), category, importance
// (1–5), when-to-use, and tags — and persists via the memory client. Shared by
// the Memory library for both "New memory" and "Edit" so the form lives once.

import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { Textarea } from "@ryu/ui/components/textarea";
import { type ChangeEvent, type FormEvent, useMemo, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	createMemory,
	MEMORY_CATEGORIES,
	MEMORY_CATEGORY_LABELS,
	MEMORY_SCOPE_LABELS,
	MEMORY_SCOPES,
	type Memory,
	type MemoryCategory,
	type MemoryScope,
	type MemoryUpdate,
	updateMemory,
} from "@/src/lib/api/memory.ts";

/** Importance levels (1..5), highest first, with a plain-language label. */
const IMPORTANCE_LEVELS: { value: number; label: string }[] = [
	{ value: 5, label: "5 — Critical" },
	{ value: 4, label: "4 — High" },
	{ value: 3, label: "3 — Normal" },
	{ value: 2, label: "2 — Low" },
	{ value: 1, label: "1 — Minimal" },
];

/** Parse the comma-separated tag input into a clean, de-duplicated list. */
function parseTags(raw: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of raw.split(",")) {
		const tag = part.trim();
		if (tag && !seen.has(tag)) {
			seen.add(tag);
			out.push(tag);
		}
	}
	return out;
}

export function MemoryEditor({
	memory,
	onClose,
	onSaved,
	open,
	target,
}: {
	/** The memory to edit, or null to create a new one. */
	memory: Memory | null;
	onClose: () => void;
	/** Called with the created/updated memory after a successful save. */
	onSaved: (saved: Memory) => void;
	open: boolean;
	target: ApiTarget;
}) {
	const isEditing = memory !== null;

	// Seed the form from the memory (edit) or sensible defaults (create). Keyed on
	// the memory id + open so reopening the dialog for a different row re-seeds.
	const seed = useMemo(
		() => ({
			content: memory?.content ?? "",
			scope: memory?.scope ?? ("user" as MemoryScope),
			scopeId: memory?.scopeId ?? "",
			category: memory?.category ?? ("other" as MemoryCategory),
			importance: memory?.importance ?? 3,
			whenToUse: memory?.whenToUse ?? "",
			tags: (memory?.tags ?? []).join(", "),
		}),
		[memory]
	);

	const [content, setContent] = useState(seed.content);
	const [scope, setScope] = useState<MemoryScope>(seed.scope);
	const [scopeId, setScopeId] = useState(seed.scopeId);
	const [category, setCategory] = useState<MemoryCategory>(seed.category);
	const [importance, setImportance] = useState(seed.importance);
	const [whenToUse, setWhenToUse] = useState(seed.whenToUse);
	const [tags, setTags] = useState(seed.tags);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Re-seed the fields whenever the dialog opens for a memory. The signature
	// folds in open/closed so closing always advances it — that way reopening the
	// SAME memory after a cancelled edit still re-seeds from the stored values
	// rather than showing the abandoned draft. "adjust state during render" (no
	// effect), matching the codebase's usePaged pattern.
	const [seededFor, setSeededFor] = useState<string | null>(null);
	const signature = `${open ? "open" : "closed"}:${memory?.id ?? "new"}`;
	if (seededFor !== signature) {
		setSeededFor(signature);
		setContent(seed.content);
		setScope(seed.scope);
		setScopeId(seed.scopeId);
		setCategory(seed.category);
		setImportance(seed.importance);
		setWhenToUse(seed.whenToUse);
		setTags(seed.tags);
		setError(null);
	}

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		const trimmedContent = content.trim();
		if (!trimmedContent) {
			return;
		}
		setBusy(true);
		setError(null);
		const trimmedScopeId = scopeId.trim();
		const trimmedWhenToUse = whenToUse.trim();
		const parsedTags = parseTags(tags);
		try {
			let saved: Memory;
			if (isEditing) {
				// Build a full patch — send null (not omit) for cleared optional fields
				// so an edit that removes a scope id / when-to-use actually clears it.
				const patch: MemoryUpdate = {
					content: trimmedContent,
					scope,
					scopeId:
						scope === "project" && trimmedScopeId ? trimmedScopeId : null,
					category,
					importance,
					whenToUse: trimmedWhenToUse ? trimmedWhenToUse : null,
					tags: parsedTags,
				};
				saved = await updateMemory(target, memory.id, patch);
			} else {
				saved = await createMemory(target, {
					content: trimmedContent,
					scope,
					scopeId:
						scope === "project" && trimmedScopeId ? trimmedScopeId : undefined,
					category,
					importance,
					whenToUse: trimmedWhenToUse || undefined,
					tags: parsedTags.length > 0 ? parsedTags : undefined,
				});
			}
			onSaved(saved);
			onClose();
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to save this memory."
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			onOpenChange={(next: boolean) => {
				if (!next) {
					onClose();
				}
			}}
			open={open}
		>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>
							{isEditing ? "Edit memory" : "New memory"}
						</DialogTitle>
						<DialogDescription>
							A memory is a durable fact Ryu can recall in future conversations.
						</DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-4 py-4">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="memory-content">Memory</Label>
							<Textarea
								id="memory-content"
								onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
									setContent(e.target.value)
								}
								placeholder="e.g. Prefers concise answers with code examples."
								rows={3}
								value={content}
							/>
						</div>

						<div className="grid grid-cols-2 gap-3">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="memory-scope">Scope</Label>
								<Select
									onValueChange={(v) => setScope(v as MemoryScope)}
									value={scope}
								>
									<SelectTrigger className="w-full" id="memory-scope">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{MEMORY_SCOPES.map((s) => (
											<SelectItem key={s} value={s}>
												{MEMORY_SCOPE_LABELS[s]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							<div className="flex flex-col gap-1.5">
								<Label htmlFor="memory-category">Category</Label>
								<Select
									onValueChange={(v) => setCategory(v as MemoryCategory)}
									value={category}
								>
									<SelectTrigger className="w-full" id="memory-category">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{MEMORY_CATEGORIES.map((c) => (
											<SelectItem key={c} value={c}>
												{MEMORY_CATEGORY_LABELS[c]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>

						{scope === "project" ? (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="memory-scope-id">Project id</Label>
								<Input
									id="memory-scope-id"
									onChange={(e: ChangeEvent<HTMLInputElement>) =>
										setScopeId(e.target.value)
									}
									placeholder="The project / folder this memory belongs to"
									value={scopeId}
								/>
							</div>
						) : null}

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="memory-importance">Importance</Label>
							<Select
								onValueChange={(v) => setImportance(Number(v))}
								value={String(importance)}
							>
								<SelectTrigger className="w-full" id="memory-importance">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{IMPORTANCE_LEVELS.map((level) => (
										<SelectItem key={level.value} value={String(level.value)}>
											{level.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="memory-when">When to use (optional)</Label>
							<Input
								id="memory-when"
								onChange={(e: ChangeEvent<HTMLInputElement>) =>
									setWhenToUse(e.target.value)
								}
								placeholder="e.g. When writing code, or discussing scheduling."
								value={whenToUse}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="memory-tags">Tags (optional)</Label>
							<Input
								id="memory-tags"
								onChange={(e: ChangeEvent<HTMLInputElement>) =>
									setTags(e.target.value)
								}
								placeholder="Comma-separated, e.g. work, scheduling"
								value={tags}
							/>
						</div>

						{error ? <p className="text-destructive text-sm">{error}</p> : null}
					</div>

					<DialogFooter>
						<Button onClick={onClose} type="button" variant="ghost">
							Cancel
						</Button>
						<Button disabled={busy || !content.trim()} type="submit">
							{busy ? <Spinner className="size-4" /> : null}
							{isEditing ? "Save changes" : "Create memory"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
