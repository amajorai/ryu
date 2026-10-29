import { useOptionalI18n } from "@ryu/i18n/react";

/** The active i18n locale for Calendar date labels; re-renders on change. */
export function useCalendarLocale(): string | undefined {
	return useOptionalI18n()?.locale;
}
