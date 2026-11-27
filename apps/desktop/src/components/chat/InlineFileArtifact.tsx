// apps/desktop/src/components/chat/InlineFileArtifact.tsx
//
// A file the agent created with `artifact.create` that the chat cannot draw as
// text (a PDF, an image, an office file, an archive), shown as a file card:
// type icon, name, type and size, Download, and Open for the types the Space
// file viewer shows. Images and PDFs also preview inline.
//
// The tool result is stored with the turn, so the card is there again after a
// reload. The bytes are read from the node through the artifact host, which
// addresses the stored Space file by its ids and never by an agent-chosen URL.

import {
	type NativeArtifactObservation,
	useArtifactHost,
} from "@ryu/blocks/desktop/agent-elements/artifact-host-context.tsx";
import {
	FileCard,
	type FileCardProps,
} from "@ryu/blocks/desktop/agent-elements/file-card.tsx";
import {
	baseMime,
	type FilePreviewKind,
	filePreviewKind,
	previewImageMime,
} from "@ryu/blocks/desktop/agent-elements/file-card-logic.ts";
import {
	lazy,
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	artifactByteSize,
	artifactText,
	spaceFileRef,
} from "@/src/lib/artifact-files.ts";
import { workspaceFileKind } from "@/src/lib/office-files.ts";

/**
 * A larger file gets no automatic preview, and neither does a file whose tool
 * result states no size, because the preview reads the whole file. Download
 * and Open still work.
 */
export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;

/** Shown for a created file whose tool call carried no title. */
const UNTITLED_FILE = "Untitled file";

const PdfViewer = lazy(() =>
	import("@/src/components/files/PdfViewer.tsx").then((module) => ({
		default: module.PdfViewer,
	}))
);

type PreviewState =
	| { status: "failed" }
	| { status: "image"; url: string }
	| { status: "loading" }
	| { bytes: ArrayBuffer; status: "pdf" };

function PreviewNote({
	children,
	testId,
}: {
	children: ReactNode;
	testId: string;
}) {
	return (
		<div
			className="flex h-16 items-center justify-center border-border border-t bg-sidebar px-3 text-center text-muted-foreground text-xs"
			data-testid={testId}
		>
			{children}
		</div>
	);
}

function FilePreview({
	kind,
	load,
	mime,
	name,
}: {
	kind: FilePreviewKind;
	load: () => Promise<Blob | null>;
	mime: string;
	name: string;
}) {
	const [state, setState] = useState<PreviewState>({ status: "loading" });
	const fail = useCallback(() => setState({ status: "failed" }), []);

	useEffect(() => {
		let cancelled = false;
		let objectUrl: string | null = null;
		setState({ status: "loading" });
		load()
			.then(async (blob) => {
				if (cancelled) {
					return;
				}
				if (!blob) {
					setState({ status: "failed" });
					return;
				}
				if (kind === "image") {
					// The type is the card's own raster type, never the response's, so
					// the object URL can only ever be read as a picture.
					objectUrl = URL.createObjectURL(
						blob.slice(0, blob.size, mime || "application/octet-stream")
					);
					setState({ status: "image", url: objectUrl });
					return;
				}
				const bytes = await blob.arrayBuffer();
				if (!cancelled) {
					setState({ bytes, status: "pdf" });
				}
			})
			.catch(() => {
				if (!cancelled) {
					setState({ status: "failed" });
				}
			});
		return () => {
			cancelled = true;
			if (objectUrl) {
				URL.revokeObjectURL(objectUrl);
			}
		};
	}, [kind, load, mime]);

	if (state.status === "loading") {
		return <PreviewNote testId="file-preview-loading">Loading…</PreviewNote>;
	}
	if (state.status === "failed") {
		return (
			<PreviewNote testId="file-preview-failed">
				Could not load the preview.
			</PreviewNote>
		);
	}
	if (state.status === "image") {
		return (
			<div
				className="flex max-h-96 items-center justify-center overflow-hidden border-border border-t bg-muted/30"
				data-testid="file-preview-image"
			>
				<img
					alt={name}
					className="max-h-96 max-w-full object-contain"
					data-ryu-i18n="off"
					onError={fail}
					src={state.url}
				/>
			</div>
		);
	}
	return (
		<div
			className="flex h-96 min-h-0 flex-col border-border border-t"
			data-testid="file-preview-pdf"
		>
			<Suspense
				fallback={
					<PreviewNote testId="file-preview-loading">Loading…</PreviewNote>
				}
			>
				<PdfViewer bytes={state.bytes} onLoadError={fail} />
			</Suspense>
		</div>
	);
}

export interface InlineFileArtifactProps {
	artifact: NativeArtifactObservation;
	id: string;
	/** Hands the bytes to the browser as a download. Tests replace it. */
	save?: FileCardProps["save"];
}

export function InlineFileArtifact({
	artifact: payload,
	id,
	save,
}: InlineFileArtifactProps) {
	const host = useArtifactHost();
	const name = artifactText(payload.title)?.trim() || UNTITLED_FILE;
	const mime = baseMime(artifactText(payload.mime));
	const size = artifactByteSize(payload.byteSize);
	const file = spaceFileRef(payload);
	const fileKey = file ? `${file.spaceId}/${file.docId}` : "";
	const previewKind = filePreviewKind(name, mime);
	const previewed =
		previewKind !== null && size !== undefined && size <= MAX_PREVIEW_BYTES;

	// The host value and the payload object are rebuilt as the chat renders.
	// The loader reads them through a ref and changes only with the file, so a
	// preview is not fetched or redrawn again for the same file.
	const latest = useRef({ host, id, payload });
	latest.current = { host, id, payload };
	const canFetch = file !== null && host?.fetchBlob !== undefined;
	// A previewed file is read once: Download reuses the bytes the preview
	// fetched. A failed read is forgotten, so Retry asks the node again.
	const fetched = useRef<{ key: string; request: Promise<Blob | null> } | null>(
		null
	);
	const loadBlob = useMemo(() => {
		if (!canFetch) {
			return;
		}
		const read = (): Promise<Blob | null> => {
			const now = latest.current;
			const request = now.host?.fetchBlob?.(now.payload, now.id);
			return request ? request.catch(() => null) : Promise.resolve(null);
		};
		if (!previewed) {
			return read;
		}
		return () => {
			const kept = fetched.current;
			if (kept?.key === fileKey) {
				return kept.request;
			}
			const request = read().then((blob) => {
				if (!blob) {
					fetched.current = null;
				}
				return blob;
			});
			fetched.current = { key: fileKey, request };
			return request;
		};
	}, [canFetch, fileKey, previewed]);

	// The viewer tab shows PDFs and office files. For anything else it would
	// only say that there is no preview, so the card offers no Open then.
	const openFile = host?.openFile;
	const onOpen =
		file && openFile && workspaceFileKind(name, mime) !== "unsupported"
			? () => openFile(payload, id)
			: undefined;

	return (
		<FileCard
			className={previewKind === "pdf" ? "max-w-2xl" : undefined}
			loadBlob={loadBlob}
			mime={mime || undefined}
			name={name}
			onOpen={onOpen}
			preview={
				previewed && previewKind && loadBlob ? (
					<FilePreview
						kind={previewKind}
						load={loadBlob}
						mime={previewKind === "image" ? previewImageMime(name, mime) : ""}
						name={name}
					/>
				) : null
			}
			save={save}
			size={size}
		/>
	);
}
