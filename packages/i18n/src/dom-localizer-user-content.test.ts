import { afterEach, describe, expect, test } from "bun:test";

import { registerTestDom } from "./test-dom-env.ts";

await registerTestDom();
const { observeDomLocalization } = await import("./dom-localizer.ts");
const { registerLiteralCatalogLoader } = await import("./literal-catalog.ts");
const { I18nRuntime } = await import("./core.ts");

type Runtime = InstanceType<typeof I18nRuntime>;

// The catalog entries the audit's probe tripped over, as the official
// Japanese and German catalogs carry them.
const CATALOGS: Record<string, Record<string, string>> = {
	de: {
		"{count} notes": "{count} Notizen",
		Agents: "Agenten",
		Groups: "Gruppen",
	},
	ja: {
		"Release {latestRelease}": "リリース {latestRelease}",
		"{count} notes": "メモ {count} 件",
		Website: "Web サイト",
		Agents: "エージェント",
	},
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function runtimeFor(locale: "de" | "ja"): Runtime {
	registerLiteralCatalogLoader(
		(requested) => CATALOGS[requested.slice(0, 2)] ?? null
	);
	return new I18nRuntime([], { initialLocale: locale, initialPackId: null });
}

const disposers: (() => void)[] = [];

function localize(runtime: Runtime): () => void {
	const dispose = observeDomLocalization({
		root: document.body,
		state: () => ({
			availablePacks: runtime.availablePacks,
			hasOverlayMessage: (id: string) =>
				runtime.overlayMessage(id) !== undefined,
			t: (id: string, values?: Record<string, string>, fallback?: string) =>
				runtime.translate(id, values, fallback),
			templateMessage: (text: string) => runtime.templateMessage(text),
		}),
		translationKey: () => String(runtime.getVersion()),
	});
	disposers.push(dispose);
	return dispose;
}

function text(selector: string): string | null {
	return document.querySelector(selector)?.textContent ?? null;
}

afterEach(() => {
	for (const dispose of disposers.splice(0)) {
		dispose();
	}
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

describe("user content stays as written", () => {
	test("a thread title that starts like a one-word template (ja)", async () => {
		const runtime = runtimeFor("ja");
		document.body.innerHTML = [
			"<p id=title>Release notes</p>",
			"<p id=version>Release v2.4</p>",
			"<p id=count>3 notes</p>",
		].join("");
		const dispose = localize(runtime);
		await settle();
		expect(text("#title")).toBe("Release notes");
		// Real values still translate around them.
		expect(text("#version")).toBe("リリース v2.4");
		expect(text("#count")).toBe("メモ 3 件");
		dispose();
	});

	test("an agent description ending in a template's word (de, ja)", async () => {
		for (const locale of ["de", "ja"] as const) {
			const runtime = runtimeFor(locale);
			document.body.innerHTML =
				'<p id=description title="Writes the release notes">Writes the release notes</p>';
			const dispose = localize(runtime);
			await settle();
			expect(text("#description")).toBe("Writes the release notes");
			expect(
				document.querySelector("#description")?.getAttribute("title")
			).toBe("Writes the release notes");
			dispose();
		}
	});

	test("a catalog word inside longer user text is not replaced (ja)", async () => {
		const runtime = runtimeFor("ja");
		document.body.innerHTML = [
			"<p id=project>Website redesign</p>",
			"<p id=owner>Ada's Website</p>",
			"<p id=exact>Website</p>",
		].join("");
		const dispose = localize(runtime);
		await settle();
		expect(text("#project")).toBe("Website redesign");
		expect(text("#owner")).toBe("Ada's Website");
		// A whole catalog literal is UI copy unless its subtree opts out.
		expect(text("#exact")).toBe("Web サイト");
		dispose();
	});
});

describe("native select labels", () => {
	test("translate optgroup and option labels, not other label attributes", async () => {
		const runtime = runtimeFor("de");
		document.body.innerHTML = [
			"<select>",
			'<optgroup id=agents label="Agents"><option id=one label="Groups">x</option></optgroup>',
			"</select>",
			'<my-widget id=widget label="Agents"></my-widget>',
			'<div data-ryu-i18n="off"><select><optgroup id=off label="Agents"></optgroup></select></div>',
		].join("");
		const dispose = localize(runtime);
		await settle();
		const label = (selector: string) =>
			document.querySelector(selector)?.getAttribute("label");
		expect(label("#agents")).toBe("Agenten");
		expect(label("#one")).toBe("Gruppen");
		expect(label("#widget")).toBe("Agents");
		expect(label("#off")).toBe("Agents");

		const added = document.createElement("optgroup");
		added.setAttribute("label", "Groups");
		document.querySelector("select")?.append(added);
		await settle();
		expect(added.getAttribute("label")).toBe("Gruppen");
		dispose();
	});
});
