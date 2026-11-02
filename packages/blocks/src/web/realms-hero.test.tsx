import { expect, test } from "bun:test";
import { hiddenProductListings } from "@ryu/auth/lib/product-launch-flags";
import { renderToStaticMarkup } from "react-dom/server";
import {
	PRODUCT_REALMS,
	productMenuItemsFor,
	productNavKey,
} from "./data/product-realms.ts";
import { getProduct } from "./data/products.tsx";
import RealmsHero from "./realms-hero.tsx";

test("homepage leads with a centered headline over the shader sky", () => {
	const html = renderToStaticMarkup(<RealmsHero />);

	expect(html).toContain("Open-source agentic infrastructure");
	expect(html).toContain('href="/setup-ryu.md"');
	// Discord invites are personal and single-use (user menu → /discord), so
	// the landing page carries no public invite.
	expect(html).not.toContain("discord.gg");
	expect(html).not.toContain("Join our Discord");
	expect(html).not.toContain(
		"Ryu Core runs the work. Ryu Gateway governs the calls."
	);
	expect(html).not.toContain(
		"Sessions, memory, tools, and workflows on the node you choose."
	);
	expect(html).not.toContain(
		"Routing, approvals, budgets, and audit around every call."
	);
	expect(html).not.toContain("Ryu gives agents a place to run.");
	// The beam-wrapped download button keeps its border, so it keeps the split
	// menu (a plain outline button is one link, but a bordered one is not).
	expect(html).toContain('aria-label="More download options"');
	expect(html).toContain('data-testid="landing-download-beam"');
	expect(html).toContain("bg-transparent");
	expect(html).toContain("backdrop-blur-sm");
	expect(html).toContain("border-border");
	expect(html).toContain("border-foreground/15");
	expect(html).not.toContain('data-slot="button-group-separator"');
	expect(html).toContain('data-testid="hero-viewport"');
	expect(html).toContain('data-testid="hero-surface"');
	expect(html).toContain('data-testid="hero-sky"');
	expect(html).toContain('data-testid="hero-sky-layer"');
	// The shader starts after hydration, so the server markup is the CSS sky.
	expect(html).not.toContain('data-testid="hero-sky-canvas"');
	expect(html).toContain("linear-gradient(180deg");
	expect(html).toContain("blur-[12.5px]");
	expect(html).not.toContain("hero-halloween-moon");
	expect(html).toContain(
		"linear-gradient(to bottom, transparent, var(--background))"
	);
	expect(html).toContain("--blur-height:220px");
	expect(html).toContain("--blur-amount:12px");
	expect(html).toContain("text-balance");
	expect(html).toContain(
		"mx-auto w-full max-w-[88rem] text-balance text-center"
	);
	const setupCta = html.match(
		/<a class="([^"]+)" data-testid="setup-ryu-button" href="\/setup-ryu\.md"/
	);
	expect(setupCta?.[1]).toContain("hover:bg-muted");
	expect(setupCta?.[1]).toContain("hover:text-foreground");
	expect(setupCta?.[1]).not.toContain("bg-secondary text-secondary-foreground");
	expect(html).not.toContain('data-testid="hero-3d-logo"');
	expect(html).not.toContain('data-testid="hero-runtime-preview"');
	expect(html).toContain('data-testid="backed-by-carousel"');
	expect(html).toContain('data-testid="product-paths"');
	expect(html).toContain('data-testid="product-bento-grid"');
	expect(html).toContain('data-testid="product-card-gateway"');
	expect(html).toContain('data-testid="product-card-console"');
	expect(html).toContain('data-testid="product-card-bot"');
	expect(html).not.toContain("bg-muted/30 text-foreground");
	expect(html).toContain("max-w-7xl");
	// No fade over the cards' labels: the figures stop above them.
	expect(html).not.toContain("from-muted via-muted/85");
	expect(html).toContain("after:border-foreground/55");
	expect(html).not.toContain("blur-[0.5px]");
	expect(html).not.toContain('role="tab"');
	expect(html).not.toContain('role="switch"');
	expect(html).not.toContain("bg-amber-100/20 dark:bg-amber-800/5");
	expect(html).not.toContain('data-testid="standalone-services"');
	expect(html).not.toContain("Choose the Ryu path that fits the work");
	expect(html).not.toContain("Use Ryu");
	expect(html).not.toContain("Build with Ryu");
	expect(html).not.toContain("Choose how you want to start");
	expect(html).not.toContain('id="integration-layer"');
	expect(html).not.toContain('id="managed-deployment"');
	expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
	expect(html.indexOf('data-testid="hero-viewport"')).toBeLessThan(
		html.indexOf('data-testid="backed-by-carousel"')
	);
	expect(html.indexOf('data-testid="backed-by-carousel"')).toBeLessThan(
		html.indexOf('data-testid="product-paths"')
	);

	const productStart = html.indexOf('data-testid="product-paths"');
	const productEnd = html.indexOf("</section>", productStart);
	const productMarkup = html.slice(productStart, productEnd);
	// One heading per card group, in priority order; the cards carry no headings.
	expect(
		[...productMarkup.matchAll(/<h2[^>]*>(?:<[^>]+>)*([^<]+)/g)].map(
			([, title]) => title
		)
	).toEqual(["Get started", "Build", "Platform"]);
	expect(productMarkup).not.toContain("<h3");
});

