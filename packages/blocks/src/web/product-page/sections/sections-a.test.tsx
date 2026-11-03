import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getProduct } from "../../data/products.tsx";
import { docsHref } from "../../data/resources.tsx";
import type { ProductProfile } from "../profile-types.ts";
import { ProductApiPanel } from "./api-panel.tsx";
import { atAGlanceFacts, ProductAtAGlance } from "./at-a-glance.tsx";
import { ProductCodeSamples } from "./code-sample.tsx";
import { CodeTabs } from "./code-tabs.tsx";
import { ProductComparisonTable } from "./comparison-table.tsx";
import { CopyButton } from "./copy-button.tsx";
import { ProductInterfaceTable } from "./interface-table.tsx";
import { ProductLimitsTable } from "./limits-table.tsx";
import { ProductArchitectureFlow } from "./product-architecture.tsx";
import { ProductQuickstart } from "./quickstart.tsx";
import { ProductSection, ProductSectionHeader } from "./section-shell.tsx";

// Fixtures only: these strings test rendering, not product claims.
const SOURCE = { path: "fixture.md", quote: "fixture" } as const;

const SAMPLES = [
	{
		id: "curl",
		label: "cURL",
		language: "bash",
		filename: "request.sh",
		code: "# create a box\ncurl -X POST https://example.test/v1/boxes",
		source: SOURCE,
	},
	{
		id: "ts",
		label: "TypeScript",
		language: "ts",
		code: "const box = await client.boxes.create();",
		source: SOURCE,
	},
] as const;

function requireProduct(slug: string) {
	const product = getProduct(slug);
	if (!product) {
		throw new Error(`unknown product ${slug}`);
	}
	return product;
}

test("section shell renders a landing section with its marker and an h2", () => {
	const html = renderToStaticMarkup(
		<ProductSection testId="product-x">
			<ProductSectionHeader
				aside={<span>aside</span>}
				kicker="Kicker"
				subtitle="Lead"
				title="Title"
			/>
		</ProductSection>
	);
	expect(html).toMatch(
		/^<section class="landing-section[^"]*" data-testid="product-x">/
	);
	expect(html).toMatch(/<p[^>]*>Kicker<\/p>/);
	expect(html).toMatch(/<h2[^>]*>Title<\/h2>/);
	expect(html).toContain("Lead");
	expect(html).toContain("<span>aside</span>");
});

test("at a glance lists base facts first and drops repeated labels", () => {
	const box = requireProduct("box");
	const profile: ProductProfile = {
		facts: [
			{ label: "Category", value: "Repeated", source: SOURCE },
			{ label: "Regions", value: "Fixture region", source: SOURCE },
		],
	};
	const facts = atAGlanceFacts(box, profile);
	expect(facts.map((fact) => fact.label)).toEqual([
		"Availability",
		"Category",
		"Pricing",
		"Docs",
		"Regions",
	]);
	expect(facts.find((fact) => fact.label === "Category")?.value).toBe(
		box.category
	);

	const sheet = renderToStaticMarkup(
		<ProductAtAGlance product={box} profile={profile} />
	);
	expect(sheet).toContain('data-testid="product-at-a-glance"');
	expect(sheet).toMatch(/<h2[^>]*>At a glance<\/h2>/);
	expect(sheet).toContain('href="#pricing"');
	expect(sheet).toContain("Fixture region");
	expect(sheet).not.toContain("Repeated");

	const spec = renderToStaticMarkup(
		<ProductAtAGlance layout="spec" product={box} profile={profile} />
	);
	expect(spec).toContain(box.tagline);
	expect(spec.match(/<dt/g)?.length).toBe(5);
});

test("architecture renders numbered nodes as an ordered list", () => {
	const html = renderToStaticMarkup(
		<ProductArchitectureFlow
			architecture={{
				title: "Request path",
				caption: "Fixture caption",
				nodes: [
					{ label: "Client", detail: "Sends the call" },
					{ label: "Gate", detail: "Checks the rules" },
					{ label: "Model", detail: "Answers" },
				],
				source: SOURCE,
			}}
		/>
	);
	expect(html).toContain('data-testid="product-architecture"');
	expect(html).toContain('data-node-count="3"');
	expect(html.match(/<li/g)?.length).toBe(3);
	expect(html.indexOf("Client")).toBeLessThan(html.indexOf("Gate"));
	expect(html).toMatch(/<h3[^>]*>Model<\/h3>/);
	expect(html).toContain("Fixture caption");
});

