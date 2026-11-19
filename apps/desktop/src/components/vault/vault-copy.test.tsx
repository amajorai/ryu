import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Root } from "react-dom/client";
import {
	click,
	flush,
	installAnimationApis,
	registerDomWithNativeNetworking,
	text,
	until,
} from "../settings/unswept-a.test-support.ts";

// The copy toast reads in the active locale with the DOM localizer off, so a
// title that skipped `tl` would show up here as English.
setDefaultTimeout(20_000);
registerDomWithNativeNetworking();

const JA: Record<string, string> = {
	Copied: "コピーしました",
	"Could not copy": "コピーできませんでした",
};

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider, useLiteralMessages } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { copyWithToast } = await import("./vault-copy.ts");
installAnimationApis();

let root: Root | null = null;
const outcomes: boolean[] = [];

function CopyButton() {
	const tl = useLiteralMessages();
	return (
		<button
			onClick={async () => outcomes.push(await copyWithToast("s3cr3t", tl))}
			type="button"
		>
			copy
		</button>
	);
}

function stubClipboard(writeText: (value: string) => Promise<void>): void {
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText },
	});
}

async function mount(): Promise<void> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JA : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<Toaster />
				<CopyButton />
			</I18nProvider>
		)
	);
	await flush(4);
}

function copyButton(): HTMLElement {
	const found = [...document.querySelectorAll("button")].find(
		(item) => item.textContent === "copy"
	);
	if (!found) {
		throw new Error(`No copy button: ${text()}`);
	}
	return found;
}

afterEach(async () => {
	registerLiteralCatalogLoader(null);
	await act(async () => root?.unmount());
	root = null;
	outcomes.length = 0;
	document.body.replaceChildren();
});

test("a successful copy writes the value and toasts in the active locale", async () => {
	const written: string[] = [];
	stubClipboard(async (value) => {
		written.push(value);
	});
	await mount();
	await click(copyButton());
	await until(() => text().includes("コピーしました"), "copied toast");
	expect(written).toEqual(["s3cr3t"]);
	expect(outcomes).toEqual([true]);
	expect(text()).not.toContain("Copied");
});

test("a refused copy toasts the translated failure", async () => {
	stubClipboard(() => Promise.reject(new Error("denied")));
	await mount();
	await click(copyButton());
	await until(() => text().includes("コピーできませんでした"), "failure toast");
	expect(outcomes).toEqual([false]);
	expect(text()).not.toContain("Could not copy");
});