test("the download beam's generated stylesheet is client-only", () => {
	const html = renderToStaticMarkup(<RealmsHero />);
	const beam = html.match(/<div[^>]*data-testid="landing-download-beam"[^>]*>/);
	expect(beam?.[0]).toContain("data-beam-placeholder");
	// The frame keeps the beam's box rules so mounting the beam moves nothing.
	expect(beam?.[0]).toContain("border-radius:28px");
	expect(beam?.[0]).toContain("overflow:hidden");
	expect(beam?.[0]).toContain("position:relative");
	expect(html).not.toContain("@property --beam-angle");
	expect(html).not.toContain("<style");
});

test("the startup-program marquee server-renders one row of links", () => {
	const html = renderToStaticMarkup(<RealmsHero />);
	const start = html.indexOf('data-testid="backed-by-marquee"');
	const end = html.indexOf("</section>", start);
	const marquee = html.slice(start, end);
	const hrefs = [...marquee.matchAll(/<a [^>]*href="([^"]+)"/g)].map(
		([, href]) => href
	);
	// The loop copy is client-only; the server row lists each program once.
	expect(hrefs.length).toBeGreaterThan(0);
	expect(new Set(hrefs).size).toBe(hrefs.length);
	expect(marquee).not.toContain('tabindex="-1"');
	// Without its loop copy the row stays still rather than sliding into a gap.
	expect(
		html.slice(0, start).match(/class="([^"]*)"[^>]*$/)?.[1]
	).not.toContain("marquee");
});

const cardIds = (html: string) =>
	[...html.matchAll(/data-testid="product-card-([^"]+)"/g)].map(([, id]) => id);

test("homepage cards list every released product in priority order", () => {
	// The public read's defaults: closed services and unlaunched products.
	const hiddenProductIds = hiddenProductListings(null);
	const html = renderToStaticMarkup(
		<RealmsHero hiddenProductIds={hiddenProductIds} />
	);
	const released = [
		"bot",
		"desktop",
		"console",
		"gateway",
		"agents",
		"skills",
		"marketplace",
		"sdk",
		"core",
		"cloud",
	];

	expect(cardIds(html)).toEqual(released);
	// Same set, and same destinations, as the header's Products menu.
	const menuItems = productMenuItemsFor(hiddenProductIds);
	expect(menuItems.map(productNavKey).toSorted()).toEqual(released.toSorted());
	for (const item of menuItems) {
		expect(html).toContain(`href="${item.href}"`);
	}
	for (const id of released) {
		expect(
			html.match(new RegExp(`data-testid="realm-card-${id}"`, "g"))
		).toHaveLength(1);
		// Every card draws its product's figure (or, without one, its own scene).
		expect(html).toContain(`data-testid="realm-visual-${id}"`);
	}
	// Pre-release realms stay on /products.
	for (const product of PRODUCT_REALMS) {
		if (!released.includes(product.id)) {
			expect(html).not.toContain(`data-testid="realm-card-${product.id}"`);
		}
	}
	expect(html).not.toContain('href="/products/apps"');
	// Each card is named as its catalogue entry is.
	for (const id of ["desktop", "sdk", "core", "cloud"]) {
		expect(html).toContain(`>${getProduct(id)?.name}</span>`);
	}
});

