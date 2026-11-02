import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { useAgentBadgeLabels } = await import("./agent-badge-labels.ts");
const { ENGLISH_AGENT_BADGE_LABELS } = await import("./agent-badge.ts");

type Labels = ReturnType<typeof useAgentBadgeLabels>;

const seen: Labels[] = [];

function Probe({ tick }: { tick: number }) {
	const labels = useAgentBadgeLabels();
	seen.push(labels);
	return <output data-tick={tick}>{labels.propertyOf}</output>;
}

async function renderTwice(wrap: (node: React.ReactNode) => React.ReactNode) {
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	await act(async () => {
		root.render(wrap(<Probe tick={1} />));
	});
	await act(async () => {
		root.render(wrap(<Probe tick={2} />));
	});
	await act(async () => {
		root.unmount();
	});
}

afterEach(() => {
	seen.length = 0;
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

test("prints the English card without a provider", async () => {
	await renderTwice((node) => node);
	expect(seen.at(-1)).toEqual(ENGLISH_AGENT_BADGE_LABELS);
});

test("prints the card in the UI language and keeps one object across renders", async () => {
	registerLiteralCatalogLoader(() => ({
		"Property of": "所有者",
		Serial: "シリアル",
	}));
	await renderTwice((node) => (
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale="ja"
			initialPackId={null}
		>
			{node}
		</I18nProvider>
	));
	const last = seen.at(-1);
	expect(last?.locale).toBe("ja");
	expect(last?.propertyOf).toBe("所有者");
	expect(last?.serial).toBe("シリアル");
	expect(last?.rtl).toBe(false);
	// The paint effect keys on identity: re-renders with the same words must
	// not hand back a new object.
	expect(seen.at(-2)).toBe(last);
});

test("marks right-to-left locales", async () => {
	await renderTwice((node) => (
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale="ar"
			initialPackId={null}
		>
			{node}
		</I18nProvider>
	));
	expect(seen.at(-1)?.rtl).toBe(true);
});
