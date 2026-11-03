import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { COMPANY_ROUTES } from "../data/company.ts";
import { DISCORD_JOIN_PATH, DOCS_URL } from "../data/resources.tsx";
import {
	countHelpArticlesByCategory,
	HelpCategoryCards,
	helpArticleCountLabel,
} from "./help-category-cards.tsx";
import { HelpEscalationLadder } from "./help-escalation-ladder.tsx";
import {
	HELP_ESCALATION_STEPS,
	helpCategoryDescription,
	helpCategoryHref,
} from "./help-index-content.ts";

const ARTICLES = [
	{ category: "Chat bots" },
	{ category: "Sync" },
	{ category: "Chat bots" },
	{ category: "Chat bots" },
];

test("countHelpArticlesByCategory counts per category in the given order and drops empty ones", () => {
	expect(
		countHelpArticlesByCategory(ARTICLES, ["Chat bots", "Empty", "Sync"])
	).toEqual([
		{ name: "Chat bots", count: 3 },
		{ name: "Sync", count: 1 },
	]);
	expect(countHelpArticlesByCategory([], ["Sync"])).toEqual([]);
});

test("helpArticleCountLabel pluralises", () => {
	expect(helpArticleCountLabel(1)).toBe("1 article");
	expect(helpArticleCountLabel(3)).toBe("3 articles");
});

test("HelpCategoryCards links each category to its encoded page with its count and description", () => {
	const html = renderToStaticMarkup(
		<HelpCategoryCards
			categories={countHelpArticlesByCategory(ARTICLES, ["Chat bots", "Sync"])}
		/>
	);
	expect(html).toMatch(/<nav[^>]*aria-labelledby="help-topics-heading"/);
	expect(html).toMatch(/<h2[^>]*id="help-topics-heading"[^>]*>Browse by topic/);
	expect(html).toContain(`href="${helpCategoryHref("Chat bots")}"`);
	expect(helpCategoryHref("Chat bots")).toBe("/help/category/Chat%20bots");
	expect(html).toContain('href="/help/category/Sync"');
	expect(html).toContain("3 articles");
	expect(html).toContain("1 article<");
	expect(html).toContain(helpCategoryDescription("Chat bots") ?? "missing");
	expect(html.match(/data-help-category=/g)?.length).toBe(2);
});

test("HelpCategoryCards omits the description of an unknown category and renders nothing when empty", () => {
	expect(helpCategoryDescription("Billing")).toBeUndefined();
	const html = renderToStaticMarkup(
		<HelpCategoryCards categories={[{ name: "Billing", count: 2 }]} />
	);
	expect(html).toContain("Billing");
	expect(html).toContain("2 articles");
	expect(renderToStaticMarkup(<HelpCategoryCards categories={[]} />)).toBe("");
});

test("the escalation ladder runs Docs, Knowledge Base, Community, Contact to the shared routes", () => {
	expect(HELP_ESCALATION_STEPS.map((step) => [step.id, step.href])).toEqual([
		["docs", DOCS_URL],
		["knowledge-base", COMPANY_ROUTES.knowledgeBase],
		["community", DISCORD_JOIN_PATH],
		["contact", COMPANY_ROUTES.contact],
	]);
	for (const step of HELP_ESCALATION_STEPS) {
		expect(step.purpose.length).toBeGreaterThan(0);
		expect(step.purpose).not.toContain("\n");
	}
	expect(
		HELP_ESCALATION_STEPS.find((step) => step.id === "community")?.purpose
	).toContain("Requires a Ryu account.");
});

test("HelpEscalationLadder renders an ordered, labelled list with one link per step", () => {
	const html = renderToStaticMarkup(<HelpEscalationLadder />);
	expect(html).toMatch(
		/<section[^>]*aria-labelledby="help-escalation-heading"/
	);
	expect(html).toMatch(/<h2[^>]*id="help-escalation-heading"/);
	expect(html).toContain("<ol");
	expect(html.match(/<li/g)?.length).toBe(HELP_ESCALATION_STEPS.length);
	expect(html.match(/<h3/g)?.length).toBe(HELP_ESCALATION_STEPS.length);
	const hrefs = [...html.matchAll(/<a[^>]*href="([^"]+)"/g)].map(
		(match) => match[1]
	);
	expect(hrefs).toEqual(HELP_ESCALATION_STEPS.map((step) => step.href));
	// Step order is shown visually by numbers hidden from assistive tech.
	expect(html).toMatch(/<span aria-hidden="true"[^>]*>1<\/span>/);
	expect(renderToStaticMarkup(<HelpEscalationLadder steps={[]} />)).toBe("");
});
