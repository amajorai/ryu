import { z } from "zod";
import type {
	ByokProvider,
	GatewayProvidersConfig,
	GatewayProviderView,
	ProviderKind,
} from "@/src/lib/api/gateway.ts";

export const GATEWAY_PROVIDER_LABELS = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	local: "Local",
	openrouter: "OpenRouter",
	core: "Core",
	genai: "Gemini",
	mistral: "Mistral",
	huggingface: "Hugging Face",
	nvidia: "NVIDIA NIM",
	together: "Together AI",
	fireworks: "Fireworks AI",
} satisfies Record<ProviderKind, string>;

/** Contract of a redacted direct-provider entry at the gateway boundary. */
const providerViewSchema = z.object({
	api_key: z.string(),
	base_url: z.string(),
	api_key_count: z.number().optional(),
});

export function gatewayProviderLabel(provider: string): string {
	return (
		Object.entries(GATEWAY_PROVIDER_LABELS).find(
			([id]) => id === provider
		)?.[1] ?? provider
	);
}

function directProviderView(
	providers: GatewayProvidersConfig | null,
	slug: ByokProvider
): GatewayProviderView | null {
	const compatible = providers?.compatible?.[slug];
	if (compatible) {
		return compatible;
	}
	const entry = Object.entries(providers ?? {}).find(
		([id]) => id === slug
	)?.[1];
	const parsed = providerViewSchema.safeParse(entry);
	if (
		parsed.success &&
		(!("api_key_count" in parsed.data) ||
			parsed.data.api_key_count !== undefined)
	) {
		return parsed.data;
	}
	return null;
}

export function byokAccountCount(
	providers: GatewayProvidersConfig | null,
	slug: ByokProvider
): number {
	if (slug.startsWith("genai-")) {
		return (
			providers?.genai?.sdk_providers?.find(
				(entry) => entry.account_scope === slug
			)?.account_count ?? 0
		);
	}
	if (slug === "gemini") {
		return (
			providers?.genai?.gemini_account_count ??
			(providers?.genai?.keys.includes("gemini") ? 1 : 0)
		);
	}
	const view = directProviderView(providers, slug);
	return view?.api_key_count ?? (view?.api_key ? 1 : 0);
}

export function isByokProviderSet(
	providers: GatewayProvidersConfig | null,
	slug: ByokProvider
): boolean {
	if (slug.startsWith("genai-")) {
		const entry = providers?.genai?.sdk_providers?.find(
			(value) => value.account_scope === slug
		);
		return entry?.configured ?? byokAccountCount(providers, slug) > 0;
	}
	return byokAccountCount(providers, slug) > 0;
}
