import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// Landing copy kept in data tables (FAQ answers, the services Map, the policy
// demo, the footer credit) renders through the reader's catalog, not as the
// English source beside translated headings.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// The footer's release badge asks GitHub; answer it locally.
Reflect.set(globalThis, "fetch", () =>
	Promise.resolve(new Response("{}", { status: 404 }))
);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { default: FAQ } = await import("./faq.tsx");
const { GatewayRequestPreview } = await import("./gateway-request-preview.tsx");
const { default: Features } = await import("./features.tsx");
const { default: Footer } = await import("./footer.tsx");
const { StandaloneServicesSection } = await import(
	"./standalone-services-section.tsx"
);

const DE: Record<string, string> = {
	"Can our company data leave?": "Können unsere Firmendaten abfließen?",
	"Not unless you choose that. Ryu can run on your own machines, so the work can stay inside your company boundary.":
		"Nur wenn Sie es wollen. Ryu läuft auf Ihren eigenen Rechnern.",
	"Email the project update to the client.":
		"Den Projektstand per E-Mail an den Kunden senden.",
	"Needs your approval": "Braucht Ihre Freigabe",
	"Drafting is allowed": "Entwürfe sind erlaubt",
	"Prompt Injection Protection": "Schutz vor Prompt-Injection",
	"Built-in firewall": "Eingebaute Firewall",
	"Designed with <heart></heart> & powered by Ryu":
		"Mit <heart></heart> gestaltet, angetrieben von Ryu",
	love: "Liebe",
	"Send notifications through one API.":
		"Benachrichtigungen über eine API senden.",
};

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function renderIn(locale: string, node: ReactNode): Promise<HTMLElement> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith(locale) ? DE : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				{node}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

test("FAQ questions and answer paragraphs render from the catalog", async () => {
	const container = await renderIn(
		"de",
		<FAQ
			items={[
				{
					content: [
						"Not unless you choose that. Ryu can run on your own machines, so the work can stay inside your company boundary.",
					],
					id: "data",
					title: "Can our company data leave?",
				},
			]}
		/>
	);
	const text = container.textContent ?? "";
	expect(text).toContain("Können unsere Firmendaten abfließen?");
	expect(text).not.toContain("Can our company data leave?");
});

test("the policy demo's table values render in the reader's language", async () => {
	const container = await renderIn("de", <GatewayRequestPreview />);
	const text = container.textContent ?? "";
	expect(text).toContain("Den Projektstand per E-Mail an den Kunden senden.");
	expect(text).toContain("Braucht Ihre Freigabe");
	expect(text).toContain("Entwürfe sind erlaubt");
	expect(text).not.toContain("Email the project update to the client.");
});

test("the comparison rows render in the reader's language", async () => {
	const container = await renderIn("de", <Features />);
	const text = container.textContent ?? "";
	expect(text).toContain("Schutz vor Prompt-Injection");
	expect(text).toContain("Eingebaute Firewall");
	expect(text).not.toContain("Prompt Injection Protection");
});

test("English keeps the source copy", async () => {
	const container = await renderIn("en", <GatewayRequestPreview />);
	expect(container.textContent).toContain(
		"Email the project update to the client."
	);
});

test("the footer credit is one sentence with the heart inside it", async () => {
	const container = await renderIn("de", <Footer />);
	const text = container.textContent ?? "";
	expect(text).toContain("Mit  gestaltet, angetrieben von Ryu");
	expect(text).not.toContain("Designed with");
	expect(container.querySelector('[aria-label="Liebe"]')).not.toBeNull();
});

test("standalone service descriptions render from the catalog", async () => {
	const container = await renderIn("de", <StandaloneServicesSection />);
	const text = container.textContent ?? "";
	expect(text).toContain("Benachrichtigungen über eine API senden.");
	expect(text).not.toContain("Send notifications through one API.");
});
