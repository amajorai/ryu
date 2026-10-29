import { Message01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
	DiffLineAnnotation,
	FileContents,
	FileDiffOptions,
	SelectedLineRange,
} from "@pierre/diffs";
import { parseDiffFromFile } from "@pierre/diffs";
import { Editor, type EditorOptions } from "@pierre/diffs/edit";
import { EditProvider, FileDiff, PatchDiff } from "@pierre/diffs/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface ReviewCommentMetadata {
	body: string;
	id: string;
}

export interface RichPatchDiffProps {
	className?: string;
	editMode?: boolean;
	filePath?: string;
	newFile?: FileContents | null;
	oldFile?: FileContents | null;
	onSave?: (file: FileContents) => Promise<void>;
	onSelection?: (text: string) => void;
	options?: FileDiffOptions<ReviewCommentMetadata>;
	patch: string;
	showSave?: boolean;
	style?: CSSProperties;
}

const DIFF_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/gm;

/** Pull one file's patch out of a multi-file unified diff. */
export function patchForFile(unifiedDiff: string, path: string): string {
	const matches = [...unifiedDiff.matchAll(DIFF_HEADER_RE)];
	if (matches.length === 0) {
		return unifiedDiff;
	}
	const matchIndex = matches.findIndex(
		(match) => match[1] === path || match[2] === path
	);
	if (matchIndex < 0) {
		return unifiedDiff;
	}
	const start = matches[matchIndex]?.index ?? 0;
	const end = matches[matchIndex + 1]?.index ?? unifiedDiff.length;
	return unifiedDiff.slice(start, end).trimEnd();
}

/** Split a git patch into the single-file patches expected by PatchDiff. */
export function splitPatchByFile(
	patch: string
): { path: string; patch: string }[] {
	return patch
		.split(/\n(?=diff --git )/)
		.map((chunk) => chunk.trim())
		.filter(Boolean)
		.map((chunk) => {
			const match = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
			return {
				path: match?.[2] ?? chunk.slice(0, 60),
				patch: chunk,
			};
		});
}

function isDiffAnnotation(
	annotation: DiffLineAnnotation<ReviewCommentMetadata> | { lineNumber: number }
): annotation is DiffLineAnnotation<ReviewCommentMetadata> {
	return "side" in annotation;
}

function annotationComments(
	annotations:
		| DiffLineAnnotation<ReviewCommentMetadata>[]
		| { lineNumber: number }[]
		| undefined
): DiffLineAnnotation<ReviewCommentMetadata>[] {
	if (!annotations) {
		return [];
	}
	return annotations.flatMap((annotation) => {
		if (!(isDiffAnnotation(annotation) && annotation.metadata?.id)) {
			return [];
		}
		return [annotation];
	});
}

function createSelectionAction(
	filePath: string | undefined,
	onSelection: ((text: string) => void) | undefined
) {
	return (context: { close: () => void; getSelectionText: () => string }) => {
		const root = document.createElement("div");
		root.className =
			"flex items-center gap-1 rounded-lg border border-border/70 bg-popover p-1 text-popover-foreground shadow-xl";

		const copy = document.createElement("button");
		copy.className = "rounded-md px-2 py-1 text-xs hover:bg-muted";
		copy.textContent = "Copy";
		copy.type = "button";
		copy.addEventListener("click", () => {
			const text = context.getSelectionText();
			if (text.trim()) {
				void navigator.clipboard?.writeText(text);
			}
			context.close();
		});

		if (onSelection) {
			const addToChat = document.createElement("button");
			addToChat.className =
				"rounded-md px-2 py-1 font-medium text-xs hover:bg-muted";
			addToChat.textContent = "Add to chat";
			addToChat.type = "button";
			addToChat.addEventListener("click", () => {
				const text = context.getSelectionText();
				if (text.trim()) {
					onSelection(filePath ? `${filePath}\n\n${text}` : text);
				}
				context.close();
			});
			root.append(addToChat);
		}
		root.append(copy);
		return root;
	};
}

