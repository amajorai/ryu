import { useOptionalI18n } from "@ryu/i18n/react";

/**
 * "Link" as a hyperlink noun (fr "Lien", ru "Ссылка"). It reads through the
 * keyed `editor.hyperlink`: the bare catalog "Link" is the account-linking
 * verb (fr "Associer", ru "Привязать").
 */
export function useHyperlinkLabel(): string {
	return useOptionalI18n()?.t("editor.hyperlink", {}, "Link") ?? "Link";
}
