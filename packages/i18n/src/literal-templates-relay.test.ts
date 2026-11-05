import { describe, expect, test } from "bun:test";

import type { LiteralCatalog } from "./literal-catalog.ts";
import {
	LiteralTemplateIndex,
	MAX_RELAY_VALUE_LENGTH,
} from "./literal-templates.ts";

const JAPANESE: LiteralCatalog = {
	"synthesis failed in '{engine}': {error}":
		"'{engine}' で音声合成に失敗しました: {error}",
	"language '{language}' is not supported; use one of {supported}":
		"言語 '{language}' はサポートされていません。{supported} のいずれかを使用してください",
	"remote node unreachable: {error}": "リモートノードに接続できません: {error}",
	"finetune source not reachable: {error}":
		"ファインチューニングのソースに到達できません: {error}",
	"Connection timed out": "接続がタイムアウトしました",
	"Renamed {name}": "{name} の名前を変更しました",
	"Open settings": "設定を開く",
};

function index(): LiteralTemplateIndex {
	return new LiteralTemplateIndex(JAPANESE);
}

describe("relayed reasons", () => {
	test("a cataloged ValueError nested in a relay translates both levels", () => {
		expect(
			index().match(
				"synthesis failed in 'kokoro': language 'xx' is not supported; use one of en, ja",
				"ja"
			)
		).toBe(
			"'kokoro' で音声合成に失敗しました: 言語 'xx' はサポートされていません。en, ja のいずれかを使用してください"
		);
	});

	test("an exact catalog entry relayed as {error} translates", () => {
		expect(
			index().match("remote node unreachable: Connection timed out", "ja")
		).toBe("リモートノードに接続できません: 接続がタイムアウトしました");
	});

	test("raw text and non-relay arguments stay verbatim", () => {
		expect(index().match("remote node unreachable: ECONNREFUSED", "ja")).toBe(
			"リモートノードに接続できません: ECONNREFUSED"
		);
		// `{name}` is data even when it reads like catalog copy.
		expect(index().match("Renamed Open settings", "ja")).toBe(
			"Open settings の名前を変更しました"
		);
	});

	test("the depth cap stops after two nested levels", () => {
		const chain =
			"finetune source not reachable: remote node unreachable: finetune source not reachable: Connection timed out";
		expect(index().match(chain, "ja")).toBe(
			"ファインチューニングのソースに到達できません: リモートノードに接続できません: ファインチューニングのソースに到達できません: Connection timed out"
		);
	});

	test("the length cap leaves long relayed values alone", () => {
		const reason = (language: string) =>
			`language '${language}' is not supported; use one of en`;
		expect(
			index().match(`remote node unreachable: ${reason("xx")}`, "ja")
		).toBe(
			"リモートノードに接続できません: 言語 'xx' はサポートされていません。en のいずれかを使用してください"
		);
		const long = reason("x".repeat(MAX_RELAY_VALUE_LENGTH));
		expect(long.length).toBeGreaterThan(MAX_RELAY_VALUE_LENGTH);
		// Too long to look up, and too much prose to be a plain value.
		expect(
			index().match(`remote node unreachable: ${long}`, "ja")
		).toBeUndefined();
	});
});

describe("label arguments", () => {
	const labels = (): LiteralTemplateIndex =>
		new LiteralTemplateIndex({
			...JAPANESE,
			"More about {titleLabel}": "{titleLabel}の詳細",
			"See pricing for {nameLabel} in {regionLabel}":
				"{regionLabel}の{nameLabel}の料金を見る",
			Departures: "出発",
			Connections: "接続",
		});

	test("a `…Label` value that is a catalog key is translated", () => {
		expect(labels().match("More about Departures", "ja")).toBe("出発の詳細");
		expect(
			labels().match("See pricing for Connections in Departures", "ja")
		).toBe("出発の接続の料金を見る");
	});

	test("label lookup does not depend on the locale's word order", () => {
		const german = new LiteralTemplateIndex({
			"Docs for {nameLabel} (opens in a new tab)":
				"Dokumentation für {nameLabel} (wird in einem neuen Tab geöffnet)",
			Extensions: "Erweiterungen",
		});
		expect(german.match("Docs for Extensions (opens in a new tab)", "de")).toBe(
			"Dokumentation für Erweiterungen (wird in einem neuen Tab geöffnet)"
		);
		const arabic = new LiteralTemplateIndex({
			"More about {titleLabel}": "المزيد عن {titleLabel}",
			Planets: "الكواكب",
		});
		expect(arabic.match("More about Planets", "ar")).toBe("المزيد عن الكواكب");
	});

	test("a plain `{title}` argument stays verbatim: it may be user content", () => {
		const index = new LiteralTemplateIndex({
			"More about {title}": "{title}について",
			Departures: "出発",
		});
		expect(index.match("More about Departures", "ja")).toBe(
			"Departuresについて"
		);
	});

	test("a `…Label` value without an exact entry stays verbatim", () => {
		expect(labels().match("More about My own board", "ja")).toBe(
			"My own boardの詳細"
		);
		// Only exact entries: a label is never matched against templates.
		expect(labels().match("More about Renamed Open settings", "ja")).toBe(
			"Renamed Open settingsの詳細"
		);
	});
});
