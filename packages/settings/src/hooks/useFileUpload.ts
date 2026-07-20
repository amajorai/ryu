import { useCallback, useState } from "react";
import { sileo } from "sileo";
import { settingsApi } from "../utils/api-client.ts";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

export function useFileUpload() {
	const [isUploading, setIsUploading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const validateFile = useCallback((file: File): string | null => {
		if (!ALLOWED_TYPES.includes(file.type)) {
			return "Invalid file type. Please upload a JPEG, PNG, or WebP image.";
		}

		if (file.size > MAX_FILE_SIZE) {
			return "File is too large. Maximum size is 10MB.";
		}

		return null;
	}, []);

	// `upload` lets a caller retarget this at a different owner (org / team) while
	// keeping identical validation, toasts, and busy state. Defaults to the
	// signed-in user's own avatar, so existing callers are unchanged.
	const uploadAvatar = useCallback(
		async (
			file: File,
			upload: (f: File) => Promise<{ message?: string }> = (f) =>
				settingsApi.profile.uploadAvatar(f)
		): Promise<void> => {
			const validationError = validateFile(file);
			if (validationError) {
				setError(validationError);
				sileo.error({ title: validationError });
				return;
			}

			setIsUploading(true);
			setError(null);

			try {
				const result = await upload(file);
				sileo.success({
					title: result.message ?? "Your avatar was uploaded.",
				});
			} catch (err) {
				const message =
					err instanceof Error ? err.message : "Failed to upload avatar";
				setError(message);
				sileo.error({ title: message });
				throw err;
			} finally {
				setIsUploading(false);
			}
		},
		[validateFile]
	);

	return {
		uploadAvatar,
		isUploading,
		error,
		validateFile,
	};
}
