import {
	DEFAULT_BROWSER_IMAGE_MODELS,
	isValidBrowserModelId,
} from "@ryu/browser-local-ai";
import { z } from "zod";

const STORAGE_KEY = "ryu_image_editor_models_v1";

export interface ImageEditorModelPreferences {
	backgroundRemovalModelId: string;
	segmentationModelId: string;
}

export const DEFAULT_IMAGE_EDITOR_MODELS: ImageEditorModelPreferences = {
	backgroundRemovalModelId: DEFAULT_BROWSER_IMAGE_MODELS["background-removal"],
	segmentationModelId: DEFAULT_BROWSER_IMAGE_MODELS["image-segmentation"],
};

const browserModelIdSchema = z
	.string()
	.refine(isValidBrowserModelId)
	.transform((value) => value.trim());
const imageEditorModelPreferencesSchema = z.object({
	backgroundRemovalModelId: browserModelIdSchema.catch(
		DEFAULT_IMAGE_EDITOR_MODELS.backgroundRemovalModelId
	),
	segmentationModelId: browserModelIdSchema.catch(
		DEFAULT_IMAGE_EDITOR_MODELS.segmentationModelId
	),
}) satisfies z.ZodType<ImageEditorModelPreferences>;

export function parseImageEditorModelPreferences(
	value: Parameters<typeof imageEditorModelPreferencesSchema.parse>[0]
): ImageEditorModelPreferences {
	const parsed = imageEditorModelPreferencesSchema.safeParse(value);
	return parsed.success ? parsed.data : { ...DEFAULT_IMAGE_EDITOR_MODELS };
}

export function getImageEditorModelPreferences(): ImageEditorModelPreferences {
	if (!("localStorage" in globalThis)) {
		return { ...DEFAULT_IMAGE_EDITOR_MODELS };
	}
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return { ...DEFAULT_IMAGE_EDITOR_MODELS };
		}
		return parseImageEditorModelPreferences(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_IMAGE_EDITOR_MODELS };
	}
}

export function saveImageEditorModelPreferences(
	preferences: ImageEditorModelPreferences
): boolean {
	if (!("localStorage" in globalThis)) {
		return false;
	}
	if (
		!(
			isValidBrowserModelId(preferences.backgroundRemovalModelId) &&
			isValidBrowserModelId(preferences.segmentationModelId)
		)
	) {
		return false;
	}
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
		return true;
	} catch {
		return false;
	}
}
