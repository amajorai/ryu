// The two shapes every provider settings page shares, mounted alone: the list
// row (one button that carries the name and the summary) and the frame of an
// opened page (a back control that names the list, the title that takes the
// focus, one status and one line under it).

import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { SettingsGroup } = await import("../shared/settings-items.tsx");
const { PAGE_ROW_ATTRIBUTE, ProviderNavRow, ProviderPageFrame } = await import(
	"./ProviderPageFrame.tsx"
);

const roots: Root[] = [];

async function mount(ui: ReactNode): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => root.render(ui));
	return host;
}

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	registerLiteralCatalogLoader(null);
	document.body.replaceChildren();
	document.documentElement.removeAttribute("lang");
	document.documentElement.removeAttribute("dir");
});

function one<T extends HTMLElement = HTMLElement>(
	host: HTMLElement,
	selector: string
): T {
	const element = host.querySelector<T>(selector);
	if (!element) {
		throw new Error(`Missing ${selector}: ${host.textContent}`);
	}
	return element;
}

/** What a screen reader says for an element: its text without hidden parts. */
function spoken(element: HTMLElement): string {
	const copy = element.cloneNode(true) as HTMLElement;
	for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) {
		hidden.remove();
	}
	return copy.textContent ?? "";
}

test("a list row is one button named by its title and summary, and it opens the page", async () => {
	let opened = 0;
	const host = await mount(
		<SettingsGroup>
			<ProviderNavRow
				end={<span data-row-status="">Active</span>}
				mark={<span data-row-mark="" />}
				onOpen={() => {
					opened += 1;
				}}
				rowId="provider:openai"
				summary="API key · Team key"
				title="OpenAI"
			/>
		</SettingsGroup>
	);
	// One tab stop per row: the whole row is a single native button.
	const buttons = host.querySelectorAll("button");
	expect(buttons).toHaveLength(1);
	const button = one<HTMLButtonElement>(host, "button");
	expect(button.type).toBe("button");
	expect(button.getAttribute(PAGE_ROW_ATTRIBUTE)).toBe("provider:openai");
	// The name of the button is its text: the title, then the summary.
	expect(button.getAttribute("aria-label")).toBeNull();
	expect(spoken(button)).toBe("OpenAIAPI key · Team key");
	// The mark is in front of the name, inside the click target, and hidden
	// from readers: it only repeats the name that follows.
	const mark = one(button, "[data-row-mark]");
	expect(mark.closest('[aria-hidden="true"]')).not.toBeNull();
	expect(button.firstElementChild?.contains(mark)).toBe(true);
	// The status sits in the row but outside the button, so the button's name
	// stays the provider and its one line.
	const status = one(host, "[data-row-status]");
	expect(button.contains(status)).toBe(false);
	expect(status.closest('[data-slot="item"]')).toBe(
		button.closest('[data-slot="item"]')
	);
	// The overlay that stretches the click target is hidden from readers.
	expect(one(button, "span.absolute").getAttribute("aria-hidden")).toBe("true");

	await act(async () => button.click());
	expect(opened).toBe(1);
});

test("an initial that stands in for a logo is not part of the row's or the page's name", async () => {
	const initial = (
		<span className="flex size-8 items-center justify-center">L</span>
	);
	const host = await mount(
		<>
			<SettingsGroup>
				<ProviderNavRow
					mark={initial}
					onOpen={() => undefined}
					rowId="provider:lab"
					summary="Custom · Configured"
					title="Lab endpoint"
				/>
			</SettingsGroup>
			<ProviderPageFrame
				mark={initial}
				onBack={() => undefined}
				parentTitle="AI providers"
				title="Lab endpoint"
			>
				<p>body</p>
			</ProviderPageFrame>
		</>
	);
	// The eye still gets the initial in both places.
	const marks = Array.from(host.querySelectorAll("span.size-8"));
	expect(marks.map((mark) => mark.textContent)).toEqual(["L", "L"]);
	for (const mark of marks) {
		expect(mark.closest('[aria-hidden="true"]')).not.toBeNull();
	}
	expect(spoken(one(host, `[${PAGE_ROW_ATTRIBUTE}]`))).toBe(
		"Lab endpointCustom · Configured"
	);
	// On the page the mark stays outside the title.
	expect(one(host, "h3").textContent).toBe("Lab endpoint");
	expect(spoken(one(host, "[data-provider-page]"))).toBe("Lab endpointbody");
});

