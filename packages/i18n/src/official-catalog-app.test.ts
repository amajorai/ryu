import { afterEach, describe, expect, test } from "bun:test";

import { I18nRuntime } from "./core.ts";
import {
	messageIdForLiteral,
	registerLiteralCatalogLoader,
} from "./literal-catalog.ts";
import {
	type AppCatalogHostRuntime,
	type LoadedAppCatalog,
	OfficialAppCatalogLayer,
	officialAppCatalogKey,
	officialAppCatalogSlug,
	officialAppCatalogUrl,
	parseOfficialAppCatalog,
} from "./official-catalog-app.ts";

afterEach(() => registerLiteralCatalogLoader(null));

/** A host that bundles only its own subset, like the mobile app. */
function host(locale: string, own: Record<string, string> = {}) {
	registerLiteralCatalogLoader(() => own);
	const runtime = new I18nRuntime([], {
		initialLocale: locale,
		initialPackId: null,
	});
	const bridge: AppCatalogHostRuntime = {
		getSnapshot: runtime.getSnapshot,
		subscribe: runtime.subscribe,
		t: (id, values, fallback) => runtime.translate(id, values, fallback),
	};
	return bridge;
}

/** The bridge a frame talks to: `runtime` with `loaded` layered under it. */
function withOfficialAppCatalog(
	runtime: AppCatalogHostRuntime,
	loaded: LoadedAppCatalog | null
): AppCatalogHostRuntime {
	const layer = new OfficialAppCatalogLayer();
	layer.setCatalog(loaded);
	return layer.over(runtime);
}

const FINETUNE_JA = {
	"Delete {name}?": "{name} を削除しますか?",
	"Export {count} runs": "{count} 件の実行をエクスポート",
	"Training loss": "学習損失",
};

describe("app catalog addressing", () => {
	test("only official @ryu apps in official locales have a catalog", () => {
		expect(officialAppCatalogSlug("@ryu/finetune")).toBe("finetune");
		expect(officialAppCatalogSlug("@acme/finetune")).toBeNull();
		expect(officialAppCatalogSlug("@ryu/../secrets")).toBeNull();
		expect(officialAppCatalogKey("@ryu/finetune", "ja-JP")).toEqual({
			locale: "ja",
			slug: "finetune",
		});
		expect(officialAppCatalogKey("@ryu/finetune", "en")).toBeNull();
		expect(
			officialAppCatalogUrl(
				{ locale: "pt-BR", slug: "video-studio" },
				"https://cdn.test/apps/"
			)
		).toBe("https://cdn.test/apps/video-studio/pt-BR.json");
	});

	test("a fetched body must be a string map", () => {
		expect(parseOfficialAppCatalog('{"Save":"保存"}')).toEqual({
			Save: "保存",
		});
		expect(parseOfficialAppCatalog("<html>404</html>")).toBeNull();
		expect(parseOfficialAppCatalog('{"Save":1}')).toBeNull();
		expect(parseOfficialAppCatalog("[]")).toBeNull();
	});
});

describe("a Companion frame on a host without the app's copy", () => {
	test("resolves app literals, ICU messages and templates from the app catalog", () => {
		const bridge = withOfficialAppCatalog(host("ja"), {
			catalog: FINETUNE_JA,
			locale: "ja",
		});
		expect(
			bridge.t(messageIdForLiteral("Training loss"), {}, "Training loss")
		).toBe("学習損失");
		expect(
			bridge.t(
				messageIdForLiteral("Export {count} runs"),
				{ count: 3 },
				"Export {count} runs"
			)
		).toBe("3 件の実行をエクスポート");
		// Satellite copy arrives already formatted and matches a template.
		expect(
			bridge.t(messageIdForLiteral("Delete Run 7?"), {}, "Delete Run 7?")
		).toBe("Run 7 を削除しますか?");
		// Data and unknown copy pass through.
		expect(bridge.t(messageIdForLiteral("gpt-ft-01"), {}, "gpt-ft-01")).toBe(
			"gpt-ft-01"
		);
	});

	test("the host's own translation wins over the app catalog", () => {
		const bridge = withOfficialAppCatalog(
			host("ja", { "Training loss": "ホストの訳" }),
			{ catalog: FINETUNE_JA, locale: "ja" }
		);
		expect(
			bridge.t(messageIdForLiteral("Training loss"), {}, "Training loss")
		).toBe("ホストの訳");
	});

	test("a catalog for another language never answers", () => {
		const bridge = withOfficialAppCatalog(host("de"), {
			catalog: FINETUNE_JA,
			locale: "ja",
		});
		expect(
			bridge.t(messageIdForLiteral("Training loss"), {}, "Training loss")
		).toBe("Training loss");
	});

	test("a catalog that arrives late tells subscribed frames to retry", () => {
		const layer = new OfficialAppCatalogLayer();
		const bridge = layer.over(host("ja"));
		let published = 0;
		const unsubscribe = bridge.subscribe(() => {
			published += 1;
		});
		const id = messageIdForLiteral("Training loss");
		expect(bridge.t(id, {}, "Training loss")).toBe("Training loss");
		layer.setCatalog({ catalog: FINETUNE_JA, locale: "ja" });
		expect(published).toBe(1);
		expect(bridge.t(id, {}, "Training loss")).toBe("学習損失");
		unsubscribe();
		layer.setCatalog(null);
		expect(published).toBe(1);
	});
});
