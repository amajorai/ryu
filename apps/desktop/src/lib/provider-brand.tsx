// apps/desktop/src/lib/provider-brand.tsx
//
// Shared LLM-provider brand-mark resolution. Maps a provider's id/label/api text
// onto a bundled svgl.app slug (themed light/dark where the mark needs it), read
// from `/logos/<slug>.svg` via {@link SvglIcon} — no remote fetch. Used by both
// the standalone LLM Providers settings surface and the composer's universal
// picker so a provider's logo is identical everywhere.

import { SvglIcon, type SvglSpec } from "@ryu/blocks/web/svgl-icon.tsx";

// Ordered most-specific-first so "openai-codex" resolves to the OpenAI mark, etc.
// A provider with no known mark (custom endpoints, Fireworks) resolves to null so
// the caller can fall back to its own placeholder — never a wrong brand.
export const PROVIDER_SVGL: [string, SvglSpec][] = [
	["anthropic", "claude"],
	["claude", "claude"],
	// Azure OpenAI's label literally contains "openai" — match its own brand FIRST
	// so it resolves to the Azure mark, not the OpenAI one.
	["azure", "azure"],
	["codex", { light: "openai", dark: "openai_dark" }],
	["openai", { light: "openai", dark: "openai_dark" }],
	["gemini", "gemini"],
	["vertex", "gemini"],
	["google", "gemini"],
	["mistral", "mistral-ai_logo"],
	["copilot", { light: "copilot", dark: "copilot_dark" }],
	["github", { light: "copilot", dark: "copilot_dark" }],
	["cursor", { light: "cursor_light", dark: "cursor_dark" }],
	["grok", { light: "grok-light", dark: "grok-dark" }],
	["xai", { light: "grok-light", dark: "grok-dark" }],
	["deepseek", "deepseek"],
	["perplexity", "perplexity"],
	["cohere", "cohere"],
	["groq", "groq"],
	["cerebras", { light: "cerebras_light", dark: "cerebras_dark" }],
	["together", { light: "togetherai_light", dark: "togetherai_dark" }],
	["nvidia", { light: "nvidia_light", dark: "nvidia_dark" }],
	["moonshot", { light: "kimi-icon", dark: "kimi-icon-dark" }],
	["kimi", { light: "kimi-icon", dark: "kimi-icon-dark" }],
	["minimax", "minimax"],
	["huggingface", "huggingface"],
	["zai", "zai"],
	["glm", "zai"],
	["qwen", { light: "qwen_light", dark: "qwen_dark" }],
	["bedrock", { light: "aws_light", dark: "aws_dark" }],
	["amazon", { light: "aws_light", dark: "aws_dark" }],
	["aws", { light: "aws_light", dark: "aws_dark" }],
	["cloudflare", "cloudflare"],
	["openrouter", { light: "openrouter_light", dark: "openrouter_dark" }],
	["ollama", { light: "ollama_light", dark: "ollama_dark" }],
];

/** Resolve a provider id/label/api string onto a bundled brand mark, else null. */
export function svglForProvider(haystack: string): SvglSpec | null {
	const hay = haystack.toLowerCase();
	for (const [needle, spec] of PROVIDER_SVGL) {
		if (hay.includes(needle)) {
			return spec;
		}
	}
	return null;
}

/**
 * A provider's bundled brand mark, or `null` when none is known (so the caller
 * renders its own placeholder). Just the logo — no border or background chrome.
 */
export function ProviderBrandLogo({
	providerKey,
	className,
	size = 16,
}: {
	providerKey: string;
	className?: string;
	size?: number;
}) {
	const spec = svglForProvider(providerKey);
	if (!spec) {
		return null;
	}
	return <SvglIcon className={className} size={size} spec={spec} />;
}
