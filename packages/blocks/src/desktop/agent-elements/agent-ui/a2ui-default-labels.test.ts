import { expect, test } from "bun:test";
import { normalizeA2ui } from "./a2ui.ts";
import {
	A2UI_DATE_TIME_LABEL,
	localizeA2uiDefaultLabel,
} from "./a2ui-default-labels.ts";

const JA: Record<string, string> = { "Date and time": "日時" };
const ja = (source: string) => JA[source] ?? source;

test("the default date and time label follows the UI language", () => {
	expect(localizeA2uiDefaultLabel(A2UI_DATE_TIME_LABEL, ja)).toBe("日時");
});

test("an author's own label and a missing label are left alone", () => {
	expect(localizeA2uiDefaultLabel("Due date", ja)).toBe("Due date");
	expect(localizeA2uiDefaultLabel(undefined, ja)).toBeUndefined();
});

test("the constant matches the label normalizeA2ui fills in", () => {
	const result = normalizeA2ui([
		{
			version: "v0.9",
			createSurface: {
				surfaceId: "when",
				catalogId:
					"https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
			},
		},
		{
			version: "v0.9",
			updateComponents: {
				surfaceId: "when",
				components: [{ id: "root", component: "DateTimeInput" }],
			},
		},
	]);
	expect(result.spec).toMatchObject({
		elements: {
			root: { type: "Input", props: { label: A2UI_DATE_TIME_LABEL } },
		},
	});
});
