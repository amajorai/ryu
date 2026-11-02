// Base-map place labels follow the UI language: every symbol layer that prints
// a feature name is pointed at `name:<lang>`, then the Latin name, then the
// local one. Road refs and house numbers keep their own fields.

import { describe, expect, test } from "bun:test";
import {
	type LabelLanguageMap,
	localizedNameField,
	localizeMapLabels,
	mapLabelLanguage,
} from "./maplibre-labels.ts";

/** The text-field OpenFreeMap's positron, dark and liberty styles ship. */
const OPENFREEMAP_NAME = [
	"case",
	["has", "name:nonlatin"],
	["concat", ["get", "name:latin"], "\n", ["get", "name:nonlatin"]],
	["coalesce", ["get", "name_en"], ["get", "name"]],
];

const STYLE = {
	layers: [
		{ id: "background", layout: {}, type: "background" },
		{ id: "water", layout: {}, type: "fill" },
		{
			id: "place_city",
			layout: { "text-field": OPENFREEMAP_NAME },
			type: "symbol",
		},
		{
			id: "road_label",
			layout: { "text-field": "{name:latin} {name:nonlatin}" },
			type: "symbol",
		},
		{
			id: "highway_shield",
			layout: { "text-field": ["get", "ref"] },
			type: "symbol",
		},
		{ id: "poi_icon", layout: {}, type: "symbol" },
	],
};

function fakeMap() {
	const style = structuredClone(STYLE);
	const writes: string[] = [];
	const layer = (id: string) => style.layers.find((entry) => entry.id === id);
	const map: LabelLanguageMap = {
		getLayoutProperty: (id, name) =>
			(layer(id)?.layout as Record<string, unknown> | undefined)?.[name],
		getStyle: () => style,
		off: () => undefined,
		on: () => undefined,
		setLayoutProperty: (id, name, value) => {
			writes.push(id);
			const target = layer(id);
			if (target) {
				target.layout = { ...target.layout, [name]: value };
			}
		},
	};
	return { map, style, writes };
}

describe("map label language", () => {
	test("maps UI locales to OpenMapTiles name keys", () => {
		expect(mapLabelLanguage("zh-CN")).toBe("zh");
		expect(mapLabelLanguage("pt-BR")).toBe("pt");
		expect(mapLabelLanguage("ja")).toBe("ja");
		expect(mapLabelLanguage("en")).toBe("en");
	});

	test("rewrites every name label to the UI language, then Latin, then local", () => {
		const { map, style, writes } = fakeMap();
		localizeMapLabels(map, "zh-CN");
		const expected = [
			"coalesce",
			["get", "name:zh"],
			["get", "name:latin"],
			["get", "name"],
		];
		expect(localizedNameField("zh")).toEqual(expected);
		const field = (id: string) =>
			(
				style.layers.find((entry) => entry.id === id)?.layout as Record<
					string,
					unknown
				>
			)["text-field"];
		expect(field("place_city")).toEqual(expected);
		expect(field("road_label")).toEqual(expected);
		expect(field("highway_shield")).toEqual(["get", "ref"]);
		expect(field("poi_icon")).toBeUndefined();
		expect(writes).toEqual(["place_city", "road_label"]);
	});

	test("is idempotent, so a repeated style load writes nothing", () => {
		const { map, writes } = fakeMap();
		localizeMapLabels(map, "ja");
		writes.length = 0;
		localizeMapLabels(map, "ja");
		expect(writes).toEqual([]);
		localizeMapLabels(map, "ko");
		expect(writes).toEqual(["place_city", "road_label"]);
	});
});
