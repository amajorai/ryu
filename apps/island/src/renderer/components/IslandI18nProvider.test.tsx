import { afterEach, expect, test } from "bun:test";
import { useI18n } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { IslandI18nProvider } from "./IslandI18nProvider.tsx";

const originalNavigator = Object.getOwnPropertyDescriptor(
	globalThis,
	"navigator"
);

function setOsLanguages(languages: string[]): void {
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: { language: languages[0], languages },
	});
}

function Probe() {
	return <output>{useI18n().locale}</output>;
}

/** A catalog read that never answers, so only the OS languages decide. */
const silentPacks = { get: () => new Promise<never>(() => undefined) };

function shownLocale(): string {
	const markup = renderToStaticMarkup(
		<IslandI18nProvider languagePacks={silentPacks as never}>
			<Probe />
		</IslandI18nProvider>
	);
	return /<output>([^<]*)<\/output>/u.exec(markup)?.[1] ?? "";
}

afterEach(() => {
	if (originalNavigator) {
		Object.defineProperty(globalThis, "navigator", originalNavigator);
	}
});

test("automatic mode walks every OS language, not only the first", () => {
	setOsLanguages(["nl-NL", "ja-JP"]);
	expect(shownLocale().startsWith("ja")).toBe(true);
});
