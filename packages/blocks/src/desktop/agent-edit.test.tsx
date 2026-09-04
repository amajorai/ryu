import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	AgentSettingsForm,
	type AgentSettingsFormProps,
} from "./agent-edit.tsx";

function baseProps(
	overrides: Partial<AgentSettingsFormProps> = {}
): AgentSettingsFormProps {
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
		name: "Support desk",
		personaDisplayName: "",
		rules: [],
		schedulePhrase: "daily",
		selectedComposio: new Set(),
		selectedSkills: new Set(),
		selectedTools: new Set(),
		skills: [],
		spaces: [],
		systemPrompt: "Triage support requests and ask before making changes.",
		tone: "neutral",
		toneOptions: [{ label: "Neutral", value: "neutral" }],
		tools: [],
		triggerError: null,
		triggerSlug: "",
		triggerSubs: [],
		weeklyDay: "monday",
		weeklyTime: "09:00",
		healthBadge: <span>Health A</span>,
		healthPanel: <div>Health content</div>,
		initialTab: "health",
		...overrides,
	};
}

describe("AgentSettingsForm health integration", () => {
	test("renders the injected health panel as an editor tab", () => {
		const html = renderToStaticMarkup(<AgentSettingsForm {...baseProps()} />);

		expect(html).toContain("Health content");
		expect(html).toContain("Health A");
	});
});
