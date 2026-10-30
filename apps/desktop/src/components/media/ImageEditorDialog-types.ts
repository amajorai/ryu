import {
	AspectRatioIcon,
	SmartPhone01Icon,
	SmartPhone02Icon,
	SmartPhoneLandscapeIcon,
	Square01Icon,
	Tv01Icon,
} from "@hugeicons/core-free-icons";
import type { BrowserImageEngine } from "@ryu/browser-local-ai";
import type { ImageResizeAspect } from "@/src/lib/api/image-resize.ts";
import type { ImageResizeRequest } from "@/src/lib/api/images.ts";
import type { NormalizedImagePoint } from "./image-editor-utils.ts";

export const IMAGE_RESIZE_PRESET_ICONS = {
	original: AspectRatioIcon,
	square: Square01Icon,
	landscape: SmartPhoneLandscapeIcon,
	portrait: SmartPhone01Icon,
	widescreen: Tv01Icon,
	story: SmartPhone02Icon,
} satisfies Record<ImageResizeAspect, typeof AspectRatioIcon>;

export type ImageEditorTool = "select" | "markup" | "comment" | "erase";

export type ImageMarkup =
	| {
			color: string;
			id: string;
			kind: "stroke";
			points: NormalizedImagePoint[];
	  }
	| {
			id: string;
			kind: "comment";
			point: NormalizedImagePoint;
			text: string;
	  };

export type ImageEditorOperation =
	| { kind: "ai-resize" }
	| { kind: "segment" }
	| { kind: "background-removal" }
	| { kind: "reset" }
	| { kind: "export" }
	| null;

export const IMAGE_EDITOR_OPERATION_LABELS = {
	"ai-resize": "Expanding image with AI…",
	segment: "Finding subjects…",
	"background-removal": "Removing background…",
	reset: "Restoring original image…",
	export: "Preparing PNG…",
} satisfies Record<Exclude<ImageEditorOperation, null>["kind"], string>;

export interface ImageEditorAsset {
	filename?: string;
	id: string;
	url: string;
}

export interface ImageEditorDialogProps {
	image: ImageEditorAsset | null;
	onAiResize?: (request: ImageResizeRequest) => Promise<Blob>;
	onClose: () => void;
	onOpenDrawesome?: (image: ImageEditorAsset) => void;
	onUseInChat?: (image: File) => void;
	open: boolean;
	runtime?: BrowserImageEngine;
}

export interface ImageDimensions {
	height: number;
	width: number;
}
