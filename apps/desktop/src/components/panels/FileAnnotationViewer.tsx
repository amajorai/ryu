import {
	ArrowLeft01Icon,
	Cancel01Icon,
	Message01Icon,
	SentIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { LineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { File } from "@pierre/diffs/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	diffViewPrefsToOptions,
	useDiffViewPrefs,
} from "@/src/hooks/useDiffViewPrefs.ts";
import {
	countLines,
	decodeViewerText,
	excerptLines,
	type FileAnnotationNote,
	type FileLineRange,
	formatFileAnnotationsForChat,
	formatLineLabel,
	normalizeLineRange,
	requestChatComposerInsert,
} from "@/src/lib/file-annotations.ts";
import { basename, joinPath, readProjectFileBinary } from "@/src/lib/files.ts";
import { useAssistantStore } from "@/src/store/useAssistantStore.ts";

type ViewerAnnotation =
	| { kind: "draft"; range: FileLineRange }
	| { kind: "note"; note: FileAnnotationNote };

type LoadState =
	| { status: "loading" }
	| { status: "ready"; text: string }
	| { status: "error"; message: string };

const ASSISTANT_FALLBACK_PREFIX =
	"Review these notes on a project file and address each one.\n\n";

/**
 * Read-only view of one workspace file in the dock. Selecting line numbers
 * opens an inline note; saved notes stay anchored to their lines and are sent
 * to the chat composer together, the file counterpart of browser annotations.
 */
export function FileAnnotationViewer({
	folder,
	notes,
	onClose,
	onNotesChange,
	onOpenExternally,
	path,
}: {
	folder: string;
	notes: readonly FileAnnotationNote[];
	onClose(): void;
	onNotesChange(notes: FileAnnotationNote[]): void;
	onOpenExternally(): void;
	/** Workspace-relative path, as listed by the file tree. */
	path: string;
}) {
	const tl = useLiteralMessages();
	const [load, setLoad] = useState<LoadState>({ status: "loading" });
	const [selection, setSelection] = useState<SelectedLineRange | null>(null);
	const [draft, setDraft] = useState("");
	const noteSequenceRef = useRef(0);
	const openAssistant = useAssistantStore((store) => store.open);
	const setPendingPrompt = useAssistantStore((store) => store.setPendingPrompt);
	const prefs = useDiffViewPrefs();

	useEffect(() => {
		let cancelled = false;
		setLoad({ status: "loading" });
		setSelection(null);
		// The binary read is size-bounded natively, unlike read_project_file.
		readProjectFileBinary(joinPath(folder, path))
			.then((base64) => {
				if (cancelled) {
					return;
				}
				const decoded = decodeViewerText(base64);
				if (decoded.kind === "text") {
					setLoad({ status: "ready", text: decoded.text });
					return;
				}
				setLoad({
					status: "error",
					message:
						decoded.kind === "binary"
							? "This file isn't text, so it can't be annotated here."
							: "This file is too large to annotate here.",
				});
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setLoad({
						status: "error",
						message: error instanceof Error ? error.message : String(error),
					});
				}
			});
		return () => {
			cancelled = true;
		};
	}, [folder, path]);

	const text = load.status === "ready" ? load.text : "";
	const lineCount = useMemo(() => countLines(text), [text]);
	const range = useMemo(
		() => normalizeLineRange(selection, lineCount),
		[lineCount, selection]
	);

	const cancelDraft = useCallback(() => {
		setSelection(null);
		setDraft("");
	}, []);

	const sendToChat = useCallback(
		(toSend: readonly FileAnnotationNote[]) => {
			if (toSend.length === 0) {
				return false;
			}
			const message = formatFileAnnotationsForChat(path, toSend);
			if (requestChatComposerInsert(message)) {
				toast.success("Added to chat", {
					description: "Finish your message in the composer.",
				});
				return true;
			}
			// No chat composer is visible (the dock is open outside a chat), so
			// hand the notes to the assistant like browser annotations do.
			setPendingPrompt(`${ASSISTANT_FALLBACK_PREFIX}${message}`);
			openAssistant("sidebar");
			return true;
		},
		[openAssistant, path, setPendingPrompt]
	);

	const draftNote = useCallback((): FileAnnotationNote | null => {
		if (!range) {
			return null;
		}
		noteSequenceRef.current += 1;
		return {
			comment: draft.trim(),
			endLine: range.endLine,
			excerpt: excerptLines(text, range),
			id: `file-note-${Date.now()}-${noteSequenceRef.current}`,
			startLine: range.startLine,
		};
	}, [draft, range, text]);

	const saveDraft = useCallback(() => {
		const note = draftNote();
		if (!note?.comment) {
			return;
		}
		onNotesChange([...notes, note]);
		cancelDraft();
	}, [cancelDraft, draftNote, notes, onNotesChange]);

	const quoteDraft = useCallback(() => {
		const note = draftNote();
		if (note && sendToChat([note])) {
			cancelDraft();
		}
	}, [cancelDraft, draftNote, sendToChat]);

	const sendAll = useCallback(() => {
		if (sendToChat(notes)) {
			onNotesChange([]);
		}
	}, [notes, onNotesChange, sendToChat]);

	const removeNote = useCallback(
		(id: string) => onNotesChange(notes.filter((note) => note.id !== id)),
		[notes, onNotesChange]
	);

	const lineAnnotations = useMemo(() => {
		const annotations: LineAnnotation<ViewerAnnotation>[] = notes.map(
			(note) => ({
				lineNumber: Math.min(note.endLine, lineCount),
				metadata: { kind: "note", note },
			})
		);
		if (range) {
			annotations.push({
				lineNumber: range.endLine,
				metadata: { kind: "draft", range },
			});
		}
		return annotations;
	}, [lineCount, notes, range]);

	const renderAnnotation = useCallback(
		(annotation: LineAnnotation<ViewerAnnotation>): ReactNode => {
			const metadata = annotation.metadata;
			if (metadata.kind === "note") {
				return (
					<SavedNoteCard
						note={metadata.note}
						onRemove={() => removeNote(metadata.note.id)}
					/>
				);
			}
			return (
				<DraftNoteCard
					draft={draft}
					onCancel={cancelDraft}
					onDraftChange={setDraft}
					onQuote={quoteDraft}
					onSave={saveDraft}
					range={metadata.range}
				/>
			);
		},
		[cancelDraft, draft, quoteDraft, removeNote, saveDraft]
	);

	const fileOptions = useMemo(() => {
		const base = diffViewPrefsToOptions(prefs);
		return {
			disableFileHeader: true,
			enableLineSelection: true,
			lineHoverHighlight: "number" as const,
			onLineSelected: setSelection,
			overflow: base.overflow,
			theme: base.theme,
			themeType: base.themeType,
			tokenizeMaxLineLength: base.tokenizeMaxLineLength,
		};
	}, [prefs]);

	const file = useMemo(() => ({ contents: text, name: path }), [path, text]);

	let body: ReactNode;
	if (load.status === "loading") {
		body = (
			<div className="flex h-full animate-skeleton items-center justify-center text-muted-foreground text-xs">
				Loading file…
			</div>
		);
	} else if (load.status === "error") {
		body = (
			<div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-xs">
				<p className="text-muted-foreground" role="alert">
					{load.message}
				</p>
				<Button
					onClick={onOpenExternally}
					size="xs"
					type="button"
					variant="outline"
				>
					Open externally
				</Button>
			</div>
		);
	} else {
		body = (
			<File<ViewerAnnotation>
				disableWorkerPool
				file={file}
				lineAnnotations={lineAnnotations}
				options={fileOptions}
				renderAnnotation={renderAnnotation}
				selectedLines={selection}
			/>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex h-10 shrink-0 items-center gap-1 border-border border-b px-2">
				<Button
					aria-label="Back to files"
					onClick={onClose}
					size="icon-xs"
					title="Back to files"
					type="button"
					variant="ghost-muted"
				>
					<HugeiconsIcon icon={ArrowLeft01Icon} />
				</Button>
				<span className="min-w-0 flex-1 truncate text-xs" title={path}>
					{basename(path)}
				</span>
				{notes.length > 0 && (
					<Button
						onClick={() => onNotesChange([])}
						size="xs"
						type="button"
						variant="ghost-muted"
					>
						Clear
					</Button>
				)}
				<Button
					disabled={notes.length === 0}
					onClick={sendAll}
					size="xs"
					title={
						notes.length === 0
							? "Select line numbers and add a note first"
							: undefined
					}
					type="button"
				>
					<HugeiconsIcon data-icon="inline-start" icon={SentIcon} />
					{notes.length > 0
						? tl("Send {noteCount, plural, one {# note} other {# notes}}", {
								noteCount: notes.length,
							})
						: "Send to chat"}
				</Button>
			</div>
			{load.status === "ready" && notes.length === 0 && !range && (
				<p className="shrink-0 border-border border-b px-2 py-1 text-muted-foreground text-xs">
					Click or drag line numbers to annotate a range.
				</p>
			)}
			<div className="min-h-0 flex-1 overflow-auto">{body}</div>
		</div>
	);
}

function DraftNoteCard({
	draft,
	onCancel,
	onDraftChange,
	onQuote,
	onSave,
	range,
}: {
	draft: string;
	onCancel(): void;
	onDraftChange(value: string): void;
	onQuote(): void;
	onSave(): void;
	range: FileLineRange;
}) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	// A fresh selection is an intent to write; focus once, not on every keystroke.
	useEffect(() => {
		textareaRef.current?.focus();
	}, []);
	const tl = useLiteralMessages();
	const label = formatLineLabel(range);
	return (
		<div className="my-1 flex max-w-[42rem] flex-col gap-1.5 rounded-lg border border-primary/30 bg-primary/5 p-2 font-sans text-xs">
			<div className="flex items-center gap-1.5 text-muted-foreground">
				<HugeiconsIcon className="size-3.5" icon={Message01Icon} />
				<span className="font-medium text-foreground">
					{tl("Note on {label}", { label })}
				</span>
			</div>
			<Textarea
				aria-label={tl("Note on {label}", { label })}
				onChange={(event) => onDraftChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						onCancel();
					} else if (
						event.key === "Enter" &&
						(event.metaKey || event.ctrlKey)
					) {
						event.preventDefault();
						onSave();
					}
				}}
				placeholder="What should change here, or what do you want to ask?"
				ref={textareaRef}
				size="compact"
				typography="small"
				value={draft}
			/>
			<div className="flex items-center gap-1">
				<Button
					disabled={!draft.trim()}
					onClick={onSave}
					size="xs"
					type="button"
				>
					Add note
				</Button>
				<Button onClick={onQuote} size="xs" type="button" variant="outline">
					Quote in chat
				</Button>
				<Button
					className="ml-auto"
					onClick={onCancel}
					size="xs"
					type="button"
					variant="ghost-muted"
				>
					Cancel
				</Button>
			</div>
		</div>
	);
}

