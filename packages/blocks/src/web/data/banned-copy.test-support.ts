/**
 * Copy guard list, never rendered. It lives in a `.test-support.ts` file so the
 * i18n extractor skips it (these are not UI strings); import it through
 * `./banned-copy.ts`.
 *
 * Words and phrases public product copy must not use: internal jargon, rivals'
 * names, unverifiable counts and overclaims. Catalog copy (products.test.ts)
 * and product profile copy (../product-page/profiles.ts) are both checked
 * against this one list.
 */
export const BANNED_COPY: readonly string[] = [
	"apps/skills",
	"apps/mcp",
	"NEEDS_AUTH",
	"identity.read",
	"Pokémon",
	"workcell",
	"BYOA",
	"BYOS",
	"Runnable",
	"sidecar",
	"Restate",
	"sqlite-vec",
	"BuzzKit",
	"Cactus Compute",
	"ZeroClaw",
	"Palantir",
	"supply-side",
	"demand-side",
	"~16 sidecars",
	"Parity with Codex",
	"Hundreds of",
	"20+ tools",
	"Self-improving",
	"improves itself",
	"Promptfoo",
	"Mac-like",
	"Northstar Studio",
	"Customize",
];

/** Every banned entry that appears (case-sensitive, as products.test.ts checks) in any text. */
export function bannedCopyHits(texts: readonly string[]): string[] {
	const hits = new Set<string>();
	for (const text of texts) {
		for (const banned of BANNED_COPY) {
			if (text.includes(banned)) {
				hits.add(banned);
			}
		}
	}
	return [...hits];
}
