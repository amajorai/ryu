import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The empty-wallet "Add {amount} credits" button formats the pack in the
// reader's locale instead of gluing a literal "$" in front of the number.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { CreditsView } = await import("./credits.tsx");

const DE: Record<string, string> = {
	"Add <span>{amount}</span> credits":
		"<span>{amount}</span> Guthaben hinzufügen",
};

/** Intl separates the amount and the sign with a no-break space. */
const plainSpaces = (text: string): string =>
	text.replaceAll(" ", " ").replaceAll(" ", " ");

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

async function renderEmptyWallet(
	locale: string,
	catalog: Record<string, string>
): Promise<string> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith(locale) ? catalog : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<CreditsView packs={[100, 250]} walletEmpty />
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return plainSpaces(container.textContent ?? "");
}

test("German formats the add-credits amount as '100 $'", async () => {
	const text = await renderEmptyWallet("de", DE);
	expect(text).toContain("100 $ Guthaben hinzufügen");
	expect(text).not.toContain("$100");
});

test("English keeps the published '$100' amount", async () => {
	const text = await renderEmptyWallet("en", {});
	expect(text).toContain("Add $100 credits");
});
