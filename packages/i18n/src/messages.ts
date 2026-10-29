import { OFFICIAL_LANGUAGE_PACKS } from "./locales.ts";
import type { LanguagePack } from "./pack.ts";

export { EN_MESSAGES, type MessageId } from "./en-messages.ts";

/**
 * First-party packs stay in the synchronous catalog so every surface can
 * render offline and resolve auto-detect before a node or Marketplace request
 * exists. The flavor pack below demonstrates the same partial-overlay format
 * community authors use.
 *
 * `built-in-pack-info.ts` mirrors each pack's identity without its messages
 * (asserted by `built-in-packs.test.ts`); keep the two lists in step.
 */
export const BUILT_IN_LANGUAGE_PACKS: readonly LanguagePack[] = [
	...OFFICIAL_LANGUAGE_PACKS,
	{
		baseLocale: "en",
		direction: "ltr",
		enabled: true,
		id: "en-x-ryu-online",
		locale: "en",
		messages: {
			"common.active": "We are so back",
			"common.enable": "Turn it on",
			"common.install": "Yeet it in",
			"common.marketplace": "The Bazaar",
			"chat.new": "Fresh chat",
			"language.choose": "Pick the words your Ryu wears.",
			"language.title": "Language & vibes",
			"marketplace.from": "From the Bazaar",
			"marketplace.language_packs": "Word packs",
			"marketplace.search": "Search the Bazaar…",
			"nav.marketplace": "The Bazaar",
			"sample.greeting": "Welcome to Ryu, {name}. The vibes are immaculate.",
		},
		name: "English (chronically online)",
		schemaVersion: 1,
		version: "1.0.0",
	},
];
