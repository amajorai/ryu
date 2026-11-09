import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The weekly schedule's row picks a day of the week. "Day" is the calendar-day
// key (the Day view, a date's day field), so locales that tell the two apart
// (ja 日 vs 曜日) must read the row's title from "Day of week".
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
	Day: "日",
	"Day of week": "曜日",
};

const props: Props = {
	acpCommand: "",
	chatModel: "acp:ryu",
	composioActions: [],
	composioConfigured: false,
	composioToolkit: null,
	composioToolkitItems: [],
	composioTriggers: [],
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

/** The title of the settings row that holds the weekday picker. */
async function weekdayRowTitle(locale: string): Promise<string> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JA : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<AgentTriggersPanel accountAccessPath="" props={props} />
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
	const picker = container.querySelector("#weekly-day");
	if (!picker) {
		throw new Error("the weekday picker did not render");
	}
	let row = picker.parentElement;
	while (row && !row.querySelector('[data-slot="item-title"]')) {
		row = row.parentElement;
	}
	return row?.querySelector('[data-slot="item-title"]')?.textContent ?? "";
}

test("the weekly schedule's weekday row is titled Day of week", async () => {
	expect(await weekdayRowTitle("en")).toBe("Day of week");
});

test("the weekday row uses the day-of-week sense in Japanese", async () => {
	const title = await weekdayRowTitle("ja");
	expect(title).toBe("曜日");
	expect(title).not.toBe("日");
});
