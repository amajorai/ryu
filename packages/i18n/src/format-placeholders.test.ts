import { expect, test } from "bun:test";

import { placeholderNames } from "./format.ts";

test("reads plain and nested arguments", () => {
	expect(placeholderNames("Hi {name}, you have {count} files")).toEqual([
		"count",
		"name",
	]);
	expect(
		placeholderNames(
			"{count, plural, one {# file in {folder}} other {# files}}"
		)
	).toEqual(["count", "folder"]);
});

test("treats select and plural branch bodies as text", () => {
	const source =
		"No {status, select, pending {pending} applied {applied} other {canceled}} change requests.";
	const spanish =
		"No hay solicitudes de cambio {status, select, pending {pendientes} applied {aplicadas} other {canceladas}}.";
	expect(placeholderNames(source)).toEqual(["status"]);
	expect(placeholderNames(spanish)).toEqual(placeholderNames(source));
});
