import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";

const MIN_SYMBOL = 3;
const MAX_SYMBOL = 4;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const FALLBACK_SYMBOL = "AGT";

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

/** Upper-case ASCII letter words of a name ("Café Bot 2" → ["CAFE", "BOT"]). */
function letterWords(name: string): string[] {
	return name
		.normalize("NFKD")
		.toUpperCase()
		.split(/[^A-Z]+/)
		.filter(Boolean);
}

/** Every 3- and 4-letter in-order pick from `letters` that starts with its first. */
function* letterPicks(letters: string): Generator<string> {
	const head = letters[0] ?? "";
	const rest = letters.slice(1);
	for (let first = 0; first < rest.length; first++) {
		for (let second = first + 1; second < rest.length; second++) {
			yield `${head}${rest[first]}${rest[second]}`;
		}
	}
	for (let first = 0; first < rest.length; first++) {
		for (let second = first + 1; second < rest.length; second++) {
			for (let third = second + 1; third < rest.length; third++) {
				yield `${head}${rest[first]}${rest[second]}${rest[third]}`;
			}
		}
	}
}

/**
 * Symbol candidates for a name, best first: initials for multi-word names, the
 * whole name when it is already 3–4 letters, then its consonant skeleton
 * ("Forge" → FRG, "Cipher" → CPHR), then plain prefixes, then other in-order
 * letter picks.
 */
export function symbolCandidates(name: string): string[] {
	const words = letterWords(name);
	const letters = words.join("");
	const candidates: string[] = [];
	if (words.length > 1) {
		const initials = words.map((word) => word[0]).join("");
		const last = words.at(-1) ?? "";
		candidates.push(
			initials.length >= MIN_SYMBOL
				? initials.slice(0, MAX_SYMBOL)
				: `${initials}${last.slice(1, 1 + MIN_SYMBOL - initials.length)}`
		);
	}
	if (letters.length >= MIN_SYMBOL && letters.length <= MAX_SYMBOL) {
		candidates.push(letters);
	}
	const skeleton = `${letters.slice(0, 1)}${letters.slice(1).replace(/[AEIOUY]/g, "")}`;
	candidates.push(skeleton.slice(0, MAX_SYMBOL), letters.slice(0, MIN_SYMBOL));
	candidates.push(letters.slice(0, MAX_SYMBOL));
	candidates.push(...letterPicks(letters.slice(0, 10)));
	const valid = candidates.filter(
		(candidate) =>
			candidate.length >= MIN_SYMBOL && candidate.length <= MAX_SYMBOL
	);
	return [...new Set(valid)];
}

/**
 * A unique 3–4 letter symbol per agent, assigned in snapshot order so an agent
 * keeps its symbol when newer agents arrive. Names too short or without Latin
 * letters fall back to their letters padded from `AGT`, then a letter suffix.
 */
export function tickerSymbols(agents: InterfaceAgent[]): Map<string, string> {
	const taken = new Set<string>();
	const symbols = new Map<string, string>();
	for (const agent of agents) {
		const letters = letterWords(agent.name).join("");
		const base = `${letters}${FALLBACK_SYMBOL}`.slice(0, MIN_SYMBOL);
		let symbol = symbolCandidates(agent.name).find(
			(candidate) => !taken.has(candidate)
		);
		for (const suffix of ALPHABET) {
			if (symbol) {
				break;
			}
			const candidate = `${base}${suffix}`;
			symbol = taken.has(candidate) ? undefined : candidate;
		}
		for (const first of ALPHABET) {
			for (const second of ALPHABET) {
				if (symbol) {
					break;
				}
				const candidate = `${base.slice(0, 2)}${first}${second}`;
				symbol = taken.has(candidate) ? undefined : candidate;
			}
		}
		const resolved = symbol ?? `${base}${taken.size}`;
		taken.add(resolved);
		symbols.set(agent.id, resolved);
	}
	return symbols;
}