test("code samples render every sample, hide the inactive one, and dim comments", () => {
	const html = renderToStaticMarkup(
		<ProductCodeSamples groupId="box-code" samples={SAMPLES} />
	);
	expect(html).toContain('data-testid="product-code"');
	expect(html).toContain('role="tablist"');
	expect(html.match(/role="tab"/g)?.length).toBe(2);
	expect(html).toContain('aria-selected="true"');
	expect(html).toContain('aria-controls="box-code-curl-panel"');
	expect(html).toMatch(/id="box-code-ts-panel"[^>]*role="tabpanel"/);
	expect(html).toMatch(/<div[^>]*data-code-sample="ts"[^>]*hidden=""/);
	expect(html).not.toMatch(/<div[^>]*data-code-sample="curl"[^>]*hidden=""/);
	expect(html).toContain("client.boxes.create()");
	expect(html).toContain("request.sh");
	expect(html).toMatch(/text-muted-foreground"># create a box/);
	expect(
		renderToStaticMarkup(<ProductCodeSamples groupId="x" samples={[]} />)
	).toBe("");
});

test("a single sample has no tab list and the column layout uses a kicker", () => {
	const single = renderToStaticMarkup(
		<CodeTabs groupId="one" samples={[SAMPLES[1]]} />
	);
	expect(single).not.toContain('role="tablist"');
	expect(single).toContain("TypeScript");
	const column = renderToStaticMarkup(
		<ProductCodeSamples
			groupId="col"
			layout="column"
			samples={SAMPLES}
			subtitle="Call it from code."
		/>
	);
	expect(column).toMatch(/<h2[^>]*>Code<\/h2>/);
	expect(column).toContain("Call it from code.");
});

test("copy button is a labelled button", () => {
	const html = renderToStaticMarkup(<CopyButton label="Copy URL" text="x" />);
	expect(html).toMatch(/^<button[^>]*type="button"/);
	expect(html).toContain("Copy URL");
	// The live region is a sibling of the button, so it never joins its name.
	expect(html).toMatch(/<\/button><span aria-live="polite"/);
	expect(html.slice(0, html.indexOf("</button>"))).not.toContain("aria-live");
});

const INTERFACES = [
	{
		kind: "REST",
		name: "Boxes API",
		summary: "Create and stop.",
		source: SOURCE,
	},
	{
		kind: "CLI",
		name: "services CLI",
		summary: "Script it.",
		status: "not-published",
		note: "Not on npm yet.",
		source: SOURCE,
	},
	{
		kind: "MCP",
		name: "MCP server",
		summary: "From any client.",
		href: "/products/mcp",
		source: SOURCE,
	},
] as const;

test("interfaces render as a table, or a compact list, with unpublished rows said in words", () => {
	const table = renderToStaticMarkup(
		<ProductInterfaceTable rows={INTERFACES} />
	);
	expect(table).toContain('data-testid="product-interfaces"');
	expect(table).toContain("<table");
	expect(table.match(/<th[^>]*scope="row"/g)?.length).toBe(3);
	expect(table).toContain("Not published yet.");
	expect(table).toContain("Not on npm yet.");
	expect(table).toContain('href="/products/mcp"');
	const compact = renderToStaticMarkup(
		<ProductInterfaceTable compact rows={INTERFACES} />
	);
	expect(compact).not.toContain("<table");
	expect(compact.match(/data-interface-kind=/g)?.length).toBe(3);
	expect(renderToStaticMarkup(<ProductInterfaceTable rows={[]} />)).toBe("");
});

test("the API panel shows the base URL, OpenAPI document and docs", () => {
	const html = renderToStaticMarkup(
		<ProductApiPanel
			docsPath="/docs/standalone/box"
			openapi={{
				href: "/openapi/box.json",
				baseUrl: "https://box.example.test",
				source: SOURCE,
			}}
		/>
	);
	expect(html).toContain('data-testid="product-api"');
	expect(html).toContain("https://box.example.test");
	expect(html).toContain('href="/openapi/box.json"');
	expect(html).toContain(`href="${docsHref("/docs/standalone/box")}"`);
	const bare = renderToStaticMarkup(
		<ProductApiPanel openapi={{ href: "/openapi/x.json", source: SOURCE }} />
	);
	expect(bare).not.toContain("Base URL");
	expect(bare).not.toContain(">Docs<");
});

test("limits render as a row-headed table with notes", () => {
	const html = renderToStaticMarkup(
		<ProductLimitsTable
			limits={{
				title: "Rates",
				rows: [
					{
						label: "Small box",
						value: "1 unit",
						note: "Per minute",
						source: SOURCE,
					},
					{ label: "Storage", value: "2 units", source: SOURCE },
				],
			}}
		/>
	);
	expect(html).toContain('data-testid="product-limits"');
	expect(html.match(/<th[^>]*scope="row"/g)?.length).toBe(2);
	expect(html).toContain("Per minute");
	expect(
		renderToStaticMarkup(
			<ProductLimitsTable limits={{ title: "x", rows: [] }} />
		)
	).toBe("");
});

test("quickstart numbers its steps and gives commands a copy button", () => {
	const html = renderToStaticMarkup(
		<ProductQuickstart
			steps={[
				{
					title: "Install",
					description: "Get it.",
					command: "ryu init",
					source: SOURCE,
				},
				{ title: "Run", description: "Start it." },
			]}
		/>
	);
	expect(html).toContain('data-testid="product-quickstart"');
	expect(html).toMatch(/<ol[^>]*>/);
	expect(html.match(/<h3/g)?.length).toBe(2);
	expect(html).toContain("ryu init");
	expect(html.match(/data-product-copy=""/g)?.length).toBe(1);
	expect(renderToStaticMarkup(<ProductQuickstart steps={[]} />)).toBe("");
});

test("comparison renders column and row headers with one cell per column", () => {
	const html = renderToStaticMarkup(
		<ProductComparisonTable
			comparison={{
				title: "Self-host or managed",
				rowHeader: "Concern",
				columns: ["Self-host", "Managed"],
				rows: [
					{ label: "Cost", values: ["Fixture A", "Fixture B"] },
					{ label: "Upgrades", values: ["You", "Us"] },
				],
				source: SOURCE,
			}}
		/>
	);
	expect(html).toContain('data-testid="product-comparison"');
	expect(html).toContain('data-column-count="2"');
	expect(html.match(/scope="col"/g)?.length).toBe(3);
	expect(html.match(/scope="row"/g)?.length).toBe(2);
	expect(html.match(/<td/g)?.length).toBe(4);
	expect(html).toContain(">Concern<");
});
