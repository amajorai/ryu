/* @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { request } from "@ryuhq/core-client/client";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { Card } from "@/components/ui/card.tsx";
import { TextInput } from "@/components/ui/text-input.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import {
	type CoreMemoryEntry,
	coreMemoryEntryResponseSchema,
	coreMemoryListResponseSchema,
	coreMemoryWriteResponseSchema,
} from "../../core/settings-response-codecs.ts";
import { tf, tr } from "../../i18n/translate.ts";

/** Core's existing /api/memory snake_case projection, also consumed by Desktop. */
type MemoryEntry = CoreMemoryEntry;
const memoryMetadataSchema = z.strictObject({
	scope: z.string().optional(),
	scope_id: z.string().nullable().optional(),
	category: z.string().optional(),
	importance: z.number().optional(),
	tags: z.array(z.string()).optional(),
	when_to_use: z.string().nullable().optional(),
});
type MemoryMetadata = z.infer<typeof memoryMetadataSchema>;
const memoryMetadataRecordSchema = z.record(z.string(), z.json());
const memoryMetadataKeySchema = memoryMetadataSchema.keyof();
const memoryMetadataKeys = memoryMetadataKeySchema.options;
interface Editor {
	content: string;
	id: string | null;
	metadata: string;
}

export function MemoryLibraryPanel({
	active,
	onBack,
	onEditingChange,
}: {
	active: boolean;
	onBack: () => void;
	onEditingChange: (editing: boolean) => void;
}) {
	const { target } = useCore();
	const { colors } = useTheme();
	const [entries, setEntries] = useState<MemoryEntry[]>([]);
	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const [row, setRow] = useState(0);
	const [editor, setEditor] = useState<Editor | null>(null);
	const [field, setField] = useState<"content" | "metadata">("content");
	const [deleting, setDeleting] = useState<MemoryEntry | null>(null);
	const [busy, setBusy] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const readList = useCallback(async () => {
		const result = await request(
			target,
			"/api/memory?limit=500",
			{},
			coreMemoryListResponseSchema
		);
		if (!Array.isArray(result.memories)) {
			throw new Error("Core returned an invalid memory list.");
		}
		setEntries(result.memories);
		setLoaded(true);
		return result.memories;
	}, [target]);
	const reload = useCallback(async () => {
		setBusy(true);
		setError(null);
		setNotice(null);
		setLoaded(false);
		setEntries([]);
		try {
			await readList();
		} catch (cause) {
			setError(
				tf("Couldn't load memories: {error}. Press r to retry.", {
					error: cause instanceof Error ? cause.message : String(cause),
				})
			);
		} finally {
			setBusy(false);
		}
	}, [readList]);
	useEffect(() => {
		if (active) {
			void reload();
		}
	}, [active, reload]);
	useEffect(() => {
		onEditingChange(searching || editor !== null);
		return () => onEditingChange(false);
	}, [editor, searching, onEditingChange]);
	const filtered = entries.filter((entry) =>
		[entry.content, entry.scope, entry.category, ...entry.tags]
			.join(" ")
			.toLowerCase()
			.includes(query.toLowerCase())
	);
	const selected = filtered[Math.min(row, Math.max(0, filtered.length - 1))];
	const save = async () => {
		if (!editor || busy) {
			return;
		}
		setError(null);
		setNotice(null);
		let metadata: MemoryMetadata;
		try {
			const parsed = memoryMetadataRecordSchema.safeParse(
				JSON.parse(editor.metadata)
			);
			if (!parsed.success) {
				throw new Error("Metadata must be a JSON object.");
			}
			if (
				Object.keys(parsed.data).some(
					(key) => !memoryMetadataKeySchema.safeParse(key).success
				)
			) {
				throw new Error("Use only the displayed metadata fields.");
			}
			metadata = memoryMetadataSchema.parse(parsed.data);
			if (!editor.content.trim()) {
				throw new Error("Memory content is required.");
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			return;
		}
		setBusy(true);
		try {
			const result = await request(
				target,
				editor.id
					? `/api/memory/${encodeURIComponent(editor.id)}`
					: "/api/memory",
				{
					method: editor.id ? "PUT" : "POST",
					body: { ...metadata, content: editor.content.trim() },
				},
				coreMemoryWriteResponseSchema
			);
			if (!("memory" in result && result.memory?.id)) {
				throw new Error("Core did not return the saved memory.");
			}
			// Retain its ID before readback, so retry cannot create a duplicate.
			setEditor({ ...editor, id: result.memory.id });
			const actual = await request(
				target,
				`/api/memory/${encodeURIComponent(result.memory.id)}`,
				{},
				coreMemoryEntryResponseSchema
			);
			if (
				actual.memory.content !== editor.content.trim() ||
				memoryMetadataKeys.some(
					(key) =>
						Object.hasOwn(metadata, key) &&
						JSON.stringify(actual.memory[key]) !== JSON.stringify(metadata[key])
				)
			) {
				throw new Error("Core did not confirm the saved memory.");
			}
			await readList();
			setEditor(null);
			setQuery("");
			setNotice("Memory saved and confirmed from Core.");
		} catch (cause) {
			setError(
				tf(
					"Couldn't save memory: {error}. Draft retained. Reload to check the library before retrying an unconfirmed creation.",
					{ error: cause instanceof Error ? cause.message : String(cause) }
				)
			);
		} finally {
			setBusy(false);
		}
	};
	const remove = async () => {
		if (!deleting || busy) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await request(
				target,
				`/api/memory/${encodeURIComponent(deleting.id)}`,
				{
					method: "DELETE",
				},
				appResponseValueSchema
			);
			const actual = await readList();
			if (actual.some((entry) => entry.id === deleting.id)) {
				throw new Error("Core still returns this memory.");
			}
			setDeleting(null);
			setNotice("Memory deleted and absence confirmed from Core.");
		} catch (cause) {
			setError(
				tf(
					"Couldn't delete memory: {error}. Press y to retry or n to cancel.",
					{ error: cause instanceof Error ? cause.message : String(cause) }
				)
			);
		} finally {
			setBusy(false);
		}
	};
	useKeyboard((key) => {
		if (!active || busy) {
			return;
		}
		if (deleting) {
			if (key.name === "y") {
				void remove();
			}
			if (key.name === "n") {
				setDeleting(null);
			}
			return;
		}
		if (editor) {
			if (key.name === "tab") {
				setField((current) => (current === "content" ? "metadata" : "content"));
			}
			if (key.ctrl && key.name === "b") {
				setEditor(null);
				setError(null);
			}
			return;
		}
		if (searching) {
			return;
		}
		if (key.name === "l") {
			onBack();
		}
		if (key.name === "r") {
			void reload();
		}
		if (key.name === "up") {
			setRow((index) => Math.max(0, index - 1));
		}
		if (key.name === "down") {
			setRow((index) => Math.max(0, Math.min(filtered.length - 1, index + 1)));
		}
		if (key.name === "/") {
			setSearching(true);
			setRow(0);
		}
		if (!loaded) {
			return;
		}
		if (key.name === "a" || (key.name === "e" && selected)) {
			const memory = key.name === "e" ? selected : null;
			setError(null);
			setNotice(null);
			setField("content");
			setEditor({
				id: memory?.id ?? null,
				content: memory?.content ?? "",
				metadata: JSON.stringify(
					memory
						? {
								scope: memory.scope,
								scope_id: memory.scope_id ?? null,
								category: memory.category,
								importance: memory.importance,
								tags: memory.tags,
								when_to_use: memory.when_to_use ?? null,
							}
						: { scope: "user", category: "other", importance: 3, tags: [] }
				),
			});
		}
		if (key.name === "x" && selected) {
			setDeleting(selected);
		}
	});
	return (
		<Card
			subtitle="Core-owned memories · permissions and sensitive-topic consent apply"
			title="Memory library"
		>
			{editor ? (
				<>
					<text>{editor.id ? "Edit memory" : "Add memory"}</text>
					<text fg={colors.mutedForeground}>
						{tf("Content: {content}", {
							content: editor.content || tr("(required)"),
						})}
					</text>
					<text fg={colors.mutedForeground}>
						{tf("Metadata: {metadata}", { metadata: editor.metadata })}
					</text>
					<TextInput
						bordered={false}
						key={field}
						label={field === "content" ? "Content" : "Metadata JSON"}
						onChange={(value) =>
							setEditor((current) =>
								current ? { ...current, [field]: value } : null
							)
						}
						onSubmit={() => void save()}
						value={editor[field]}
						width={90}
					/>
					<text fg={colors.mutedForeground}>
						Tab field · Enter save · Ctrl+B cancel. Metadata: scope, scope_id,
						category, importance, tags, when_to_use.
					</text>
				</>
			) : (
				<>
					{searching ? (
						<TextInput
							bordered={false}
							label="Search content, tags, scope or category"
							onChange={setQuery}
							onSubmit={() => setSearching(false)}
							value={query}
						/>
					) : (
						<text fg={colors.mutedForeground}>
							{tf("Search: {query} · {count} shown (up to 500 loaded)", {
								query: query || tr("All memories"),
								count: String(filtered.length),
							})}
						</text>
					)}
					{filtered
						.slice(Math.max(0, row - 3), Math.max(0, row - 3) + 7)
						.map((entry) => (
							<box flexDirection="column" key={entry.id} marginTop={1}>
								<text
									fg={
										selected?.id === entry.id
											? colors.primary
											: colors.foreground
									}
								>
									{selected?.id === entry.id ? "› " : "  "}
									{entry.content}
								</text>
								<text fg={colors.mutedForeground}>
									{tf(
										"{scope} · {category} · importance {importance} · {tags}",
										{
											scope: entry.scope,
											category: entry.category,
											importance: String(entry.importance),
											tags: entry.tags.join(", "),
										}
									)}
								</text>
							</box>
						))}
					{loaded && !filtered.length ? (
						<text>No matching memories.</text>
					) : null}
					{deleting ? (
						<text fg={colors.warning}>
							{tf("Delete “{content}”? y confirm · n cancel", {
								content: deleting.content,
							})}
						</text>
					) : (
						<text fg={colors.mutedForeground}>
							↑↓ select · / search · a add · e edit · x delete · r reload · l
							back
						</text>
					)}
				</>
			)}
			{busy ? <text>Waiting for Core and readback…</text> : null}
			{error ? <text fg={colors.error}>{error}</text> : null}
			{notice ? <text fg={colors.success}>{notice}</text> : null}
		</Card>
	);
}
