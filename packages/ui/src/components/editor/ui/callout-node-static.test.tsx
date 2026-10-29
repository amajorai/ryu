import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createSlateEditor, type Value } from "platejs";
import { serializeHtml } from "platejs/static";
import { BaseCalloutKit } from "../plugins/callout-base-kit.tsx";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const COLOR_HOOK = 'data-docx-style="editorcalloutNodeStatic1"';

async function renderCallout(value: Value): Promise<string> {
	const editor = createSlateEditor({ plugins: BaseCalloutKit, value });
	return await serializeHtml(editor);
}

test("default callouts keep the muted fill instead of the unlayered color hook", async () => {
	const html = await renderCallout([
		{ type: "callout", children: [{ text: "Default" }] },
	]);

	expect(html).toContain("bg-muted");
	expect(html).not.toContain(COLOR_HOOK);
	expect(html).not.toContain("--editorcalloutNodeStatic1-background-color");
});

test("colored callouts opt into the color hook with their own background", async () => {
	const html = await renderCallout([
		{
			type: "callout",
			backgroundColor: "rgb(254, 243, 199)",
			children: [{ text: "Colored" }],
		},
	]);

	expect(html).toContain(COLOR_HOOK);
	expect(html).toContain(
		"--editorcalloutNodeStatic1-background-color:rgb(254, 243, 199)"
	);
});
