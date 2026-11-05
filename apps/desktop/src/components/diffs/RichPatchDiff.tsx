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
import { usePierreShadowLocalizer } from "@ryu/blocks/desktop/agent-elements/use-pierre-shadow-localizer.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSelectionAction } from "./rich-patch-selection-action.ts";

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
	const localizeDiffCopy = usePierreShadowLocalizer();
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
							className="ms-auto rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
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
		() => createSelectionAction(filePath, onSelection, tl),
		[filePath, onSelection, tl]
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
			<div
				className={cn("min-w-0", className)}
				ref={localizeDiffCopy}
				style={style}
			>
				{editMode && showSave && onSave && (
					<div className="flex items-center gap-2 border-border/60 border-b bg-muted/30 px-2 py-1">
						<span className="text-muted-foreground text-xs">
							{dirty ? "Unsaved edits" : "Edit mode"}
						</span>
						{dirty && (
							<button
								className="ms-auto inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground text-xs hover:bg-primary/90 disabled:opacity-50"
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
