// packages/marketplace/src/catalog/types-layers.test.ts
//
// The capability-layer helpers reached through `types-layers.ts` and the
// `types.ts` facade build catalogued sentences through the caller's `tl`.

import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n";
import { formatMessage } from "@ryu/i18n/core";
import * as labels from "./layer-labels.ts";
import * as facade from "./types.ts";
import { catalogLayerBadges, catalogLayerLabel } from "./types-layers.ts";

const DE: Record<string, string> = {
	External: "Extern",
	"{title} layer": "{title}-Ebene",
	"{title} toolkit": "{title}-Toolkit",
};
const tl: LiteralMessage = (source, values) =>
	formatMessage(DE[source] ?? source, values ?? {}, "de");

describe("types-layers", () => {
	test("the facade re-exports the tl-aware label builders", () => {
		expect(facade.catalogLayerLabel).toBe(catalogLayerLabel);
		expect(facade.catalogLayerBadges).toBe(catalogLayerBadges);
		expect(catalogLayerLabel).toBe(labels.catalogLayerLabel);
		expect(catalogLayerBadges).toBe(labels.catalogLayerBadges);
	});

	test("a layer label prefers its trimmed title and translates the sentence", () => {
		expect(
			catalogLayerLabel({ capability: "browser", title: " Browser " }, tl)
		).toBe("Browser-Ebene");
		expect(
			catalogLayerLabel({ capability: "files", title: "  ", toolkit: true }, tl)
		).toBe("files-Toolkit");
	});

	test("badges list every layer and lead with the translated External", () => {
		expect(
			facade.catalogLayerBadges(
				[{ capability: "browser" }, { capability: "files" }],
				tl,
				true
			)
		).toEqual(["Extern", "browser-Ebene", "files-Ebene"]);
		expect(facade.catalogLayerBadges(null, tl)).toEqual([]);
	});
});