test("a row without a summary shows the title alone", async () => {
	const host = await mount(
		<SettingsGroup>
			<ProviderNavRow
				onOpen={() => undefined}
				rowId="account-pools"
				title="Account pools"
			/>
		</SettingsGroup>
	);
	const button = one(host, `[${PAGE_ROW_ATTRIBUTE}="account-pools"]`);
	expect(button.textContent).toBe("Account pools");
	expect(button.querySelector(".text-muted-foreground")).toBeNull();
});

test("an opened page puts the focus on its title and shows status, hint and body", async () => {
	const host = await mount(
		<ProviderPageFrame
			badge={<span data-page-badge="">Needs sign-in</span>}
			hint="anthropic-messages · Subscription · Accounts: 2"
			mark={<span data-page-mark="" />}
			onBack={() => undefined}
			parentTitle="AI providers"
			title="Claude Pro/Max"
		>
			<p data-page-body="">body</p>
		</ProviderPageFrame>
	);
	const page = one(host, "[data-provider-page]");
	expect(page.getAttribute("data-provider-page")).toBe("Claude Pro/Max");
	// Exactly one title, and it holds the focus so the page is announced.
	const headings = page.querySelectorAll("h1, h2, h3, h4");
	expect(headings).toHaveLength(1);
	const title = one(page, "h3");
	expect(title.textContent).toBe("Claude Pro/Max");
	expect(document.activeElement).toBe(title);
	// Focusable by script only: the title is not a tab stop of its own.
	expect(title.getAttribute("tabindex")).toBe("-1");
	expect(one(page, "[data-page-badge]").textContent).toBe("Needs sign-in");
	expect(
		one(page, "[data-page-mark]").closest('[aria-hidden="true"]')
	).not.toBeNull();
	expect(one(page, "p.text-muted-foreground").textContent).toBe(
		"anthropic-messages · Subscription · Accounts: 2"
	);
	expect(one(page, "[data-page-body]").textContent).toBe("body");
});

test("the back control names the list, comes before the title and calls back once", async () => {
	let backs = 0;
	const host = await mount(
		<ProviderPageFrame
			onBack={() => {
				backs += 1;
			}}
			parentTitle="AI providers"
			title="Model parameters"
		>
			<button type="button">inside the page</button>
		</ProviderPageFrame>
	);
	const back = one<HTMLButtonElement>(host, 'button[aria-label^="Back to"]');
	expect(back.getAttribute("aria-label")).toBe("Back to AI providers");
	// The tooltip says the same as the name read out.
	expect(back.getAttribute("title")).toBe("Back to AI providers");
	expect(back.type).toBe("button");
	// One Shift+Tab from the title: the back control is the control before it,
	// and the body's own controls come after the title.
	const title = one(host, "h3");
	expect(
		back.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING
	).toBeTruthy();
	const inside = Array.from(host.querySelectorAll("button")).at(-1);
	expect(inside?.textContent).toBe("inside the page");
	expect(
		title.compareDocumentPosition(inside as Node) &
			Node.DOCUMENT_POSITION_FOLLOWING
	).toBeTruthy();
	// A page without a hint leaves no empty line under the title.
	expect(host.querySelector("p.text-muted-foreground")).toBeNull();

	await act(async () => back.click());
	expect(backs).toBe(1);
});

test("the back control names the list in the user's language", async () => {
	registerLiteralCatalogLoader(() => ({
		"AI providers": "KI-Anbieter",
		"Back to {pageTitle}": "Zurück zu {pageTitle}",
	}));
	const host = await mount(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale="de"
			initialPackId={null}
			manageDocument={false}
		>
			<ProviderPageFrame
				onBack={() => undefined}
				parentTitle="AI providers"
				title="OpenAI"
			>
				<p>body</p>
			</ProviderPageFrame>
		</I18nProvider>
	);
	const back = one(host, "button[aria-label]");
	expect(back.getAttribute("aria-label")).toBe("Zurück zu KI-Anbieter");
	expect(back.getAttribute("title")).toBe("Zurück zu KI-Anbieter");
	// A provider's name is a proper name and stays as written.
	expect(one(host, "h3").textContent).toBe("OpenAI");
});