test("homepage cards hide unlaunched products until their flag opens", () => {
	const closed = renderToStaticMarkup(
		<RealmsHero hiddenProductIds={hiddenProductListings(null)} />
	);
	for (const id of ["workflows", "agents-as-a-service", "red-team", "mail"]) {
		expect(cardIds(closed)).not.toContain(id);
	}

	const opened = renderToStaticMarkup(
		<RealmsHero
			hiddenProductIds={hiddenProductListings({
				"catalog.workflows": true,
				"catalog.agents_as_a_service": true,
				"catalog.red_team": true,
			})}
		/>
	);
	for (const id of ["workflows", "agents-as-a-service", "red-team"]) {
		expect(cardIds(opened)).toContain(id);
		expect(opened).toContain(`data-testid="realm-visual-${id}"`);
		expect(opened).toContain(`>${getProduct(id)?.name}</span>`);
	}
	// Without a host list every menu product gets a card.
	expect(cardIds(renderToStaticMarkup(<RealmsHero />))).toEqual(
		expect.arrayContaining(["workflows", "red-team", "mail"])
	);
});

test("the hero carries no sample workspace or embedded demo", () => {
	const html = renderToStaticMarkup(<RealmsHero />);
	expect(html).toContain("Open-source agentic infrastructure");
	expect(html).not.toContain('data-testid="hero-desktop-demo"');
	expect(html).not.toContain('data-testid="live-desktop-demo"');
	expect(html).not.toContain("Sample workspace");
	expect(html).not.toContain("group chats");
	expect(html).toContain("gap-9");
	expect(html).toContain("py-20");
});

test("each homepage card group is an uneven bento that fills the wide grid", () => {
	const html = renderToStaticMarkup(
		<RealmsHero hiddenProductIds={hiddenProductListings(null)} />
	);
	const cards = [
		...html.matchAll(
			/<article class="[^"]*?(xl:col-span-\d+)(?: (xl:row-span-2))?[^"]*" data-card-size="(\w+)"/g
		),
	].map(([, col, row, size]) => [size, col, row ?? ""]);
	// Get started: a big card beside a wide one over two small ones. Build: two
	// tall cards around two stacked singles. Platform: an uneven pair.
	expect(cards).toEqual([
		["big", "xl:col-span-6", "xl:row-span-2"],
		["wide", "xl:col-span-6", ""],
		["small", "xl:col-span-3", ""],
		["small", "xl:col-span-3", ""],
		["tall", "xl:col-span-4", "xl:row-span-2"],
		["single", "xl:col-span-4", ""],
		["tall", "xl:col-span-4", "xl:row-span-2"],
		["single", "xl:col-span-4", ""],
		["single", "xl:col-span-7", ""],
		["single", "xl:col-span-5", ""],
	]);
});

test("the hero fills exactly the first viewport and the partner strip follows it", () => {
	const html = renderToStaticMarkup(<RealmsHero />);
	const viewport = html.match(
		/<div class="([^"]*)" data-testid="hero-viewport"/
	)?.[1];
	// The small viewport height (URL bar shown) never jumps on mobile scroll;
	// the landing header floats over the hero, so only the announcement bar's
	// full height is subtracted (0 with no bar), and no pixel cap leaves the
	// partner strip peeking in on a tall screen.
	expect(viewport?.split(" ")).toContain(
		"min-h-[calc(100svh-var(--site-announcement-height,0px))]"
	);
	expect(viewport).not.toMatch(/min\(/);
	expect(viewport).toContain("justify-center");
	// The partner strip sits after the hero section, not inside its 100svh.
	const surfaceEnd = html.indexOf(
		"</section>",
		html.indexOf('data-testid="hero-surface"')
	);
	expect(html.indexOf('data-testid="backed-by-carousel"')).toBeGreaterThan(
		surfaceEnd
	);
});
