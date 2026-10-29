/** A model that can be prepared by the browser Transformers.js runtime. */
export interface BrowserModelDefinition {
	capabilities: BrowserModelCapabilities;
	/** Whether this entry is one of the low-friction defaults shown first. */
	curated: boolean;
	description: string;
	id: string;
	name: string;
	status: BrowserModelStatus;
	statusMessage?: string;
	task: "text-generation";
}

export interface BrowserModelCapabilities {
	actionSupport: boolean;
	chatSupport: boolean;
	visionSupport: boolean;
}

export type BrowserImageTask = "image-segmentation" | "background-removal";

export interface BrowserImageModelDefinition {
	description: string;
	id: string;
	name: string;
	task: BrowserImageTask;
}

export type BrowserModelStatus =
	| "ready"
	| "not-prepared"
	| "preparing"
	| "failed"
	| "unsupported";

export interface BrowserModelStatusUpdate {
	progress?: number;
	status: BrowserModelStatus;
	statusMessage?: string;
}

const CHAT_ONLY: BrowserModelCapabilities = {
	actionSupport: false,
	chatSupport: true,
	visionSupport: false,
};

const ACTION_READY: BrowserModelCapabilities = {
	actionSupport: true,
	chatSupport: true,
	visionSupport: false,
};

/**
 * These defaults intentionally use ONNX Community browser exports. They are
 * browser artifacts and are not the same thing as a Core model installation.
 */
export const CURATED_BROWSER_MODELS: readonly BrowserModelDefinition[] = [
	{
		capabilities: CHAT_ONLY,
		curated: true,
		description: "Instruction-tuned small chat model for any browser surface.",
		id: "onnx-community/SmolLM2-135M-Instruct-ONNX-MHA",
		name: "SmolLM2 135M Instruct",
		status: "not-prepared",
		task: "text-generation",
	},
	{
		capabilities: CHAT_ONLY,
		curated: true,
		description: "Phi-3.5 instruct model for richer local answers.",
		id: "onnx-community/Phi-3.5-mini-instruct-onnx-web",
		name: "Phi-3.5 Mini",
		status: "not-prepared",
		task: "text-generation",
	},
	{
		capabilities: CHAT_ONLY,
		curated: true,
		description: "Llama 3.2 1B quantized for browser chat.",
		id: "onnx-community/Llama-3.2-1B-Instruct-q4f16",
		name: "Llama 3.2 1B",
		status: "not-prepared",
		task: "text-generation",
	},
	{
		capabilities: ACTION_READY,
		curated: true,
		description: "Structured-action candidate for browser automation loops.",
		id: "onnx-community/Qwen3-0.6B-ONNX",
		name: "Qwen3 0.6B",
		status: "not-prepared",
		task: "text-generation",
	},
];

export const DEFAULT_BROWSER_MODEL_ID =
	CURATED_BROWSER_MODELS[0]?.id ??
	"onnx-community/SmolLM2-135M-Instruct-ONNX-MHA";

/** Transformers.js image models that have browser-compatible ONNX exports. */
export const CURATED_BROWSER_IMAGE_MODELS = {
	"background-removal": [
		{
			description: "Portrait matting with transparent background output.",
			id: "Xenova/modnet",
			name: "MODNet",
			task: "background-removal",
		},
	],
	"image-segmentation": [
		{
			description: "Panoptic object masks with labels for subject selection.",
			id: "Xenova/detr-resnet-50-panoptic",
			name: "DETR Panoptic",
			task: "image-segmentation",
		},
	],
} as const satisfies Record<
	BrowserImageTask,
	readonly BrowserImageModelDefinition[]
>;

export const DEFAULT_BROWSER_IMAGE_MODELS = {
	"background-removal": "Xenova/modnet",
	"image-segmentation": "Xenova/detr-resnet-50-panoptic",
} satisfies Record<BrowserImageTask, string>;

const MODEL_ID_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Reject URLs, paths, revisions, and traversal-looking values at the UI edge. */
export function isValidBrowserModelId(modelId: string): boolean {
	return MODEL_ID_PATTERN.test(modelId.trim()) && !modelId.includes("../");
}

export function browserModelCapabilities(
	modelId: string
): BrowserModelCapabilities {
	const curated = CURATED_BROWSER_MODELS.find((model) => model.id === modelId);
	if (curated) {
		return curated.capabilities;
	}
	// Arbitrary Hub models remain chat-only until the user explicitly supplies a
	// model with a compatible structured-action template. This prevents an
	// unverified model from receiving browser write tools by accident.
	return modelId.toLowerCase().includes("qwen") ? ACTION_READY : CHAT_ONLY;
}

export function browserModelName(modelId: string): string {
	return (
		CURATED_BROWSER_MODELS.find((model) => model.id === modelId)?.name ??
		modelId
	);
}

export function createBrowserModelDefinition(
	modelId: string,
	status: BrowserModelStatus = "not-prepared"
): BrowserModelDefinition {
	const normalized = modelId.trim();
	if (!isValidBrowserModelId(normalized)) {
		throw new Error("Use a Hugging Face model id such as org/model.");
	}
	const curated = CURATED_BROWSER_MODELS.find(
		(model) => model.id === normalized
	);
	return curated
		? { ...curated, status }
		: {
				capabilities: browserModelCapabilities(normalized),
				curated: false,
				description:
					"Custom Hugging Face model; chat-only until capabilities are verified.",
				id: normalized,
				name: browserModelName(normalized),
				status,
				task: "text-generation",
			};
}

export function browserModelCatalog(
	statuses: ReadonlyMap<string, BrowserModelStatusUpdate>
): BrowserModelDefinition[] {
	return CURATED_BROWSER_MODELS.map((model) => {
		const state = statuses.get(model.id);
		return state ? { ...model, ...state } : { ...model };
	});
}
