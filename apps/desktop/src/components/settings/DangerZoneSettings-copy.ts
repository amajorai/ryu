import type { LiteralMessage } from "@ryu/i18n/react";
import type { DangerCategory } from "@/src/components/settings/DangerZoneSettings-data.ts";

// Translated copy for one Settings → Danger Zone row. Core serves each
// category's title, noun, confirm word and detail as plain English (kernel ones
// from `data_admin.rs`, app ones from `contributes.data_categories`), so the
// row cannot splice them into a translated frame: an English noun inside a
// Japanese sentence, and no plural forms at all.
//
// Kernel categories (chats, spaces, memory) get whole ICU messages written
// here, so every locale owns the noun and its plural. App categories get their
// title and detail looked up by their exact text (the extractor reads both, and
// the confirm word, from every store manifest) and a neutral "{count} items"
// count: a manifest declares a single English noun with no plural forms.

type Category = Pick<
	DangerCategory,
	"confirm_word" | "count" | "detail" | "id" | "title"
>;

interface KernelCopy {
	/** "This will delete N … . <detail> This cannot be undone." */
	body: (count: number) => string;
	/** The word shown in the type-to-confirm prompt. */
	confirmWord: () => string;
	/** "N … deleted." */
	deleted: (count: number) => string;
	/** "N …", or the empty-state line when `count` is 0. */
	summary: (count: number) => string;
	title: () => string;
}

function kernelCopy(id: string, tl: LiteralMessage): KernelCopy | null {
	switch (id) {
		case "chats":
			return {
				body: (count) =>
					tl(
						"This will delete {count, plural, one {# chat} other {# chats}}. Every conversation and all of its messages will be permanently deleted. This cannot be undone.",
						{ count }
					),
				confirmWord: () => tl("Chats"),
				deleted: (count) =>
					tl("{count, plural, one {# chat} other {# chats}} deleted.", {
						count,
					}),
				summary: (count) =>
					tl("{count, plural, =0 {No chats} one {# chat} other {# chats}}", {
						count,
					}),
				title: () => tl("Delete all chats"),
			};
		case "spaces":
			return {
				body: (count) =>
					tl(
						"This will delete {count, plural, one {# space} other {# spaces}}. Every Space, including all of its documents and their search data, will be permanently deleted. System spaces (Artifacts, Uploads, Meetings, …) are left untouched. This cannot be undone.",
						{ count }
					),
				confirmWord: () => tl("Spaces"),
				deleted: (count) =>
					tl("{count, plural, one {# space} other {# spaces}} deleted.", {
						count,
					}),
				summary: (count) =>
					tl("{count, plural, =0 {No spaces} one {# space} other {# spaces}}", {
						count,
					}),
				title: () => tl("Delete all spaces"),
			};
		case "memory":
			return {
				body: (count) =>
					tl(
						"This will delete {count, plural, one {# memory entry} other {# memory entries}}. Every long-term memory entry will be permanently forgotten. This cannot be undone.",
						{ count }
					),
				confirmWord: () => tl("Memory"),
				deleted: (count) =>
					tl(
						"{count, plural, one {# memory entry} other {# memory entries}} deleted.",
						{ count }
					),
				summary: (count) =>
					tl(
						"{count, plural, =0 {No memory entries} one {# memory entry} other {# memory entries}}",
						{ count }
					),
				title: () => tl("Clear all memory"),
			};
		default:
			return null;
	}
}

/** The destructive button and dialog title. */
export function categoryTitle(def: Category, tl: LiteralMessage): string {
	return kernelCopy(def.id, tl)?.title() ?? tl(def.title);
}

/** The row's count line: "3 chats", "No chats", "12 items". */
export function categorySummary(def: Category, tl: LiteralMessage): string {
	const kernel = kernelCopy(def.id, tl);
	if (kernel) {
		return kernel.summary(def.count);
	}
	return tl("{count, plural, =0 {No items} one {# item} other {# items}}", {
		count: def.count,
	});
}

/** The confirm dialog's description: what is deleted, and that it is final. */
export function categoryConfirmBody(def: Category, tl: LiteralMessage): string {
	const kernel = kernelCopy(def.id, tl);
	if (kernel) {
		return kernel.body(def.count);
	}
	return tl(
		"This will delete {count, plural, one {# item} other {# items}}. {detail} This cannot be undone.",
		{ count: def.count, detail: tl(def.detail) }
	);
}

/** The success toast after `removed` items were deleted. */
export function categoryDeleted(
	def: Category,
	removed: number,
	tl: LiteralMessage
): string {
	const kernel = kernelCopy(def.id, tl);
	if (kernel) {
		return kernel.deleted(removed);
	}
	return tl("{count, plural, one {# item} other {# items}} deleted.", {
		count: removed,
	});
}

/** The confirm word as the prompt shows it, in the active language. */
export function shownConfirmWord(def: Category, tl: LiteralMessage): string {
	return kernelCopy(def.id, tl)?.confirmWord() ?? tl(def.confirm_word);
}

/**
 * Every word that arms the delete: the translated one the prompt shows, and
 * Core's English one, so a person who learned the English word (or reads the
 * docs) is not locked out. Accepting both is deliberate.
 */
export function confirmWords(def: Category, tl: LiteralMessage): string[] {
	const shown = shownConfirmWord(def, tl);
	return shown === def.confirm_word ? [shown] : [def.confirm_word, shown];
}

function comparable(text: string): string {
	// NFKC folds full-width IME input onto the catalog's forms.
	return text.normalize("NFKC").trim().toLocaleLowerCase();
}

/** Whether `typed` is one of `confirmWords`, ignoring case, width and spaces. */
export function isConfirmWord(
	def: Category,
	typed: string,
	tl: LiteralMessage
): boolean {
	const entered = comparable(typed);
	return (
		entered.length > 0 &&
		confirmWords(def, tl).some((word) => comparable(word) === entered)
	);
}
