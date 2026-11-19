import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { editHtml, prepareHtml } from "./core.ts";

const ownsDomRegistration = !GlobalRegistrator.isRegistered;
if (ownsDomRegistration) {
	GlobalRegistrator.register();
}
afterAll(async () => {
	if (ownsDomRegistration) {
		await GlobalRegistrator.unregister();
	}
});

/** Japanese wording for the edit failures, keyed by English source. */
const JA: Record<string, string> = {
	"Edit {position} ({kind}): {message}": "編集 {position} ({kind}): {message}",
	"Node {id} no longer exists": "ノード {id} はもう存在しません",
	"The page body cannot be removed": "ページ本文は削除できません",
	"The {tag} element cannot contain other elements":
		"{tag} 要素には他の要素を入れられません",
};

const ja = (source: string, values?: MessageValuesInput): string =>
	formatMessage(JA[source] ?? source, values ?? {}, "ja");

const parser = new DOMParser();
const SITE =
	"<!doctype html><html><body><main><p>Intro</p><hr></main></body></html>";

describe("visual edit failures", () => {
	test("each reason is translated, not only the wrapper", () => {
		const prepared = prepareHtml(SITE, parser);
		expect(
			editHtml(prepared, [{ kind: "remove", nodeId: "root" }], parser, ja)
		).toEqual({
			ok: false,
			error: "編集 1 (remove): ページ本文は削除できません",
		});
		expect(
			editHtml(prepared, [{ kind: "remove", nodeId: "n99" }], parser, ja)
		).toEqual({
			ok: false,
			error: "編集 1 (remove): ノード n99 はもう存在しません",
		});
		expect(
			editHtml(
				prepared,
				[{ html: "<b>x</b>", index: 0, kind: "insertHtml", parentId: "n3" }],
				parser,
				ja
			)
		).toEqual({
			ok: false,
			error: "編集 1 (insertHtml): hr 要素には他の要素を入れられません",
		});
	});
});
