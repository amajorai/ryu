import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LanguagePack } from "@ryu/i18n";
import { messageIdForLiteral } from "@ryu/i18n/core";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HistorySource } from "@/src/lib/api/usage-history.ts";
import { SourceCoverage } from "./UsageHistoryDashboard-accounts.tsx";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LIMITATION =
	"Only retained usage counters are imported. Missing fields stay unknown; source costs are not bills.";
const JAPANESE =
	"保持されている使用量カウンターのみを取り込みます。欠けている項目は不明のままです。ソースのコストは請求額ではありません。";
const pack: LanguagePack = {
	baseLocale: "en",
	direction: "ltr",
	id: "test/ja",
	locale: "ja",
	messages: { [messageIdForLiteral(LIMITATION)]: JAPANESE },
	name: "Japanese",
	schemaVersion: 1,
	version: "1.0.0",
};

describe("SourceCoverage under a Japanese pack", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	it("renders Core's English source limitations in the UI language", async () => {
		const sources: HistorySource[] = [
			{
				available: true,
				id: "codex",
				label: "Codex",
				limitations: LIMITATION,
				transport: "localFiles",
			},
		];
		await act(async () => {
			root.render(
				<I18nProvider
					autoLocalizeDom={false}
					initialPackId={pack.id}
					manageDocument={false}
					packs={[pack]}
				>
					<SourceCoverage sources={sources} />
				</I18nProvider>
			);
		});
		expect(container.textContent).toContain(JAPANESE);
		expect(container.textContent).not.toContain(LIMITATION);
	});
});
