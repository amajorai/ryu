import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductRealmScene } from "./product-realm-scenes.tsx";
import {
	apiStandaloneServices,
	StandaloneServicesSection,
} from "./standalone-services-section.tsx";
import { HireVisual, MessagingVisual } from "./visuals.tsx";

test("the API-oriented standalone section lists only services with a public API", () => {
	const html = renderToStaticMarkup(<StandaloneServicesSection />);
	expect(html).toContain("through its API");
	expect(apiStandaloneServices.map((product) => product.slug)).not.toContain(
		"hire"
	);
	expect(html).not.toContain('data-testid="standalone-service-hire"');
	for (const product of apiStandaloneServices) {
		expect(html).toContain(`data-testid="standalone-service-${product.slug}"`);
	}
	expect(apiStandaloneServices.map((product) => product.slug)).toContain(
		"messaging"
	);
	expect(html).toContain(
		"Send SMS, WhatsApp, and voice messages from numbers you lease."
	);
});

test("the Messaging visual shows charge states, not invented prices", () => {
	const html = renderToStaticMarkup(<MessagingVisual />);
	expect(html).toContain("/api/messaging");
	expect(html).toContain("AWS price, no markup");
	expect(html).not.toMatch(/\$\d/);
});

test("Hire visuals show no per-specialist prices for a service with no prices", () => {
	for (const html of [
		renderToStaticMarkup(<HireVisual />),
		renderToStaticMarkup(<ProductRealmScene id="hire" />),
	]) {
		expect(html).toContain("Policy analyst");
		expect(html).not.toMatch(/\d+\s*(credits|cr)\b/i);
	}
	// The sample list sits under the early-access hero; the homepage scene
	// carries the status itself.
	expect(renderToStaticMarkup(<ProductRealmScene id="hire" />)).toContain(
		"Early access"
	);
});
