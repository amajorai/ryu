// packages/marketplace/src/catalog/friendly-tokens.ts
//
// Catalog token vocabulary for the shared catalog badges. Split out of friendly.ts, which re-exports
// everything here so `@ryu/marketplace/catalog/friendly` stays the import path.

/** Visual tone for a badge — maps to a Tailwind class set in the badge UI. */
export type BadgeTone =
	| "neutral"
	| "blue"
	| "violet"
	| "amber"
	| "rose"
	| "emerald";

/** A recognized name-token rendered as a labeled, filterable badge. */
export interface CatalogToken {
	/** Lowercase word aliases matched against name segments + tags. */
	aliases: string[];
	/** Stable filter id (also the badge key). */
	id: string;
	/** Human label shown on the badge. */
	label: string;
	tone: BadgeTone;
	/** Hover explanation. */
	tooltip: string;
}

/**
 * Token vocabulary, scanned against a model's name segments and its Hub tags.
 * Order matters only for display grouping; matching is alias-exact per segment.
 */
export const CATALOG_TOKENS: CatalogToken[] = [
	{
		id: "instruct",
		aliases: ["it", "instruct", "inst"],
		label: "Instruct",
		tooltip: "Instruction-tuned — follows chat-style prompts",
		tone: "blue",
	},
	{
		id: "chat",
		aliases: ["chat"],
		label: "Chat",
		tooltip: "Tuned for conversation",
		tone: "blue",
	},
	{
		id: "base",
		aliases: ["base", "pt", "pretrain", "pretrained"],
		label: "Base",
		tooltip: "Pretrained base model — not chat-tuned",
		tone: "neutral",
	},
	{
		id: "reasoning",
		aliases: ["reasoning", "thinking", "think", "reason"],
		label: "Reasoning",
		tooltip: "Tuned to think step-by-step before answering",
		tone: "violet",
	},
	{
		id: "r1",
		aliases: ["r1"],
		label: "R1",
		tooltip: "DeepSeek-R1 style reasoning distillation",
		tone: "violet",
	},
	{
		id: "cot",
		aliases: ["cot"],
		label: "Chain-of-Thought",
		tooltip: "Trained to show its chain-of-thought reasoning",
		tone: "violet",
	},
	{
		id: "mtp",
		aliases: ["mtp"],
		label: "Multi-Token",
		tooltip: "Multi-token prediction — can decode faster",
		tone: "violet",
	},
	{
		id: "uncensored",
		aliases: ["uncensored", "abliterated", "abliter", "unfiltered", "dolphin"],
		label: "Uncensored",
		tooltip: "Safety alignment reduced or removed (e.g. abliterated/Dolphin)",
		tone: "rose",
	},
	{
		id: "qat",
		aliases: ["qat"],
		label: "Quality-Tuned",
		tooltip: "Quantization-aware training — keeps quality high when compressed",
		tone: "emerald",
	},
	{
		id: "finetuned",
		aliases: ["dpo", "sft", "rlhf", "orpo", "kto", "ft", "finetune"],
		label: "Fine-Tuned",
		tooltip: "Further fine-tuned (DPO/SFT/RLHF and similar)",
		tone: "emerald",
	},
	{
		id: "distilled",
		aliases: ["distill", "distilled", "distillation"],
		label: "Distilled",
		tooltip: "Distilled from a larger model — smaller, faster",
		tone: "emerald",
	},
	{
		id: "merged",
		aliases: ["merge", "merged", "slerp", "frankenmerge"],
		label: "Merged",
		tooltip: "A merge of several models",
		tone: "neutral",
	},
	{
		id: "vision",
		aliases: ["vl", "vision", "multimodal", "omni", "image"],
		label: "Vision",
		tooltip: "Understands images as well as text",
		tone: "blue",
	},
	{
		id: "coder",
		aliases: ["coder", "code", "codestral", "starcoder"],
		label: "Coder",
		tooltip: "Specialized for writing and understanding code",
		tone: "blue",
	},
	{
		id: "math",
		aliases: ["math", "maths", "mathstral"],
		label: "Math",
		tooltip: "Specialized for mathematical reasoning",
		tone: "blue",
	},
	{
		id: "moe",
		aliases: ["moe"],
		label: "Mixture-of-Experts",
		tooltip: "Mixture-of-Experts — only part of the model runs per token",
		tone: "violet",
	},
	{
		id: "precision",
		aliases: ["fp16", "f16", "bf16", "fp32", "f32"],
		label: "Full precision",
		tooltip: "Uncompressed weights — highest quality, largest size",
		tone: "neutral",
	},
	{
		id: "gguf",
		aliases: ["gguf", "ggml"],
		label: "GGUF",
		tooltip: "Local-friendly model file format",
		tone: "neutral",
	},
	{
		id: "format",
		aliases: ["onnx", "awq", "gptq", "exl2", "mlx", "safetensors"],
		label: "Other format",
		tooltip: "An alternate weight format",
		tone: "neutral",
	},
	{
		id: "preview",
		aliases: ["preview", "experimental", "beta", "alpha", "rc"],
		label: "Preview",
		tooltip: "Early / experimental release",
		tone: "amber",
	},
	{
		id: "longcontext",
		aliases: ["128k", "256k", "512k", "1m", "long", "longcontext"],
		label: "Long context",
		tooltip: "Handles unusually long inputs",
		tone: "blue",
	},
];
