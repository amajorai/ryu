import {
	Download01Icon,
	File01Icon,
	FloppyDiskIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { FileEditorHandle } from "@/src/components/files/DocxEditor.tsx";
import {
	useCurrentTabId,
	useTabSelector,
} from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	fetchDocuments,
	fetchSpaceFileBlob,
	replaceSpaceFileBlob,
	type SpaceDocument,
} from "@/src/lib/api/spaces.ts";
import {
	workspaceFileKind,
	workspaceFileLabel,
} from "@/src/lib/office-files.ts";

const loadDocxEditor = () =>
	import("@/src/components/files/DocxEditor.tsx").then((module) => ({
		default: module.DocxEditor,
	}));
const loadPdfViewer = () =>
	import("@/src/components/files/PdfViewer.tsx").then((module) => ({
		default: module.PdfViewer,
	}));
const loadSlidesEditor = () =>
	import("@/src/components/files/SlidesEditor.tsx").then((module) => ({
		default: module.SlidesEditor,
	}));
const loadSpreadsheetEditor = () =>
	import("@/src/components/files/SpreadsheetEditor.tsx").then((module) => ({
		default: module.SpreadsheetEditor,
	}));
const DocxEditor = lazy(loadDocxEditor);
const PdfViewer = lazy(loadPdfViewer);
const SlidesEditor = lazy(loadSlidesEditor);
const SpreadsheetEditor = lazy(loadSpreadsheetEditor);

function preloadEditor(kind: ReturnType<typeof workspaceFileKind>) {
	switch (kind) {
		case "document":
			return loadDocxEditor();
		case "pdf":
			return loadPdfViewer();
		case "slides":
			return loadSlidesEditor();
		case "spreadsheet":
			return loadSpreadsheetEditor();
		default:
			return Promise.resolve();
	}
}

interface LoadedFile {
	bytes: ArrayBuffer;
	document: SpaceDocument;
	mime: string;
}

