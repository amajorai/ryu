import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DOCS_URL } from "./data/resources.tsx";
import RealmsHero from "./realms-hero.tsx";

test("landing page carries the composable cloud positioning", () => {
	const html = renderToStaticMarkup(<RealmsHero />);

	expect(html).toContain('data-testid="realms-hero"');
	expect(html).toContain('data-testid="hero-workflow-stage"');
	expect(html).toContain('data-testid="realm-card-apps"');
	expect(html).toContain('data-testid="realm-card-bot"');
	expect(html).toContain('data-testid="realm-card-console"');
	expect(html).toContain('data-testid="product-realm-selector"');
	expect(html).toContain('aria-label="Ryu surfaces"');
	expect(html).toContain('data-testid="managed-deployment"');
	expect(html).toContain('data-testid="standalone-services"');
	for (const slug of ["gateway", "box", "notify", "mail", "hire"]) {
		expect(html).toContain(`data-testid="standalone-service-${slug}"`);
	}
	for (const label of [
		"Ryu Gateway",
		"Ryu Box",
		"Ryu Notify",
		"Ryu Mail",
		"Ryu Hire",
	]) {
		expect(html).toContain(label);
	}
	expect(html).toContain('id="integration-layer"');
	for (const label of ["Ryu Apps", "Ryu Bot", "Ryu Console"]) {
		expect(html).toContain(label);
	}
	expect(html).toContain("We deploy and run AI agents<br/>");
	expect(html).toContain("safely in the");
	expect(html).toContain("cloud");
	expect(html).toContain("background-image:var(--chromatic-gradient)");
	expect(html).not.toContain("Ryu sets up and runs AI");
	expect(html).not.toContain("that works for you in the");
	expect(html).not.toContain("Ryu is AI-native business software.");
	expect(html).not.toContain("Ask Ryu to customise it.");
	expect(html).toContain("After a call");
	expect(html).toContain("Download");
	expect(html).toContain("Documentation");
	expect(html).toContain('data-testid="hero-workflow-background"');
	expect(html).toContain('aria-label="More download options"');
	expect(html).not.toContain("Explore Ryu Apps");
	expect(html).not.toContain("Book a Demo");
	expect(html).not.toContain('href="/help"');
	expect(html).toContain(`href="${DOCS_URL}"`);
	expect(html).toContain('target="_blank"');
	expect(html.indexOf("We deploy and run AI agents<br/>")).toBeLessThan(
		html.indexOf('data-testid="hero-workflow-stage"')
	);
	expect(html.indexOf("Download")).toBeLessThan(
		html.indexOf('data-testid="hero-workflow-stage"')
	);
	expect(html).toContain('href="https://cal.com/amajor/ryu-demo"');
	expect(html).toContain("Ryu is the integration layer for AI.");
	expect(html).toContain("font-medium text-xl text-muted-foreground");
	expect(html).toContain("mt-3 max-w-2xl text-balance font-medium text-xl");
	expect(html).toContain(
		"A simple toolkit that connects the tools they already"
	);
	expect(html).toContain(
		"Use the same deployment through Apps, Bot, and Console."
	);
	expect(html).toContain("Connect the pieces.");
	expect(html).toContain("Run the");
	expect(html).toContain("work.");
	expect(html).toContain("Use existing AI");
	expect(html).toContain("Connect your tools");
	expect(html).toContain("Secure each run");
	expect(html).toContain("Deploy to Cloud");
	expect(html).toContain("Ready-made applications for business workflows.");
	expect(html).toContain("Chat with Ryu through the Bot interface.");
	expect(html).toContain("Configure Ryu from the control panel.");
	expect(html).not.toContain("pre-seed");
	expect(html).not.toContain("fewer than 10");
	expect(html).not.toContain("early-stage");
	expect(html).not.toContain("AI deployment for small teams");
	expect(html).toContain("bg-[#ccfbf1]");
	expect(html).toContain("bg-[#fce7f3]");
	expect(html).toContain("bg-[#dcfce7]");
	expect(html).toContain("Backed by leading startup programs");
	for (const id of ["apps", "bot", "console"]) {
		expect(
			html.match(new RegExp(`data-testid="realm-card-${id}"`, "g"))
		).toHaveLength(1);
	}
	expect(html).not.toContain('data-testid="product-realm-tab-deploy"');
	expect(html).not.toContain("The product loop");
	expect(html).not.toContain("Keep shipping while Ryu runs the AI layer.");
	expect(html).not.toContain("The pieces that make AI useful on day one.");
	expect(html).not.toContain("Building instead of buying?");
	expect(html).not.toContain("Bring one repetitive job.");
	expect(html).not.toContain("One platform. Every way in.");
	expect(html).not.toContain("$250");
	expect(html).not.toContain("Teams starts at");
	expect(html).not.toContain("See pricing");
	expect(html).not.toContain("Ryu Bot is here");
});