export function RichPatchDiff({
	className,
	editMode = false,
	filePath,
	newFile,
	onSave,
	onSelection,
	oldFile,
	options,
	patch,
	showSave = true,
	style,
}: RichPatchDiffProps) {
	const tl = useLiteralMessages();
	const [comments, setComments] = useState<
		DiffLineAnnotation<ReviewCommentMetadata>[]
	>([]);
	const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(
		null
	);
	const [editedFile, setEditedFile] = useState<FileContents | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const baselineRef = useRef<string | null>(null);
	const commentCountRef = useRef(0);
	const hydratedDiff = useMemo(() => {
		if (oldFile === undefined && newFile === undefined) {
			return null;
		}
		return parseDiffFromFile(oldFile ?? null, newFile ?? null);
	}, [newFile, oldFile]);

	useEffect(() => {
		baselineRef.current = newFile?.contents ?? null;
		setEditedFile(null);
		setSaveError(null);
	}, [newFile?.contents]);

	const addComment = useCallback(
		(line: { lineNumber: number; side: "additions" | "deletions" }) => {
			if (line.lineNumber < 1) {
				return;
			}
			commentCountRef.current += 1;
			setComments((current) => [
				...current,
				{
					lineNumber: line.lineNumber,
					side: line.side,
					metadata: {
						body: "",
						id: `comment-${Date.now()}-${commentCountRef.current}`,
					},
				},
			]);
		},
		[]
	);

	const updateComment = useCallback((id: string, body: string) => {
		setComments((current) =>
			current.map((comment) =>
				comment.metadata?.id === id
					? { ...comment, metadata: { ...comment.metadata, body } }
					: comment
			)
		);
	}, []);

	const removeComment = useCallback((id: string) => {
		setComments((current) =>
			current.filter((comment) => comment.metadata?.id !== id)
		);
	}, []);

	const handleEditorChange = useCallback(
		(
			file: FileContents,
			lineAnnotations:
				| DiffLineAnnotation<ReviewCommentMetadata>[]
				| { lineNumber: number }[]
				| undefined
		) => {
			setEditedFile(file);
			const nextComments = annotationComments(lineAnnotations);
			if (lineAnnotations !== undefined) {
				setComments(nextComments);
			}
		},
		[]
	);

	const renderAnnotation = useCallback(
		(annotation: DiffLineAnnotation<ReviewCommentMetadata>): ReactNode => {
			const metadata = annotation.metadata;
			if (!metadata) {
				return null;
			}
			return (
				<div className="my-1 flex max-w-[42rem] flex-col gap-1 rounded-lg border border-warning/30 bg-warning/8 p-2 text-xs">
					<div className="flex items-center gap-1.5 text-status-warning">
						<HugeiconsIcon className="size-3.5" icon={Message01Icon} />
						<span className="font-medium">Review comment</span>
						<span className="text-muted-foreground">
							{annotation.side === "additions"
								? tl("added line {lineNumber}", {
										lineNumber: formatCount(annotation.lineNumber) ?? "—",
									})
								: tl("removed line {lineNumber}", {
										lineNumber: formatCount(annotation.lineNumber) ?? "—",
									})}
						</span>
						<button
							aria-label="Remove review comment"
							className="ml-auto rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
							onClick={() => removeComment(metadata.id)}
							type="button"
						>
							×
						</button>
					</div>
					<textarea
						aria-label="Review comment"
						className="min-h-12 resize-y rounded-md border border-border/70 bg-background/70 px-2 py-1.5 text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
						onChange={(event) => updateComment(metadata.id, event.target.value)}
						placeholder="Leave a comment on this line…"
						value={metadata.body}
					/>
				</div>
			);
		},
		[removeComment, tl, updateComment]
	);

	const renderGutterUtility = useCallback(
		(
			getHoveredLine: () =>
				| { lineNumber: number; side: "additions" | "deletions" }
				| undefined
		) => (
			<button
				aria-label="Add review comment"
				className="flex size-5 items-center justify-center rounded bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
				onClick={(event) => {
					event.stopPropagation();
					const line = getHoveredLine();
					if (line) {
						addComment(line);
					}
				}}
				title="Add review comment"
				type="button"
			>
				<HugeiconsIcon className="size-3" icon={Message01Icon} />
			</button>
		),
		[addComment]
	);

	const renderSelectionAction = useMemo(
		() => createSelectionAction(filePath, onSelection),
		[filePath, onSelection]
	);
	const editorOptions = useMemo<EditorOptions<ReviewCommentMetadata>>(
		() => ({
			enabledSelectionAction: true,
			historyMaxEntries: 200,
			onChange: (file, lineAnnotations) => {
				handleEditorChange(file, lineAnnotations);
			},
			renderSelectionAction,
		}),
		[handleEditorChange, renderSelectionAction]
	);
	const diffOptions = useMemo(
		() => ({
			...options,
			enableLineSelection: true,
			lineHoverHighlight: "line" as const,
			onLineSelected: setSelectedLines,
		}),
		[options]
	);
	const createEditor = useCallback(
		(editorOptionsForSurface: EditorOptions<ReviewCommentMetadata>) =>
			new Editor(editorOptionsForSurface),
		[]
	);

	const dirty =
		editedFile !== null &&
		(baselineRef.current === null ||
			editedFile.contents !== baselineRef.current);
	const save = useCallback(async () => {
		if (!(editedFile && onSave && dirty)) {
			return;
		}
		setSaving(true);
		setSaveError(null);
		try {
			await onSave(editedFile);
			baselineRef.current = editedFile.contents;
		} catch (error) {
			setSaveError(
				error instanceof Error
					? error.message
					: "Unable to save file. Try again."
			);
		} finally {
			setSaving(false);
		}
	}, [dirty, editedFile, onSave]);

	return (
		<EditProvider<ReviewCommentMetadata> createEditor={createEditor}>
			<div className={cn("min-w-0", className)} style={style}>
				{editMode && showSave && onSave && (
					<div className="flex items-center gap-2 border-border/60 border-b bg-muted/30 px-2 py-1">
						<span className="text-muted-foreground text-xs">
							{dirty ? "Unsaved edits" : "Edit mode"}
						</span>
						{dirty && (
							<button
								className="ml-auto inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground text-xs hover:bg-primary/90 disabled:opacity-50"
								disabled={saving}
								onClick={() => {
									void save();
								}}
								type="button"
							>
								<HugeiconsIcon className="size-3" icon={Tick02Icon} />
								{saving ? "Saving…" : "Save file"}
							</button>
						)}
					</div>
				)}
				{saveError && (
					<p className="px-2 py-1 text-status-destructive text-xs" role="alert">
						{saveError}
					</p>
				)}
				{hydratedDiff ? (
					<FileDiff
						disableWorkerPool
						edit={editMode && newFile !== null}
						editorOptions={editorOptions}
						fileDiff={hydratedDiff}
						lineAnnotations={comments}
						options={diffOptions}
						renderAnnotation={renderAnnotation}
						renderGutterUtility={renderGutterUtility}
						selectedLines={selectedLines}
					/>
				) : (
					<PatchDiff
						disableWorkerPool
						edit={editMode}
						editorOptions={editorOptions}
						lineAnnotations={comments}
						options={diffOptions}
						patch={patch}
						renderAnnotation={renderAnnotation}
						renderGutterUtility={renderGutterUtility}
						selectedLines={selectedLines}
					/>
				)}
			</div>
		</EditProvider>
	);
}

export function DiffFilePreviewPopover({
	children,
	filePath,
	patch,
}: {
	children: ReactElement;
	filePath: string;
	patch: string;
}) {
	return (
		<HoverCard>
			<HoverCardTrigger closeDelay={120} delay={180} render={children} />
			<HoverCardContent
				align="start"
				appearance="composer-preview"
				className="w-[min(42rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden"
				side="left"
				sideOffset={10}
			>
				<div className="mb-1 flex items-center gap-2 px-2 py-1 text-muted-foreground text-xs">
					<span className="min-w-0 flex-1 truncate font-mono text-foreground">
						{filePath}
					</span>
					<span>Preview</span>
				</div>
				<div className="max-h-[28rem] overflow-auto rounded-xl border border-border/60 bg-background/60">
					<PatchDiff
						disableWorkerPool
						options={{
							diffStyle: "unified",
							lineHoverHighlight: "line",
						}}
						patch={patch}
					/>
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}
