"use client";

import { useLocalizedText } from "@ryu/i18n/react";

/**
 * Data copy (a JSON field, a FAQ answer) rendered in the reader's language
 * from a server component. The text is looked up by its exact English source
 * in the official catalog; text the catalog does not hold (names, user data)
 * renders as written, never through message formatting.
 */
export function LiteralText({ text }: { text: string }) {
	return <>{useLocalizedText(text, { literal: true })}</>;
}
