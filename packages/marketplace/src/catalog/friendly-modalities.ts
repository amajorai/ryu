// packages/marketplace/src/catalog/friendly-modalities.ts
//
// Input/output modalities derived from the HF pipeline tag. Split out of friendly.ts, which re-exports
// everything here so `@ryu/marketplace/catalog/friendly` stays the import path.

// ── Input/output modalities (from the HF pipeline tag) ──────────────────────

/** A data modality a model accepts or produces. */
export type Modality = "text" | "image" | "pdf" | "video" | "audio";

/** What a model takes in and puts out, derived from its pipeline tag. */
export interface ModalityFlow {
	inputs: Modality[];
	outputs: Modality[];
}

/** Canonical display order for modality icon rows. */
const MODALITY_ORDER: Modality[] = ["text", "image", "pdf", "video", "audio"];

/** Pipeline tags that don't follow the `<in>-to-<out>` shape. */
interface PipelineModalityLookup {
	[pipelineTag: string]: ModalityFlow | undefined;
}

const FIXED_MODALITIES: PipelineModalityLookup = {
	"text-generation": { inputs: ["text"], outputs: ["text"] },
	"text2text-generation": { inputs: ["text"], outputs: ["text"] },
	"fill-mask": { inputs: ["text"], outputs: ["text"] },
	summarization: { inputs: ["text"], outputs: ["text"] },
	translation: { inputs: ["text"], outputs: ["text"] },
	"question-answering": { inputs: ["text"], outputs: ["text"] },
	"table-question-answering": { inputs: ["text"], outputs: ["text"] },
	"feature-extraction": { inputs: ["text"], outputs: ["text"] },
	"sentence-similarity": { inputs: ["text"], outputs: ["text"] },
	"text-ranking": { inputs: ["text"], outputs: ["text"] },
	"text-classification": { inputs: ["text"], outputs: ["text"] },
	"token-classification": { inputs: ["text"], outputs: ["text"] },
	"zero-shot-classification": { inputs: ["text"], outputs: ["text"] },
	"automatic-speech-recognition": { inputs: ["audio"], outputs: ["text"] },
	"audio-classification": { inputs: ["audio"], outputs: ["text"] },
	"image-classification": { inputs: ["image"], outputs: ["text"] },
	"image-segmentation": { inputs: ["image"], outputs: ["text"] },
	"object-detection": { inputs: ["image"], outputs: ["text"] },
	"zero-shot-image-classification": { inputs: ["image"], outputs: ["text"] },
	"image-feature-extraction": { inputs: ["image"], outputs: ["text"] },
	"video-classification": { inputs: ["video"], outputs: ["text"] },
	"visual-question-answering": { inputs: ["text", "image"], outputs: ["text"] },
	"document-question-answering": {
		inputs: ["text", "pdf"],
		outputs: ["text"],
	},
};

/** Map one tag word to a modality (returns `null` for non-modality words). */
function wordToModality(word: string): Modality | null {
	switch (word) {
		case "text":
			return "text";
		case "image":
			return "image";
		case "audio":
		case "speech":
			return "audio";
		case "video":
			return "video";
		case "document":
		case "pdf":
			return "pdf";
		default:
			return null;
	}
}

/** Modalities named in one side of a pipeline tag (`any` → every modality). */
function segmentModalities(segment: string): Modality[] {
	if (segment === "any") {
		return [...MODALITY_ORDER];
	}
	const found = new Set<Modality>();
	for (const word of segment.split("-")) {
		const m = wordToModality(word);
		if (m) {
			found.add(m);
		}
	}
	return MODALITY_ORDER.filter((m) => found.has(m));
}

/**
 * Derive the input and output modalities from a Hugging Face `pipeline_tag`.
 * Returns `null` when the tag is missing or unrecognized, so callers omit the row.
 */
export function parsePipelineModalities(
	pipelineTag: string | null
): ModalityFlow | null {
	if (!pipelineTag) {
		return null;
	}
	const tag = pipelineTag.toLowerCase().trim();
	const fixed = FIXED_MODALITIES[tag];
	if (fixed) {
		return fixed;
	}
	const idx = tag.indexOf("-to-");
	if (idx !== -1) {
		const inputs = segmentModalities(tag.slice(0, idx));
		const outputs = segmentModalities(tag.slice(idx + "-to-".length));
		if (inputs.length > 0 && outputs.length > 0) {
			return { inputs, outputs };
		}
	}
	return null;
}