function SavedNoteCard({
	note,
	onRemove,
}: {
	note: FileAnnotationNote;
	onRemove(): void;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="my-1 flex max-w-[42rem] flex-col gap-1 rounded-lg border border-warning/30 bg-warning/8 p-2 font-sans text-xs">
			<div className="flex items-center gap-1.5 text-status-warning">
				<HugeiconsIcon className="size-3.5" icon={Message01Icon} />
				<span className="font-medium">Note</span>
				<span className="text-muted-foreground">{formatLineLabel(note)}</span>
				<button
					aria-label={tl("Remove note on {lineLabel}", {
						lineLabel: formatLineLabel(note),
					})}
					className="ml-auto rounded-lg px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
					onClick={onRemove}
					type="button"
				>
					<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
				</button>
			</div>
			<p className="whitespace-pre-wrap text-foreground">{note.comment}</p>
		</div>
	);
}

/**
 * The file a plain click (or Enter) landed on in the `@pierre/trees` rows,
 * or `null` for folders, row action buttons, rename inputs and the context menu.
 */
export function fileTreeRowPathFromEvent(
	composedPath: readonly (EventTarget | undefined)[]
): string | null {
	for (const target of composedPath) {
		if (!(target instanceof Element)) {
			continue;
		}
		if (target.hasAttribute("data-file-tree-context-menu-root")) {
			return null;
		}
		if (target.getAttribute("data-type") === "item") {
			return target.getAttribute("data-item-type") === "file"
				? target.getAttribute("data-item-path")
				: null;
		}
		// Rows are buttons themselves; any control nested inside one is its own action.
		if (target.tagName === "BUTTON" || target.tagName === "INPUT") {
			return null;
		}
	}
	return null;
}
