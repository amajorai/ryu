import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import { unreadDividerLabel } from "./message-scroller-follow.ts";

const SOURCE = "{count, plural, one {# new message} other {# new messages}}";

function runtimeFor(locale: string, messages: Record<string, string> = {}) {
	return {
		direction: "ltr" as const,
		locale,
		translate(id: string, values?: MessageValuesInput, fallback?: string) {
			const message = (fallback && messages[fallback]) ?? fallback ?? id;
			return formatMessage(message, values, locale);
		},
	};
}

let mounted: ReturnType<typeof runtimeFor> | null = null;

afterEach(() => {
	if (mounted) {
		unregisterActiveI18nRuntime(mounted);
		mounted = null;
	}
});

describe("unread divider label", () => {
	test("English pluralizes one and other", () => {
		expect(unreadDividerLabel(1)).toBe("1 new message");
		expect(unreadDividerLabel(2)).toBe("2 new messages");
		expect(unreadDividerLabel(1200)).toBe("1,200 new messages");
	});

	test("follows the active UI locale", () => {
		mounted = runtimeFor("ja", {
			[SOURCE]: "{count, plural, other {# 件の新着メッセージ}}",
		});
		registerActiveI18nRuntime(mounted);
		expect(unreadDividerLabel(1)).toBe("1 件の新着メッセージ");
		expect(unreadDividerLabel(2)).toBe("2 件の新着メッセージ");
	});

	test("uses the locale's plural categories (ar)", () => {
		mounted = runtimeFor("ar", {
			[SOURCE]:
				"{count, plural, zero {لا رسائل جديدة} one {رسالة جديدة} two {رسالتان جديدتان} few {# رسائل جديدة} many {# رسالة جديدة} other {# رسالة جديدة}}",
		});
		registerActiveI18nRuntime(mounted);
		expect(unreadDividerLabel(1)).toBe("رسالة جديدة");
		expect(unreadDividerLabel(2)).toBe("رسالتان جديدتان");
		expect(unreadDividerLabel(3)).toContain("رسائل جديدة");
	});
});
