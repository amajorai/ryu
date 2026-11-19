// The Ask page's title field names an asked question (ja "質問", zh-CN "问题")
// through the keyed `qa.question`. The bare catalog "Question" is an exam item
// (ja "問題", zh-CN "题目").
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nRuntime } from "@ryu/i18n/core";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// The provider registers its runtime here; a test registers its own.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}

const { QaAsk } = await import("./qa-ask.tsx");

let active: I18nRuntime | null = null;

afterEach(() => {
	if (active) {
		unregisterActiveI18nRuntime(active);
		active = null;
	}
});

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

function questionLabel(packId: string | null): string {
	if (packId) {
		active = new I18nRuntime([], { initialPackId: packId });
		registerActiveI18nRuntime(active);
	}
	const html = renderToStaticMarkup(
		<QaAsk
			agents={[]}
			draft={{ agentId: null, body: "", title: "", topicId: null }}
			groups={[]}
			onCancel={() => undefined}
			onChange={() => undefined}
			onSubmit={() => undefined}
			titleRef={createRef<HTMLInputElement>()}
		/>
	);
	const id = html.match(/<input[^>]*id="([^"]+)"/)?.[1] ?? "";
	const label = html.match(new RegExp(`<label[^>]*for="${id}"[^>]*>([^<]*)<`));
	return label?.[1] ?? html;
}

test("the Japanese Ask page labels the title as a question, not an exam item", () => {
	expect(questionLabel("official/ja")).toBe("質問");
});

test("the Chinese Ask page labels the title 问题", () => {
	expect(questionLabel("official/zh-cn")).toBe("问题");
});

test("English keeps Question", () => {
	expect(questionLabel(null)).toBe("Question");
});
