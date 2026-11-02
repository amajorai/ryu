import { describe, expect, mock, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";

const captured: Record<string, unknown>[] = [];

mock.module("@emoji-mart/react", () => ({
	default: (props: Record<string, unknown>) => {
		captured.push(props);
		return <div data-testid="emoji-mart" />;
	},
}));

const { EmojiPicker } = await import("./emoji-picker.tsx");

describe("EmojiPicker locale", () => {
	test("passes the ja locale and a lazy ja translation to EmojiMart", async () => {
		captured.length = 0;
		renderToStaticMarkup(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<EmojiPicker onEmojiSelect={() => undefined} />
			</I18nProvider>
		);
		const props = captured.at(-1);
		expect(props?.locale).toBe("ja");
		expect(typeof props?.i18n).toBe("function");
		const loadStrings = props?.i18n as () => Promise<Record<string, unknown>>;
		expect((await loadStrings()).search).toBe("検索");
	});

	test("keeps EmojiMart's built-in English for en", () => {
		captured.length = 0;
		renderToStaticMarkup(
			<I18nProvider initialLocale="en" initialPackId={null}>
				<EmojiPicker onEmojiSelect={() => undefined} />
			</I18nProvider>
		);
		expect(captured.at(-1)?.locale).toBe("en");
		expect(captured.at(-1)?.i18n).toBeUndefined();
	});
});
