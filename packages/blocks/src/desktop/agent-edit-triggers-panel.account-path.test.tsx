import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// With no allowed account, the triggers tab says where to allow one. That
// place is named with the tab labels the reader sees (in the simple editor,
// Account access sits under Identity), so a Japanese reader gets Japanese
// tab names instead of an English path inside a Japanese sentence.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { AgentTriggersPanel } = await import("./agent-edit-triggers-panel.tsx");
type Props = import("./agent-edit-form-types.ts").AgentSettingsFormProps;

const JA: Record<string, string> = {
	"Account access": "アカウントへのアクセス",
	Connections: "接続",
	Identity: "ID 情報",
	"Tools & knowledge": "ツールとナレッジ",
	"{from} → {to}": "{from} → {to}",
};

const props: Props = {
	acpCommand: "",
	chatModel: "acp:ryu",
	composioActions: [],
	composioConfigured: false,
	composioToolkit: "github",
	composioToolkitItems: [],
	composioTriggers: [],
	composioAccounts: [],
	connectedAccountId: "",
	customCron: "",
	customTone: "",
	dailyTime: "09:00",
	engineOptions: [{ id: "acp:ryu", label: "Ryu" }],
	isBuiltIn: false,
	isLocked: false,
	isNew: false,
	memoryReadLevels: new Set(),
	memorySpaceIds: new Set(),
	memoryWriteEnabled: false,
	name: "Release notes",
	personaDisplayName: "",
	rules: [],
	scheduleEnabled: true,
	schedulePhrase: "weekly",
	selectedComposio: new Set(),
	selectedSkills: new Set(),
	selectedTools: new Set(),
	showComposioTriggers: true,
	skills: [],
	spaces: [],
	systemPrompt: "",
	tone: "neutral",
	toneOptions: [{ label: "Neutral", value: "neutral" }],
	tools: [],
	triggerError: null,
	triggerSlug: "",
	triggerSubs: [],
	weeklyDay: "thursday",
	weeklyTime: "07:45",
};

let unmount: (() => Promise<void>) | undefined;

afterEach(async () => {
	await unmount?.();
	unmount = undefined;
	registerLiteralCatalogLoader(null);
});

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function noAccountHint(
	locale: string,
	accountAccessInIdentity: boolean
): Promise<string> {
	// One test may render twice; unmount the earlier tree first.
	await unmount?.();
	unmount = undefined;
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JA : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<AgentTriggersPanel
					accountAccessInIdentity={accountAccessInIdentity}
					props={props}
				/>
			</I18nProvider>
		);
	});
	unmount = async () => {
		await act(async () => root.unmount());
		container.remove();
	};
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const hint = [...container.querySelectorAll("p")].find((node) =>
		node.textContent?.includes("github")
	);
	return hint?.textContent ?? "";
}

test("English names the Connections tab path by default", async () => {
	expect(await noAccountHint("en", false)).toContain(
		"allow one under Connections → Account access."
	);
});

test("the simple editor names the Identity path", async () => {
	expect(await noAccountHint("en", true)).toContain(
		"allow one under Tools & knowledge → Identity."
	);
});

test("Japanese reads the path from the translated tab labels", async () => {
	const connections = await noAccountHint("ja", false);
	expect(connections).toContain("接続 → アカウントへのアクセス");
	expect(connections).not.toContain("Connections → Account access");
	const identity = await noAccountHint("ja", true);
	expect(identity).toContain("ツールとナレッジ → ID 情報");
	expect(identity).not.toContain("Tools & knowledge → Identity");
});
