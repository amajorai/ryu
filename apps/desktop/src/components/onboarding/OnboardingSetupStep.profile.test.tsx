import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type { ProfileJobStatus } from "@/src/lib/api/onboarding-profile.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader, translate } = await import(
	"@ryu/i18n/core"
);
const { ProfileSetup, profileLines } = await import(
	"./OnboardingSetupStep.profile.tsx"
);

// A stand-in for the generated catalog: TextMorph splits each line per
// character, so the line must already be Japanese when it renders.
const JA: Record<string, string> = {
	"Reviewing your connected sources": "接続したソースを確認しています",
};

const BUILDING: ProfileJobStatus = {
	agentSuggestions: [],
	background: false,
	conversationId: null,
	error: null,
	id: "job-1",
	materialized: false,
	startedAtMs: 0,
	state: "building",
};

const roots: Root[] = [];

beforeEach(() => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

test("profile progress lines are whole tl() messages", () => {
	const lines = profileLines(translate);
	expect(lines).toHaveLength(5);
	expect(lines[0]).toBe("Reviewing your connected sources");
});

test("the first profile progress line renders in Japanese", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const noop = () => undefined;
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<ProfileSetup
					alreadyBuilt={false}
					job={BUILDING}
					nodeSetupKind={null}
					onBackground={noop}
					onCancel={noop}
					onContinueAfterBackground={noop}
					onSkip={noop}
					onStart={noop}
					startedAt={null}
				/>
			</I18nProvider>
		);
	});
	// Let the literal catalog load.
	await act(async () => {
		await Bun.sleep(50);
	});
	const status = container.querySelector('[role="status"]');
	expect(status?.textContent ?? "").toContain("接続したソースを確認しています");
	expect(status?.textContent ?? "").not.toContain("Reviewing");
});
