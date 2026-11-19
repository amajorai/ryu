import { expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n";
import { formatMessage } from "@ryu/i18n/core";
import { catalogLayerBadges, catalogLayerLabel } from "./layer-labels.ts";

const JA: Record<string, string> = {
	External: "外部",
	"{title} layer": "{title} レイヤー",
	"{title} toolkit": "{title} ツールキット",
};
const tl: LiteralMessage = (source, values) =>
	formatMessage(JA[source] ?? source, values ?? {}, "ja");

test("a layer label is one translated sentence around the title", () => {
	expect(
		catalogLayerLabel({ capability: "browser", title: "Browser" }, tl)
	).toBe("Browser レイヤー");
	expect(catalogLayerLabel({ capability: "files", toolkit: true }, tl)).toBe(
		"files ツールキット"
	);
});

test("an external listing leads with the translated External badge", () => {
	expect(
		catalogLayerBadges([{ capability: "browser", title: "Browser" }], tl, true)
	).toEqual(["外部", "Browser レイヤー"]);
	expect(catalogLayerBadges(null, tl)).toEqual([]);
});
