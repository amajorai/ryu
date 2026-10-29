import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupRyuButton, setupRyuPrompt } from "./setup-ryu-button.tsx";

test("the prompt links the hosted playbook instead of inlining it", () => {
	const prompt = setupRyuPrompt("https://ryu.example");

	expect(prompt).toBe(
		"Set up Ryu for me. Read https://ryu.example/setup-ryu.md and follow its instructions."
	);
	expect(prompt.split("\n")).toHaveLength(1);
});

test("the button stays a pill link to the playbook with agent logos", () => {
	const html = renderToStaticMarkup(<SetupRyuButton />);

	expect(html).toContain('href="/setup-ryu.md"');
	expect(html).toContain("rounded-full");
	expect(html).toContain("Set up Ryu for me");
	for (const slug of ["claude", "openai", "gemini", "cursor"]) {
		expect(html).toContain(`src="/logos/${slug}.svg"`);
	}
});
