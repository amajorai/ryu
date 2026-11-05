import type { LanguagePack } from "./pack.ts";

/**
 * macOS menu-bar titles whose English matches a button verb or a canvas
 * control ("Edit", "Zoom") but whose platform term differs in other
 * languages: the Edit menu is a noun ("Édition", "Правка"), and Window ▸ Zoom
 * maximizes the window rather than magnifying content. They get their own
 * ids so a menu title never shares a translation with an Edit button.
 *
 * Their official translations live here, beside the source, using each
 * language's macOS menu terms; `messages.ts` merges them into the official
 * packs. Keep ids stable: community packs translate them by id.
 */
export const EN_NATIVE_MENU_MESSAGES = {
	"nativeMenu.edit": "Edit",
	"nativeMenu.zoom": "Zoom",
} as const;

export type NativeMenuMessageId = keyof typeof EN_NATIVE_MENU_MESSAGES;

type NativeMenuMessages = Readonly<Record<NativeMenuMessageId, string>>;

/** The platform's own menu terms, by official pack locale. */
export const OFFICIAL_NATIVE_MENU_MESSAGES: Readonly<
	Record<string, NativeMenuMessages>
> = {
	ar: { "nativeMenu.edit": "تحرير", "nativeMenu.zoom": "تكبير/تصغير" },
	de: { "nativeMenu.edit": "Bearbeiten", "nativeMenu.zoom": "Zoomen" },
	es: { "nativeMenu.edit": "Edición", "nativeMenu.zoom": "Zoom" },
	fr: { "nativeMenu.edit": "Édition", "nativeMenu.zoom": "Réduire/agrandir" },
	hi: { "nativeMenu.edit": "संपादन", "nativeMenu.zoom": "ज़ूम करें" },
	it: { "nativeMenu.edit": "Composizione", "nativeMenu.zoom": "Zoom" },
	ja: { "nativeMenu.edit": "編集", "nativeMenu.zoom": "拡大/縮小" },
	ko: { "nativeMenu.edit": "편집", "nativeMenu.zoom": "확대/축소" },
	"pt-BR": { "nativeMenu.edit": "Editar", "nativeMenu.zoom": "Zoom" },
	ru: { "nativeMenu.edit": "Правка", "nativeMenu.zoom": "Изменить масштаб" },
	"zh-CN": { "nativeMenu.edit": "编辑", "nativeMenu.zoom": "缩放" },
};

/** `pack` with its locale's native menu terms added, when it has any. */
export function withNativeMenuMessages(pack: LanguagePack): LanguagePack {
	const messages = OFFICIAL_NATIVE_MENU_MESSAGES[pack.locale];
	return messages
		? { ...pack, messages: { ...pack.messages, ...messages } }
		: pack;
}
