import { afterEach, expect, test } from "bun:test";
import { act } from "react";

import type { CompanionI18nApi } from "./dom-localizer-host.ts";
import type { I18nHostSnapshot, I18nHostTranslateInput } from "./runtime.ts";
import { registerTestDom } from "./test-dom-env.ts";

await registerTestDom();
const { loadReactDomClient } = await import("./test-dom-env.ts");
const { createRoot } = await loadReactDomClient();
const { useLiteralMessages } = await import("./react.tsx");
const { resetCompanionLiteralRemote } = await import("./literal-remote.ts");
const { messageIdForLiteral } = await import("./literal-catalog.ts");

const SOURCE = "Applied {count, plural, one {# change} other {# changes}}.";

const GERMAN: I18nHostSnapshot = {
	direction: "ltr",
	locale: "de",
	packId: "official/de",
	packName: "Deutsch",
	packVersion: "1.0.0",
};

interface FakeHost extends CompanionI18nApi {
	emit(snapshot: I18nHostSnapshot): void;
	requests: I18nHostTranslateInput[];
}

function fakeHost(
	answer: (input: I18nHostTranslateInput) => string | null
): FakeHost {
	let listener: ((snapshot: I18nHostSnapshot) => void) | null = null;
	const requests: I18nHostTranslateInput[] = [];
	return {
		emit: (snapshot) => listener?.(snapshot),
		get: () => new Promise<I18nHostSnapshot>(() => undefined),
		requests,
		subscribe: ({ onChange }) => {
			listener = onChange;
			return { dispose: () => undefined };
		},
		translate: (input) => {
			requests.push(input);
			return Promise.resolve(answer(input) ?? input.defaultMessage);
		},
	};
}

function installHost(host: CompanionI18nApi | null) {
	Reflect.set(window, "ryu", host ? { i18n: host } : undefined);
}

function Probe({ count }: { count: number }) {
	const tl = useLiteralMessages();
	return <output>{tl(SOURCE, { count })}</output>;
}

async function mount(node: React.ReactNode) {
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	await act(async () => {
		root.render(node);
	});
	return {
		rerender: async (next: React.ReactNode) => {
			await act(async () => {
				root.render(next);
			});
		},
		text: () => element.querySelector("output")?.textContent ?? "",
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
		},
	};
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

afterEach(() => {
	resetCompanionLiteralRemote();
	installHost(null);
	document.body.innerHTML = "";
});

test("asks the Companion host for the whole sentence and re-renders", async () => {
	const host = fakeHost(({ values }) =>
		values?.count === 3 ? "3 Änderungen angewendet." : null
	);
	installHost(host);
	const view = await mount(<Probe count={3} />);
	expect(view.text()).toBe("Applied 3 changes.");
	await act(async () => {
		host.emit(GERMAN);
	});
	await flush();
	expect(view.text()).toBe("3 Änderungen angewendet.");
	expect(host.requests).toEqual([
		{
			defaultMessage: SOURCE,
			id: messageIdForLiteral(SOURCE),
			values: { count: 3 },
		},
	]);
	// Cached by values: re-rendering the same sentence sends nothing new.
	await view.rerender(<Probe count={3} />);
	expect(host.requests.length).toBe(1);
	// New values are a new request; English shows until the host answers.
	await view.rerender(<Probe count={1} />);
	expect(view.text()).toBe("Applied 1 change.");
	await flush();
	expect(view.text()).toBe("Applied 1 change.");
	expect(host.requests.length).toBe(2);
	await view.unmount();
});

test("does not ask an English host", async () => {
	const host = fakeHost(() => "unexpected");
	installHost(host);
	const view = await mount(<Probe count={2} />);
	await act(async () => {
		host.emit({ ...GERMAN, locale: "en", packId: null });
	});
	await flush();
	expect(view.text()).toBe("Applied 2 changes.");
	expect(host.requests).toEqual([]);
	await view.unmount();
});

test("formats English and sends nothing without a host", async () => {
	installHost(null);
	const view = await mount(<Probe count={1} />);
	await flush();
	expect(view.text()).toBe("Applied 1 change.");
	await view.unmount();
});
