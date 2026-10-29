import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillsScene } from "./skills.tsx";

const ID_ATTRIBUTE = /\sid="/;
const REACT_ID = /:r[0-9a-z]+:|«r/;

describe("SkillsScene", () => {
	it("server-renders a decorative open fan of SKILL.md sheets", () => {
		const markup = renderToStaticMarkup(<SkillsScene />);

		expect(markup).toContain('data-testid="realm-visual-skills"');
		expect(markup).toContain('aria-hidden="true"');
		expect(markup).toContain("<svg");
		expect(markup).toContain("SKILL.md");
		expect(markup).toContain("skills.sh");
		expect(markup).toContain("skills/");
		expect(markup).toContain("--skills-fan:-26deg");
		expect(markup).toContain("--skills-fan:26deg");
		expect(markup).not.toContain("data-inview");
	});

	it("renders identical markup with no generated ids", () => {
		const first = renderToStaticMarkup(<SkillsScene />);
		const second = renderToStaticMarkup(<SkillsScene />);

		expect(first).toBe(second);
		expect(first).not.toMatch(ID_ATTRIBUTE);
		expect(first).not.toMatch(REACT_ID);
	});

	it("keeps a still frame for reduced motion", async () => {
		const stylesheet = await Bun.file(
			new URL("./skills.module.css", import.meta.url)
		).text();

		expect(stylesheet).toContain("prefers-reduced-motion: reduce");
		expect(stylesheet).toContain(".stage:not([data-inview]) *");
	});
});
