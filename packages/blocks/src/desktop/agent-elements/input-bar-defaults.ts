import type { AttachedFile, AttachedImage } from "./input-bar-types.ts";

export interface InputConfig {
	attachmentPreviewStyle: "thumbnail" | "chip" | "hidden";
	inputBarPlaceholder: string;
}

export const DEFAULT_INPUT_CONFIG: InputConfig = {
	inputBarPlaceholder: "What do you want to do?",
	attachmentPreviewStyle: "thumbnail",
};

/** Stable empty lists so attachment-derived memos don't churn every render. */
export const NO_ATTACHED_IMAGES: AttachedImage[] = [];
export const NO_ATTACHED_FILES: AttachedFile[] = [];
