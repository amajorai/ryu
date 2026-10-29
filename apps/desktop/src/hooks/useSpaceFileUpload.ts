import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import type { FileUploadItem } from "@ryu/ui/components/file-upload.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useRef, useState } from "react";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import {
	formatBytes,
	SPACE_UPLOAD_MAX_BYTES,
	type SpaceFileIndex,
} from "@/src/lib/api/spaces.ts";

interface QueuedUpload extends FileUploadItem {
	file: File;
}

/** Keep the upload outcome honest about what Core's extraction layer completed. */
function indexNote(index: SpaceFileIndex, tl: LiteralMessage): string {
	switch (index.state) {
		case "indexed":
			return "Stored and searchable";
		case "pending":
			return "Stored — reading its text now";
		case "skipped":
			return "Stored — this node cannot read this format yet";
		case "failed":
			return index.message
				? tl("Stored, but its text could not be read: {message}", {
						message: index.message,
					})
				: "Stored, but its text could not be read";
		case "unattempted":
			return "Stored — its contents have not been indexed";
		default:
			return "Stored";
	}
}

/**
 * Shared file queue for every Space drop zone.
 *
 * `uploadFile` is the existing Core-backed path: it stores the bytes, runs the
 * configured document extraction layer, and reports the indexing outcome. Uploads
 * stay serialized so a multi-file drop does not create several base64 copies at
 * once, and one list refresh happens after the whole batch settles.
 */
export function useSpaceFileUpload(
	spaceId: string | null,
	onBatchSettled?: () => void
) {
	const { reload, uploadFile } = useSpacesContext();
	const [queue, setQueue] = useState<QueuedUpload[]>([]);
	const chainRef = useRef<Promise<void>>(Promise.resolve());
	const sequenceRef = useRef(0);
	const tl = useLiteralMessages();
	const tlRef = useRef(tl);
	tlRef.current = tl;

	const patch = useCallback((id: string, next: Partial<QueuedUpload>) => {
		setQueue((current) =>
			current.map((item) => (item.id === id ? { ...item, ...next } : item))
		);
	}, []);

	const runOne = useCallback(
		async (entry: QueuedUpload, targetSpaceId: string) => {
			patch(entry.id, {
				error: undefined,
				progress: null,
				status: "uploading",
			});
			try {
				const stored = await uploadFile(targetSpaceId, entry.file, {
					onProgress: (fraction) => patch(entry.id, { progress: fraction }),
				});
				patch(entry.id, {
					note: indexNote(stored.index, tlRef.current),
					progress: 1,
					status: "success",
				});
			} catch (error) {
				patch(entry.id, {
					error: error instanceof Error ? error.message : "Upload failed",
					progress: null,
					status: "error",
				});
			}
		},
		[patch, uploadFile]
	);

	const enqueue = useCallback(
		(entries: QueuedUpload[], targetSpaceId: string) => {
			chainRef.current = chainRef.current.then(async () => {
				for (const entry of entries) {
					await runOne(entry, targetSpaceId);
				}
				await reload().catch(() => undefined);
				onBatchSettled?.();
			});
		},
		[onBatchSettled, reload, runOne]
	);

	const onFilesAdded = useCallback(
		(files: File[]) => {
			if (!spaceId) {
				toast.error("Create a space first", {
					description: "There is nowhere to put these files yet.",
				});
				return;
			}

			const entries: QueuedUpload[] = files.map((file) => {
				sequenceRef.current += 1;
				return {
					file,
					id: `${sequenceRef.current}:${file.name}`,
					name: file.name,
					progress: null,
					size: file.size,
					status: "pending",
				};
			});
			const tooBig = entries.filter(
				(entry) => entry.file.size > SPACE_UPLOAD_MAX_BYTES
			);
			const allowed = entries.filter(
				(entry) => entry.file.size <= SPACE_UPLOAD_MAX_BYTES
			);
			setQueue((current) => [
				...current,
				...allowed,
				...tooBig.map((entry) => ({
					...entry,
					error: tlRef.current("Too large — the limit is {limit}.", {
						limit: formatBytes(SPACE_UPLOAD_MAX_BYTES),
					}),
					retryable: false,
					status: "error" as const,
				})),
			]);
			if (allowed.length > 0) {
				enqueue(allowed, spaceId);
			}
		},
		[enqueue, spaceId]
	);

	const onRetry = useCallback(
		(item: FileUploadItem) => {
			const entry = queue.find((candidate) => candidate.id === item.id);
			if (entry && spaceId) {
				enqueue([entry], spaceId);
			}
		},
		[enqueue, queue, spaceId]
	);

	const onRemove = useCallback((item: FileUploadItem) => {
		setQueue((current) =>
			current.filter((candidate) => candidate.id !== item.id)
		);
	}, []);

	const reset = useCallback(() => {
		setQueue([]);
	}, []);

	return {
		onFilesAdded,
		onRemove,
		onRetry,
		queue,
		reset,
		uploading: queue.some((item) => item.status === "uploading"),
	};
}
