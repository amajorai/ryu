import { expect, test } from "bun:test";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ProductLandingPage from "../product-landing-page.tsx";
import {
	getProduct,
	type Product,
	productCategories,
	productStatusLabel,
	products,
	productsByCategory,
} from "./products.tsx";

const BANNED_COPY = [
	"apps/skills",
	"apps/mcp",
	"NEEDS_AUTH",
	"identity.read",
	"Pokémon",
	"workcell",
	"BYOA",
	"BYOS",
	"Runnable",
	"sidecar",
	"Restate",
	"sqlite-vec",
	"BuzzKit",
	"Cactus Compute",
	"ZeroClaw",
	"Palantir",
	"supply-side",
	"demand-side",
	"~16 sidecars",
	"Parity with Codex",
	"Hundreds of",
	"20+ tools",
	"Self-improving",
	"improves itself",
	"Promptfoo",
	"Mac-like",
	"Northstar Studio",
	"Customize",
];

const PRIMARY_LABELS = new Set([
	"Download",
	"Get early access",
	"Book a demo",
	"Read the docs",
	"See plans",
]);

function words(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Every buyer-visible string on the page, FAQ excluded. */
function marketingCopy(product: Product): string[] {
	return [
		product.hero.title,
		product.hero.subtitle,
		...(product.splits ?? []).flatMap((split) => [
			split.title,
			split.description,
			...(split.bullets ?? []),
		]),
		product.bento.title,
		product.bento.subtitle ?? "",
		...product.bento.items.flatMap((item) => [item.title, item.description]),
		product.cta.title,
		product.cta.subtitle,
		product.cta.note ?? "",
	].filter(Boolean);
}

/** Copy that also renders, including the FAQ, eyebrow, tagline and link labels. */
function allCopy(product: Product): string[] {
	return [
		product.name,
		product.tagline,
		product.hero.eyebrow,
		product.hero.primaryCta.label,
		product.hero.secondaryCta?.label ?? "",
		product.cta.primaryCta.label,
		product.cta.secondaryCta?.label ?? "",
		...(product.splits ?? []).map((split) => split.cta?.label ?? ""),
		...marketingCopy(product),
		...(product.faq ?? []).flatMap((item) => [item.q, item.a]),
	].filter(Boolean);
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;");
}

function elementType(node: ReactNode): unknown {
	if (!isValidElement(node)) {
		return node;
	}
	// ProductFigure picks its drawing by prop, so two figures differ by id.
	const figure = (node.props as { figure?: unknown }).figure;
	return typeof figure === "string"
		? `${String(node.type)}:${figure}`
		: node.type;
}

test("the standalone product set includes the direct service APIs", () => {
	expect(
		products
			.filter((product) => product.standalone)
			.map((product) => product.slug)
	).toEqual([
		"gateway",
		"passport",
		"connect",
		"box",
		"notify",
		"mail",
		"messaging",
		"sites",
		"hire",
	]);
	for (const [slug, name] of [
		["passport", "Ryu Passport"],
		["connect", "Ryu Connect"],
		["notify", "Ryu Notify"],
		["mail", "Ryu Mail"],
		["messaging", "Ryu Messaging"],
		["hire", "Ryu Hire"],
	] as const) {
		expect(getProduct(slug)).toMatchObject({ name, standalone: true });
	}
	expect(getProduct("compute")).toMatchObject({
		name: "Ryu Compute",
		category: "Agent APIs",
	});
	expect(getProduct("share")).toMatchObject({
		name: "Ryu Share",
		category: "Agent APIs",
	});
});

test("the catalog uses the canonical four-group taxonomy", () => {
	expect(productCategories).toEqual([
		"Workspaces",
		"Build",
		"Platform",
		"Agent APIs",
	]);
	const grouped = productCategories.flatMap((category) =>
		productsByCategory(category).map((product) => product.slug)
	);
	expect([...grouped].sort()).toEqual(
		products.map((product) => product.slug).sort()
	);
	expect(productsByCategory("Workspaces").map((p) => p.slug)).toEqual([
		"bot",
		"os",
		"agent",
		"desktop",
		"island",
		"mobile",
		"chrome-extension",
		"devices",
	]);
	expect(productsByCategory("Platform").map((p) => p.slug)).toEqual([
		"core",
		"gateway",
		"cloud",
		"agents-as-a-service",
		"red-team",
	]);
	expect(getProduct("marketplace")?.name).toBe("Marketplace");
	expect(getProduct("chrome-extension")?.name).toBe("Ryu for Chrome");
});

test("pre-release products carry a status that matches their eyebrow", () => {
	const statuses = Object.fromEntries(
		products
			.filter((product) => product.status)
			.map((product) => [product.slug, productStatusLabel(product)])
	);
	expect(statuses).toEqual({
		passport: "Early access",
		connect: "Early access",
		box: "Early access",
		notify: "Early access",
		sites: "Early access",
		hire: "Early access",
		messaging: "Early access",
		compute: "Coming soon",
		share: "Coming soon",
		os: "Early access",
		island: "Coming soon",
		mobile: "Coming soon",
		"chrome-extension": "Early access",
		devices: "Coming soon",
	});
	for (const product of products) {
		const label = productStatusLabel(product);
		expect(product.hero.eyebrow).toBe(
			label ? `${product.name} · ${label}` : product.name
		);
	}
});

test("every public product renders its content through the shared page", () => {
	for (const product of products) {
		const html = renderToStaticMarkup(
			createElement(ProductLandingPage, { product })
		);
		expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
		expect(html).toContain(escapeHtml(product.hero.title));
		expect(html).toContain(`data-testid="product-page-${product.slug}"`);
		expect(html).toContain(product.hero.primaryCta.label);
	}
});

test("product copy stays inside the page word budgets", () => {
	for (const product of products) {
		const { hero, bento, cta } = product;
		const context = product.slug;
		expect([context, words(hero.title) <= 6]).toEqual([context, true]);
		expect([context, words(hero.subtitle) <= 22]).toEqual([context, true]);

		for (const split of product.splits ?? []) {
			const titleWords = words(split.title);
			expect([context, titleWords >= 2 && titleWords <= 7]).toEqual([
				context,
				true,
			]);
			expect([context, words(split.description) <= 30]).toEqual([
				context,
				true,
			]);
			expect((split.bullets ?? []).length).toBeLessThanOrEqual(3);
			for (const bullet of split.bullets ?? []) {
				expect([context, bullet, words(bullet) <= 10]).toEqual([
					context,
					bullet,
					true,
				]);
			}
		}
		expect((product.splits ?? []).length).toBeLessThanOrEqual(3);

		// The capabilities list is optional: none, or three to six items.
		if (bento.items.length > 0) {
			expect([
				context,
				words(bento.title) >= 2 && words(bento.title) <= 6,
			]).toEqual([context, true]);
			if (bento.subtitle) {
				expect([context, words(bento.subtitle) <= 15]).toEqual([context, true]);
			}
			expect(bento.items.length).toBeGreaterThanOrEqual(3);
		}
		expect(bento.items.length).toBeLessThanOrEqual(6);
		for (const item of bento.items) {
			expect([context, item.title, words(item.title) <= 4]).toEqual([
				context,
				item.title,
				true,
			]);
			expect([context, item.title, words(item.description) <= 15]).toEqual([
				context,
				item.title,
				true,
			]);
		}

		expect([context, cta.title]).toEqual([
			context,
			expect.stringMatching(/^Ready to .+\?$/),
		]);
		expect([context, words(cta.title) <= 6]).toEqual([context, true]);
		if (cta.subtitle) {
			expect([context, words(cta.subtitle) <= 12]).toEqual([context, true]);
		}
		if (cta.note) {
			expect([context, cta.note.split("·").length <= 3]).toEqual([
				context,
				true,
			]);
		}

		const total = marketingCopy(product).reduce(
			(sum, text) => sum + words(text),
			0
		);
		expect([context, total <= 260]).toEqual([context, true]);
	}
});

test("capabilities carry no icons, visuals, actions or spans", () => {
	for (const product of products) {
		for (const item of product.bento.items) {
			expect(Object.keys(item).sort()).toEqual(["description", "title"]);
		}
		const splitTitles = new Set(
			(product.splits ?? []).map((split) => split.title.toLowerCase())
		);
		for (const item of product.bento.items) {
			expect(splitTitles.has(item.title.toLowerCase())).toBe(false);
		}
		for (const split of product.splits ?? []) {
			expect(Object.keys(split)).not.toContain("eyebrow");
			expect(Object.keys(split)).not.toContain("flip");
		}
	}
});

test("every page has two hero CTAs that the closing CTA repeats", () => {
	for (const product of products) {
		const { hero, cta } = product;
		expect(hero.secondaryCta).toBeDefined();
		expect(PRIMARY_LABELS.has(hero.primaryCta.label)).toBe(true);
		expect(cta.primaryCta.label).toBe(hero.primaryCta.label);
		for (const pair of [
			[hero.primaryCta.label, hero.secondaryCta?.label],
			[cta.primaryCta.label, cta.secondaryCta?.label],
		]) {
			expect([
				product.slug,
				pair.includes("Download") && pair.includes("Get early access"),
			]).toEqual([product.slug, false]);
		}
	}
});

test("FAQs have zero or two to three questions", () => {
	for (const product of products) {
		const count = product.faq?.length ?? 0;
		expect([product.slug, count === 0 || (count >= 2 && count <= 3)]).toEqual([
			product.slug,
			true,
		]);
	}
});

test("feature rows use a different visual from the hero", () => {
	for (const product of products) {
		const heroType = elementType(product.hero.visual);
		for (const split of product.splits ?? []) {
			expect([product.slug, elementType(split.visual) === heroType]).toEqual([
				product.slug,
				false,
			]);
		}
	}
});

test("buyer copy contains no internal jargon or unsourced claims", () => {
	for (const product of products) {
		const copy = allCopy(product).join("\n");
		for (const banned of BANNED_COPY) {
			expect([product.slug, banned, copy.includes(banned)]).toEqual([
				product.slug,
				banned,
				false,
			]);
		}
	}
});

test("Ryu Hire is early access with no live run, price, or metering claims", () => {
	const hire = getProduct("hire");
	expect(hire?.hero.eyebrow).toBe("Ryu Hire · Early access");
	if (!hire) {
		throw new Error("Ryu Hire product entry is missing");
	}
	const html = renderToStaticMarkup(
		createElement(ProductLandingPage, { product: hire })
	);
	expect(html).toContain("Early access");
	// No Hire runtime, estimate, credit debit, or receipt exists yet.
	for (const claim of [
		/pay per run/i,
		/pay-per-run/i,
		/paid per run/i,
		/run receipt/i,
		/pay (for the run )?with (ryu )?credits/i,
		/\d+\s*(credits|cr)\b/i,
	]) {
		expect(html).not.toMatch(claim);
	}
	for (const item of hire.faq ?? []) {
		expect(item.a).not.toMatch(/pay per run|paid per run|run receipt/i);
	}
});

test("Ryu Messaging is early access, passes AWS prices through, and owns SMS", () => {
	const messaging = getProduct("messaging");
	if (!messaging) {
		throw new Error("Ryu Messaging product entry is missing");
	}
	expect(messaging.hero.eyebrow).toBe("Ryu Messaging · Early access");
	const html = renderToStaticMarkup(
		createElement(ProductLandingPage, { product: messaging })
	);
	expect(html).toContain("no markup");
	expect(html).toContain("outbound text-to-speech only");
	// Rates come from AWS; the landing page must not invent one.
	expect(html).not.toMatch(/\$\d/);

	const notifyFaq = getProduct("notify")?.faq?.find((item) =>
		item.q.includes("SMS")
	);
	expect(notifyFaq?.a).toContain("Ryu Messaging");
	expect(notifyFaq?.a).not.toContain("owned by Core or Mail");
});

test("unreleased workspaces never offer a Download button", () => {
	for (const slug of ["island", "os", "mobile", "devices"]) {
		const product = getProduct(slug);
		const labels = [
			product?.hero.primaryCta.label,
			product?.hero.secondaryCta?.label,
			product?.cta.primaryCta.label,
			product?.cta.secondaryCta?.label,
		];
		expect([slug, labels.includes("Download")]).toEqual([slug, false]);
	}
	expect(getProduct("island")?.hero.eyebrow).toBe("Ryu Island · Coming soon");
	expect(
		getProduct("island")?.faq?.find(
			(item) => item.q === "Can I use Island today?"
		)?.a
	).toContain("Not yet");
});

test("copy matches what the code ships", () => {
	const copy = (slug: string) => {
		const product = getProduct(slug);
		return product ? allCopy(product).join("\n") : "";
	};
	// Red teaming ships a closed set of ten single-turn probes.
	expect(copy("red-team")).not.toMatch(/OWASP|Best-of-N|multi-turn|encoded/);
	// Durable execution ships; it is not on a roadmap.
	expect(copy("workflows")).not.toMatch(/roadmap|exposed? .* as a tool/i);
	// Connected-account tokens are held by Composio, not the Gateway.
	expect(copy("connections")).not.toMatch(
		/Gateway (holds|holding|'s key vault)/
	);
	// The CLI switches between saved nodes; it does not discover the network.
	expect(copy("cli")).not.toMatch(/discover|on your network/i);
	// No Raspberry Pi build ships.
	for (const slug of ["core", "cloud"]) {
		expect([slug, /\ba Pi\b/.test(copy(slug))]).toEqual([slug, false]);
	}
	// Devices stream to your node; there are no rings and no on-device models.
	expect(copy("devices")).not.toMatch(/rings?\b|on-device|local AI/i);
	expect(copy("agents-as-a-service")).not.toMatch(/white-glove|for free/i);
	expect(copy("bot")).toContain("subscription");
});

test("anatomy figures sit in the hero, never as a second band", () => {
	const withFigure = products.filter((product) => product.figure);
	expect(withFigure.map((product) => product.slug)).toEqual([]);
});
