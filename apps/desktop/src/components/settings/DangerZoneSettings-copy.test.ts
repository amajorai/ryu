import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	categoryConfirmBody,
	categoryDeleted,
	categorySummary,
	categoryTitle,
	confirmWords,
	isConfirmWord,
	shownConfirmWord,
} from "@/src/components/settings/DangerZoneSettings-copy.ts";

/** A `tl` over a literal catalog, formatting ICU plurals like the runtime. */
function literalMessages(
	locale: string,
	catalog: Record<string, string>
): LiteralMessage {
	return (source, values = {}) =>
		formatMessage(catalog[source] ?? source, values, locale);
}

const en = literalMessages("en", {});
const ja = literalMessages("ja", {
	"Delete all chats": "すべてのチャットを削除",
	Chats: "チャット",
	"This will delete {count, plural, one {# chat} other {# chats}}. Every conversation and all of its messages will be permanently deleted. This cannot be undone.":
		"{count, plural, other {#件のチャット}}を削除します。すべての会話とそのメッセージが完全に削除されます。この操作は元に戻せません。",
	"{count, plural, one {# chat} other {# chats}} deleted.":
		"{count, plural, other {#件のチャット}}を削除しました。",
	"{count, plural, =0 {No chats} one {# chat} other {# chats}}":
		"{count, plural, =0 {チャットはありません} other {#件のチャット}}",
	"Delete all meetings": "すべてのミーティングを削除",
	Meetings: "ミーティング",
	"Every meeting record and its transcript will be permanently deleted.":
		"すべてのミーティング記録と文字起こしが完全に削除されます。",
	"This will delete {count, plural, one {# item} other {# items}}. {detail} This cannot be undone.":
		"{count, plural, other {#件の項目}}を削除します。{detail}この操作は元に戻せません。",
});

const chats = {
	confirm_word: "Chats",
	count: 42,
	detail: "Every conversation and all of its messages.",
	id: "chats",
	title: "Delete all chats",
};
const meetings = {
	confirm_word: "Meetings",
	count: 3,
	detail:
		"Every meeting record and its transcript will be permanently deleted.",
	id: "meetings",
	title: "Delete all meetings",
};

describe("Danger Zone category copy", () => {
	test("kernel copy in Japanese carries no English noun", () => {
		const copy = [
			categoryTitle(chats, ja),
			categorySummary(chats, ja),
			categoryConfirmBody(chats, ja),
			categoryDeleted(chats, 5, ja),
			categorySummary({ ...chats, count: 0 }, ja),
		];
		expect(copy).toEqual([
			"すべてのチャットを削除",
			"42件のチャット",
			"42件のチャットを削除します。すべての会話とそのメッセージが完全に削除されます。この操作は元に戻せません。",
			"5件のチャットを削除しました。",
			"チャットはありません",
		]);
		for (const text of copy) {
			expect(text).not.toMatch(/chat/iu);
		}
	});

	test("plurals: one renders the singular, zero the empty state", () => {
		expect(categorySummary({ ...chats, count: 1 }, en)).toBe("1 chat");
		expect(categorySummary({ ...chats, count: 0 }, en)).toBe("No chats");
		expect(categorySummary({ ...chats, count: 1234 }, en)).toBe("1,234 chats");
		expect(categoryDeleted(chats, 1, en)).toBe("1 chat deleted.");
		expect(categorySummary({ ...chats, id: "memory", count: 1 }, en)).toBe(
			"1 memory entry"
		);
		expect(categorySummary({ ...meetings, count: 1 }, en)).toBe("1 item");
		expect(categorySummary({ ...meetings, count: 0 }, en)).toBe("No items");
		expect(categoryDeleted(meetings, 2, en)).toBe("2 items deleted.");
		expect(categoryConfirmBody(chats, en)).toContain(
			"This will delete 42 chats."
		);
	});

	test("an app category's title and detail translate by their exact text", () => {
		expect(categoryTitle(meetings, ja)).toBe("すべてのミーティングを削除");
		expect(categoryConfirmBody(meetings, ja)).toBe(
			"3件の項目を削除します。すべてのミーティング記録と文字起こしが完全に削除されます。この操作は元に戻せません。"
		);
		expect(categoryConfirmBody(meetings, en)).toBe(
			"This will delete 3 items. Every meeting record and its transcript will be permanently deleted. This cannot be undone."
		);
	});

	test("the shown Japanese word and the English word both arm the delete", () => {
		expect(shownConfirmWord(chats, ja)).toBe("チャット");
		expect(confirmWords(chats, ja)).toEqual(["Chats", "チャット"]);
		expect(confirmWords(chats, en)).toEqual(["Chats"]);
		expect(isConfirmWord(chats, " チャット ", ja)).toBe(true);
		expect(isConfirmWord(chats, "chats", ja)).toBe(true);
		expect(isConfirmWord(meetings, "ミーティング", ja)).toBe(true);
		expect(isConfirmWord(meetings, "MEETINGS", ja)).toBe(true);
		// Full-width IME input folds onto the catalog's spelling.
		expect(isConfirmWord(chats, "ＣＨＡＴＳ", ja)).toBe(true);
		expect(isConfirmWord(chats, "チャ", ja)).toBe(false);
		expect(isConfirmWord(chats, "", ja)).toBe(false);
		expect(isConfirmWord(meetings, "チャット", ja)).toBe(false);
	});
});
