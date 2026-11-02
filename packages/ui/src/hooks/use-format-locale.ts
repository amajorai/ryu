import { activeLocale } from "@ryu/i18n/lite";
import { useOptionalI18n } from "@ryu/i18n/react";

/**
 * The locale numbers and dates format in: the mounted provider's formatting
 * locale (the user's regional tag, `pt-PT`, while messages come from the
 * pt-BR pack), so
 * a shared component re-renders when the user switches it, or the active
 * locale (English before any provider mounts) when it renders standalone.
 * Never the OS or webview locale, which can disagree with the chosen UI
 * language.
 */
export function useFormatLocale(): string {
	return useOptionalI18n()?.formatLocale ?? activeLocale();
}
