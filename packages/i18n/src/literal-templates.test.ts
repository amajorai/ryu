import { afterEach, describe, expect, test } from "bun:test";

import { I18nRuntime } from "./core.ts";
import {
	type LiteralCatalog,
	registerLiteralCatalogLoader,
} from "./literal-catalog.ts";
import {
	MAX_TEMPLATE_TEXT_LENGTH,
	parseLiteralTemplate,
} from "./literal-templates.ts";

const SPANISH: LiteralCatalog = {
	"Deleted {name}": "Se eliminó {name}",
	"Deleted {name} permanently": "Se eliminó {name} de forma permanente",
	"({count} shared)": "({count} compartidos)",
	"{name} joined the team": "{name} se unió al equipo",
	"{shown} out of {total}": "{shown} de {total}",
	"{a} of {b}": "{a} de {b}",
	"Synced {count} files":
		"{count, plural, one {# archivo} other {# archivos}} sincronizados",
	"Moved {item} to {target}": "Se movió {item} a {target}",
	"Renamed {name} to {name}": "Nombre sin cambios: {name}",
	"Bad {name}": "Malo {other}",
	"{a} {b}": "{a} {b}",
	"{name}": "{name}",
	"Pick {kind, select, a {A} other {B}}": "Elige",
	"Open <b>{name}</b>": "Abrir <b>{name}</b>",
	"Show {a}{b} now": "Mostrar {a}{b} ahora",
	"Open {name}": "Abrir {name}",
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
});

function spanishRuntime(): I18nRuntime {
	registerLiteralCatalogLoader((locale) =>
		locale.startsWith("es") ? SPANISH : null
	);
	return new I18nRuntime([], { initialLocale: "es", initialPackId: null });
}

describe("parseLiteralTemplate", () => {
	test("accept simple arguments and reject everything else", () => {
		expect(parseLiteralTemplate("Deleted {name}")).toEqual({
			literals: ["Deleted ", ""],
			names: ["name"],
		});
		expect(parseLiteralTemplate("{name}")).toBeNull();
		expect(parseLiteralTemplate("{a} {b}")).toBeNull();
		expect(parseLiteralTemplate("No arguments here")).toBeNull();
		expect(
			parseLiteralTemplate("{n, plural, one {#} other {#}} ok")
		).toBeNull();
		expect(parseLiteralTemplate("Open <b>{name}</b>")).toBeNull();
		expect(parseLiteralTemplate("Show {a}{b} now")).toBeNull();
		expect(parseLiteralTemplate("Stray } brace {name}")).toBeNull();
	});
});

describe("template matching", () => {
	test("translate dynamic text around its values", () => {
		const runtime = spanishRuntime();
		expect(runtime.templateMessage("Deleted Q3 plan")).toBe(
			"Se eliminó Q3 plan"
		);
		expect(runtime.templateMessage("Ada  Lovelace\njoined the team")).toBe(
			"Ada Lovelace se unió al equipo"
		);
		expect(runtime.templateMessage("(3 shared)")).toBe("(3 compartidos)");
		expect(runtime.templateMessage("12 out of 40")).toBe("12 de 40");
		expect(runtime.templateMessage("Moved a.txt to Archive")).toBe(
			"Se movió a.txt a Archive"
		);
	});

	test("prefer the most specific template", () => {
		const runtime = spanishRuntime();
		expect(runtime.templateMessage("Deleted Q3 plan permanently")).toBe(
			"Se eliminó Q3 plan de forma permanente"
		);
	});

	test("format the translation's plural with a captured count", () => {
		const runtime = spanishRuntime();
		expect(runtime.templateMessage("Synced 1 files")).toBe(
			"1 archivo sincronizados"
		);
		expect(runtime.templateMessage("Synced 4 files")).toBe(
			"4 archivos sincronizados"
		);
	});

	test("leave text that matches no template", () => {
		const runtime = spanishRuntime();
		expect(runtime.templateMessage("Deleted")).toBeUndefined();
		expect(runtime.templateMessage("Removed Q3 plan")).toBeUndefined();
		expect(runtime.templateMessage("Bad thing")).toBeUndefined();
		expect(runtime.templateMessage("Ada Lovelace")).toBeUndefined();
		// Too few literal letters to be a template.
		expect(runtime.templateMessage("3 of 4")).toBeUndefined();
		expect(runtime.templateMessage("Show 12 now")).toBeUndefined();
		expect(runtime.templateMessage("Renamed a to b")).toBeUndefined();
		expect(runtime.templateMessage("Renamed a to a")).toBe(
			"Nombre sin cambios: a"
		);
	});

	test("leave prose that only starts like a short template", () => {
		const runtime = spanishRuntime();
		expect(runtime.templateMessage("Open Settings")).toBe("Abrir Settings");
		expect(runtime.templateMessage("Open Q3 plan")).toBe("Abrir Q3 plan");
		// User prose is data: one literal word may not rewrite a sentence.
		expect(
			runtime.templateMessage("Open the door and leave it open")
		).toBeUndefined();
		expect(runtime.templateMessage("Deleted the old branch")).toBeUndefined();
	});

	test("skip text longer than the template length cap", () => {
		const runtime = spanishRuntime();
		const name = "x".repeat(MAX_TEMPLATE_TEXT_LENGTH);
		expect(runtime.templateMessage(`Deleted ${name}`)).toBeUndefined();
	});

	test("insert values with regex characters and braces verbatim", () => {
		const runtime = spanishRuntime();
		expect(runtime.templateMessage("Deleted {other} $1 (.*)+? [x]")).toBe(
			"Se eliminó {other} $1 (.*)+? [x]"
		);
		expect(
			runtime.templateMessage("Deleted {n, plural, =1 {#} other {x}}")
		).toBe("Se eliminó {n, plural, =1 {#} other {x}}");
		expect(runtime.templateMessage("Moved ^a|b$ to \\d")).toBe(
			"Se movió ^a|b$ a \\d"
		);
	});

	test("stay off in English and before a loader is registered", () => {
		expect(
			new I18nRuntime([], { initialPackId: null }).templateMessage(
				"Deleted Q3 plan"
			)
		).toBeUndefined();
		registerLiteralCatalogLoader(() => SPANISH);
		const english = new I18nRuntime([], {
			initialLocale: "en",
			initialPackId: null,
		});
		expect(english.templateMessage("Deleted Q3 plan")).toBeUndefined();
	});

	test("translate a literal-id request, as a Companion host relays it", () => {
		const runtime = spanishRuntime();
		expect(runtime.translate("literal.unknown", {}, "Deleted Q3 plan")).toBe(
			"Se eliminó Q3 plan"
		);
		// Named ids keep their own fallback.
		expect(runtime.translate("app.missing", {}, "Deleted Q3 plan")).toBe(
			"Deleted Q3 plan"
		);
	});

	test("publish once an asynchronous catalog arrives", async () => {
		registerLiteralCatalogLoader(() => Promise.resolve(SPANISH));
		const runtime = new I18nRuntime([], {
			initialLocale: "es",
			initialPackId: null,
		});
		expect(runtime.templateMessage("Deleted Q3 plan")).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(runtime.templateMessage("Deleted Q3 plan")).toBe(
			"Se eliminó Q3 plan"
		);
	});
});
