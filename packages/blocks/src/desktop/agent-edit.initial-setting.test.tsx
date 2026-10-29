import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
const { AgentSettingsForm } = await import("./agent-edit.tsx");
const { AGENT_ACCOUNT_ACCESS_SETTING_ID } = await import(
	"./agent-settings-search.ts"
);
type FormProps = Parameters<typeof AgentSettingsForm>[0];

afterAll(async () => {
	await GlobalRegistrator.unregister();
});

function props(overrides: Partial<FormProps>): FormProps {
	return {
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
		name: "Researcher",
		personaDisplayName: "",
		rules: [],
		schedulePhrase: "daily",
		selectedComposio: new Set(),
		selectedSkills: new Set(),
		selectedTools: new Set(),
		skills: [],
		spaces: [],
		systemPrompt: "Research carefully.",
		tone: "neutral",
		toneOptions: [{ label: "Neutral", value: "neutral" }],
		tools: [],
		triggerError: null,
		triggerSlug: "",
		triggerSubs: [],
		weeklyDay: "monday",
		weeklyTime: "09:00",
		...overrides,
	};
}

async function mount(form: FormProps): Promise<{
	text: () => string;
	unmount: () => void;
}> {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(<AgentSettingsForm {...form} />);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return {
		text: () => host.textContent ?? "",
		unmount: () => {
			act(() => root.unmount());
			host.remove();
		},
	};
}

test("the editor opens on Account access when a host asks for it", async () => {
	const view = await mount(
		props({
			accountAccessPanel: <div>Access list</div>,
			identityModePanel: <div>Identity cards</div>,
			initialSettingId: AGENT_ACCOUNT_ACCESS_SETTING_ID,
		})
	);
	try {
		expect(view.text()).toContain("Access list");
	} finally {
		view.unmount();
	}
});

test("the simple editor opens Account access under Identity", async () => {
	const view = await mount(
		props({
			accountAccessPanel: <div>Access list</div>,
			identityModePanel: <div>Identity cards</div>,
			initialSettingId: AGENT_ACCOUNT_ACCESS_SETTING_ID,
			simple: true,
		})
	);
	try {
		expect(view.text()).toContain("Identity cards");
		expect(view.text()).toContain("Access list");
	} finally {
		view.unmount();
	}
});

test("without a requested setting the editor opens on Behavior", async () => {
	const view = await mount(
		props({ accountAccessPanel: <div>Access list</div> })
	);
	try {
		expect(view.text()).not.toContain("Access list");
	} finally {
		view.unmount();
	}
});
