import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { TextMorph } from "./text-morph.tsx";

test("TextMorph keeps its initial text in server-rendered markup", () => {
	const markup = renderToString(<TextMorph as="h2">Ryu UI</TextMorph>);

	expect(markup).toContain("Ryu UI");
	expect(markup).toContain("<h2");
});
