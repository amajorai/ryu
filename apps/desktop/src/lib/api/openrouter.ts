import { z } from "zod";

/** Public OpenRouter provider catalog; it contains no account or request data. */
export const OPENROUTER_PROVIDERS_URL =
	"https://openrouter.ai/api/v1/providers";

export interface OpenRouterProvider {
	name: string;
	slug: string;
}

const CACHE_MS = 5 * 60 * 1000;
let cachedProviders: {
	expiresAt: number;
	providers: OpenRouterProvider[];
} | null = null;

// The public endpoint publishes name/slug rows. A malformed row is skipped;
// a missing/non-string/empty display name falls back to its nonempty slug.
const providerRowSchema = z
	.object({
		slug: z.string(),
		name: z.string().catch(""),
	})
	.transform((entry): OpenRouterProvider | null => {
		const slug = entry.slug.trim();
		if (!slug) {
			return null;
		}
		return { name: entry.name.trim() || slug, slug };
	})
	.catch(null);
const providerCatalogSchema = z.object({ data: z.array(providerRowSchema) });

export function parseOpenRouterProviders(
	payload: Parameters<typeof providerCatalogSchema.safeParse>[0]
): OpenRouterProvider[] {
	const catalog = providerCatalogSchema.safeParse(payload);
	if (!catalog.success) {
		throw new Error("OpenRouter returned an unexpected provider catalog.");
	}
	const providers = catalog.data.data.filter((entry) => entry !== null);

	if (providers.length === 0) {
		throw new Error("OpenRouter returned no usable providers.");
	}
	return providers.sort((a, b) => a.name.localeCompare(b.name));
}

/** Fetch the public catalog without an OpenRouter key or any user information. */
export async function fetchOpenRouterProviders(): Promise<
	OpenRouterProvider[]
> {
	if (cachedProviders && cachedProviders.expiresAt > Date.now()) {
		return cachedProviders.providers;
	}

	const response = await fetch(OPENROUTER_PROVIDERS_URL, {
		headers: { Accept: "application/json" },
	});
	if (!response.ok) {
		throw new Error(`OpenRouter provider catalog failed (${response.status}).`);
	}

	const providers = parseOpenRouterProviders(await response.json());
	cachedProviders = { expiresAt: Date.now() + CACHE_MS, providers };
	return providers;
}
