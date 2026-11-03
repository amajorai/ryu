import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LanguagePack } from "@ryu/i18n";
import { messageIdForLiteral } from "@ryu/i18n/core";
import { I18nProvider, useLiteralMessages } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { unsupportedReason } from "./EnginesCatalogSection-model.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CORE_REASON = "Needs a Mac with Apple Silicon (M1 or newer).";
const JAPANESE = "Apple シリコン (M1 以降) の Mac が必要です。";
const NO_PLATFORMS = "Not available on this node";
const JA_NO_PLATFORMS = "このノードでは利用できません";
const pack: LanguagePack = {
	baseLocale: "en",
	direction: "ltr",
	id: "test/ja",
	locale: "ja",
	messages: {
		[messageIdForLiteral(CORE_REASON)]: JAPANESE,
		[messageIdForLiteral(NO_PLATFORMS)]: JA_NO_PLATFORMS,
	},
	name: "Japanese",
	schemaVersion: 1,
	version: "1.0.0",
};

function Reason({
	coreReason,
	platforms = ["macos"],
}: {
	coreReason?: string;
	platforms?: string[];
}) {
	const tl = useLiteralMessages();
	return <p>{unsupportedReason(tl, platforms, coreReason)}</p>;
}

describe("unsupportedReason under a Japanese pack", () => {
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

	const render = async (coreReason?: string, platforms?: string[]) => {
		await act(async () => {
			root.render(
				<I18nProvider
					autoLocalizeDom={false}
					initialPackId={pack.id}
					manageDocument={false}
					packs={[pack]}
				>
					<Reason coreReason={coreReason} platforms={platforms} />
				</I18nProvider>
			);
		});
		return container.textContent;
	};

	it("translates Core's English requirement line", async () => {
		expect(await render(`  ${CORE_REASON} `)).toBe(JAPANESE);
	});

	it("keeps an uncatalogued Core reason in English", async () => {
		expect(await render("Needs a custom build.")).toBe("Needs a custom build.");
	});

	it("translates the no-platform fallback for an older Core", async () => {
		expect(await render(undefined, [])).toBe(JA_NO_PLATFORMS);
	});
});
