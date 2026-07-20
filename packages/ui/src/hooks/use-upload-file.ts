import {
	type EditorUploader,
	getEditorUploader,
} from "@ryu/ui/lib/editor-upload.ts";
import { useCallback, useState } from "react";
import { toast } from "sonner";

/** What the editor's media nodes read after an upload completes. */
export interface UploadedFile {
	key: string;
	name: string;
	size: number;
	type: string;
	url: string;
}

interface UseUploadFileProps {
	onUploadComplete?: (file: UploadedFile) => void;
	onUploadError?: (error: unknown) => void;
}

/**
 * Uploads editor media through the host-registered uploader
 * (see `@ryu/ui/lib/editor-upload`). For Ryu desktop that is Core's local
 * media store, so images are saved on the machine and served back over HTTP.
 */
export function useUploadFile({
	onUploadComplete,
	onUploadError,
}: UseUploadFileProps = {}) {
	const [uploadedFile, setUploadedFile] = useState<UploadedFile>();
	const [uploadingFile, setUploadingFile] = useState<File>();
	const [progress, setProgress] = useState(0);
	const [isUploading, setIsUploading] = useState(false);

	const uploadFile = useCallback(
		async (file: File) => {
			setIsUploading(true);
			setUploadingFile(file);
			try {
				const upload: EditorUploader = getEditorUploader();
				const res = await upload(file, (percent) =>
					setProgress(Math.min(percent, 100))
				);
				const done: UploadedFile = {
					key: res.url,
					url: res.url,
					name: res.name,
					size: res.size,
					type: res.type,
				};
				setUploadedFile(done);
				onUploadComplete?.(done);
				return done;
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Upload failed, please try again later.";
				toast.error(message);
				onUploadError?.(error);
				throw error;
			} finally {
				setProgress(0);
				setIsUploading(false);
				setUploadingFile(undefined);
			}
		},
		[onUploadComplete, onUploadError]
	);

	return {
		isUploading,
		progress,
		uploadedFile,
		uploadFile,
		uploadingFile,
	};
}

export function getErrorMessage(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return "Something went wrong, please try again later.";
}

export function showErrorToast(err: unknown) {
	return toast.error(getErrorMessage(err));
}