function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const link = window.document.createElement("a");
	link.href = url;
	link.download = filename;
	window.document.body.append(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

export default function SpaceFileViewerPage({
	spaceId,
	documentId,
}: {
	spaceId: string;
	documentId: string;
}) {
	const node = useActiveNode();
	const tabId = useCurrentTabId();
	const updateTabTitle = useTabSelector((state) => state.updateTabTitle);
	const editorRef = useRef<FileEditorHandle>(null);
	const [loaded, setLoaded] = useState<LoadedFile | null>(null);
	const [download, setDownload] = useState<Blob | null>(null);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [reloadNonce, setReloadNonce] = useState(0);

	useEffect(() => {
		const controller = new AbortController();
		setError(null);
		setLoaded(null);
		const target = {
			token: node.token,
			userJwt: node.userJwt ?? null,
			url: node.url,
		};
		Promise.all([
			fetchDocuments(target, spaceId),
			fetchSpaceFileBlob(target, spaceId, documentId, controller.signal),
		])
			.then(async ([documents, blob]) => {
				const document = documents.find((item) => item.id === documentId);
				if (!document) {
					throw new Error("This file no longer exists in the Space.");
				}
				const mime = document.mime || blob.type || "application/octet-stream";
				const [bytes] = await Promise.all([
					blob.arrayBuffer(),
					preloadEditor(workspaceFileKind(document.title, mime)),
				]);
				if (controller.signal.aborted) {
					return;
				}
				setLoaded({ bytes, document, mime });
				setDownload(new Blob([bytes], { type: mime }));
				setDirty(false);
				if (tabId) {
					updateTabTitle(tabId, document.title || "Untitled file");
				}
			})
			.catch((cause) => {
				if (!controller.signal.aborted) {
					setError(
						cause instanceof Error
							? cause.message
							: "This file could not be opened."
					);
				}
			});
		return () => controller.abort();
	}, [
		documentId,
		node.token,
		node.url,
		node.userJwt,
		reloadNonce,
		spaceId,
		tabId,
		updateTabTitle,
	]);

	useEffect(() => {
		if (!dirty) {
			return;
		}
		const warn = (event: BeforeUnloadEvent) => {
			event.preventDefault();
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);

	const handleEditorError = useCallback(
		(message: string) => setError(message),
		[]
	);
	const markDirty = useCallback(() => setDirty(true), []);

	const save = useCallback(async () => {
		if (!(loaded && editorRef.current)) {
			return;
		}
		setSaving(true);
		try {
			const blob = await editorRef.current.exportFile();
			await replaceSpaceFileBlob(
				{ token: node.token, userJwt: node.userJwt ?? null, url: node.url },
				spaceId,
				documentId,
				blob,
				loaded.mime
			);
			setDownload(blob);
			setDirty(false);
			toast.success("Saved to this Space");
		} catch (cause) {
			toast.error(
				cause instanceof Error
					? cause.message
					: "The edited file could not be saved."
			);
		} finally {
			setSaving(false);
		}
	}, [documentId, loaded, node.token, node.url, node.userJwt, spaceId]);

	if (error) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={File01Icon} />
					</EmptyMedia>
					<EmptyTitle>Could not open file</EmptyTitle>
					<EmptyDescription>{error}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button
						onClick={() => setReloadNonce((value) => value + 1)}
						size="sm"
					>
						Try again
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	if (!loaded) {
		return <SkeletonRows rows={6} spacing="library" />;
	}

	const kind = workspaceFileKind(loaded.document.title, loaded.mime);
	const editable =
		kind === "document" || kind === "slides" || kind === "spreadsheet";

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center gap-3 border-border border-b bg-background px-4">
				<HugeiconsIcon
					className="size-4 shrink-0 text-muted-foreground"
					icon={File01Icon}
				/>
				<div className="min-w-0 flex-1">
					<h1
						className="truncate font-medium text-sm"
						title={loaded.document.title}
					>
						{loaded.document.title}
					</h1>
					<p className="text-muted-foreground text-xs">
						{workspaceFileLabel(kind)}
						{dirty ? " · Unsaved changes" : ""}
					</p>
				</div>
				<Button
					disabled={!download}
					onClick={() => {
						if (download) {
							downloadBlob(download, loaded.document.title);
						}
					}}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon icon={Download01Icon} />
					Download
				</Button>
				{editable ? (
					<Button disabled={!dirty || saving} onClick={() => save()} size="sm">
						<HugeiconsIcon icon={FloppyDiskIcon} />
						{saving ? "Saving…" : "Save"}
					</Button>
				) : null}
			</header>
			<Suspense fallback={<SkeletonRows rows={6} spacing="library" />}>
				{kind === "pdf" ? (
					<PdfViewer bytes={loaded.bytes} onLoadError={handleEditorError} />
				) : null}
				{kind === "document" ? (
					<DocxEditor
						bytes={loaded.bytes}
						onDirty={markDirty}
						onLoadError={handleEditorError}
						ref={editorRef}
					/>
				) : null}
				{kind === "spreadsheet" ? (
					<SpreadsheetEditor
						bytes={loaded.bytes}
						mime={loaded.mime}
						onDirty={markDirty}
						onLoadError={handleEditorError}
						ref={editorRef}
					/>
				) : null}
				{kind === "slides" ? (
					<SlidesEditor
						bytes={loaded.bytes}
						mime={loaded.mime}
						onDirty={markDirty}
						onLoadError={handleEditorError}
						ref={editorRef}
					/>
				) : null}
				{kind === "unsupported" ? (
					<Empty className="min-h-0 flex-1">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HugeiconsIcon icon={File01Icon} />
							</EmptyMedia>
							<EmptyTitle>Preview is not available</EmptyTitle>
							<EmptyDescription>
								Ryu can edit DOCX, XLSX, XLSM, PPTX and PPTM files, and view
								PDFs. Download this file to open it in another app.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : null}
			</Suspense>
		</div>
	);
}
