import type { MessageId } from "./en-messages.ts";
import { polishLiteralMessages } from "./locale-pl-literals.ts";
import { POLISH_LOGIN_MESSAGES } from "./locale-pl-login.ts";
import { POLISH_MESSAGES_A } from "./locale-pl-messages-a.ts";
import { POLISH_MESSAGES_B } from "./locale-pl-messages-b.ts";
import type { LanguagePack } from "./pack.ts";

/**
 * Every named message in Polish. Its native menu and sense ids sit beside
 * their source like every other locale's (`en-messages-native-menu.ts`,
 * `en-messages-senses*.ts`).
 */
const POLISH_MESSAGES: Record<MessageId, string> = {
	...POLISH_MESSAGES_A,
	...POLISH_MESSAGES_B,
	...POLISH_LOGIN_MESSAGES,
};

/**
 * The official Polish pack. It has its own files because `locales.ts`,
 * `login-locales.ts` and `literal-translations.ts` are already over the
 * staged file size limits; `official-language-packs.ts` lists it with the
 * packs from `locales.ts`.
 */
export const POLISH_LANGUAGE_PACK: LanguagePack = {
	baseLocale: "en",
	direction: "ltr",
	enabled: true,
	id: "official/pl",
	locale: "pl",
	messages: { ...POLISH_MESSAGES, ...polishLiteralMessages() },
	name: "Polski",
	schemaVersion: 1,
	version: "1.0.0",
};
