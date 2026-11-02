import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../i18n/src/active-locale.ts";
import { runAgentScorecard } from "./agent-scorecard.ts";
import type { AgentHealthInput } from "./agent-scorecard-types.ts";
import {
	CATEGORY_DESCRIPTIONS,
	CATEGORY_LABELS,
} from "./scorecard-contract.ts";

const CONNECTIONS =
	"{count, plural, one {# external connection is} other {# external connections are}} bound; review them before promoting the agent.";
const CONNECTIONS_RU =
	"{count, plural, one {Привязано # внешнее подключение} few {Привязано # внешних подключения} many {Привязано # внешних подключений} other {Привязано # внешнего подключения}}; проверьте их перед продвижением агента.";

const runtime = {
	direction: "ltr" as const,
	locale: "ru",
	translate(source: string, values?: MessageValuesInput, fallback?: string) {
		const message = fallback === CONNECTIONS ? CONNECTIONS_RU : fallback;
		return formatMessage(message ?? source, values, "ru");
	},
};

function agent(connections: number): AgentHealthInput {
	return {
		access: {
			composioActionCount: connections,
			highImpactCount: 0,
			identityProfileCount: 0,
		},
		automation: { scheduleEnabled: false, triggerCount: 0 },
		description:
			"Reviews incoming support requests and drafts careful replies.",
		instructions:
			"Review the request, explain the decision, and ask before making any external change.",
		lifecycleStatus: "trial",
		memoryWriteEnabled: false,
		model: { configured: true, required: true },
		name: "Support desk",
		runtime: { label: "Ryu", status: "ready" },
		safetyProfile: "read_only",
		skills: {
			allSelected: false,
			availableCount: 3,
			loaded: true,
			selectedCount: 1,
		},
		tools: {
			allSelected: false,
			availableCount: 4,
			loaded: true,
			selectedCount: 2,
		},
	};
}

const connectionDetail = (connections: number) =>
	runAgentScorecard(agent(connections)).checks.find(
		(check) => check.id === "external-connections"
	)?.detail;

describe("agent scorecard plurals", () => {
	afterEach(() => {
		unregisterActiveI18nRuntime(runtime);
	});

	test("keep the English sentences without a provider", () => {
		expect(connectionDetail(1)).toBe(
			"1 external connection is bound; review them before promoting the agent."
		);
		expect(connectionDetail(3)).toBe(
			"3 external connections are bound; review them before promoting the agent."
		);
	});

	test("use the UI locale's plural categories, not an English +s", () => {
		registerActiveI18nRuntime(runtime);
		expect(connectionDetail(1)).toContain("1 внешнее подключение");
		expect(connectionDetail(3)).toContain("3 внешних подключения");
		expect(connectionDetail(5)).toContain("5 внешних подключений");
	});
});

const JA: Record<string, string> = {
	"Has an agent name": "エージェント名がある",
	"Tool access is scoped": "ツールへのアクセスが限定されている",
	Configuration: "構成",
	"Whether anyone is still looking after it.": "今も保守されているかどうか。",
	"{status, select, trial {Trial} other {Active}} can be tested under Core's lifecycle rules.":
		"{status, select, trial {試用版} other {有効版}}は Core のライフサイクル規則でテストできます。",
};

const jaRuntime = {
	direction: "ltr" as const,
	locale: "ja",
	translate(source: string, values?: MessageValuesInput, fallback?: string) {
		const message = fallback ?? source;
		return formatMessage(JA[message] ?? message, values, "ja");
	},
};

describe("agent scorecard check copy", () => {
	afterEach(() => {
		unregisterActiveI18nRuntime(jaRuntime);
	});

	test("translates labels per run in the active UI locale", () => {
		const english = runAgentScorecard(agent(0));
		expect(english.checks.find((c) => c.id === "name")?.label).toBe(
			"Has an agent name"
		);

		registerActiveI18nRuntime(jaRuntime);
		const japanese = runAgentScorecard(agent(0));
		expect(japanese.checks.find((c) => c.id === "name")?.label).toBe(
			"エージェント名がある"
		);
		expect(japanese.checks.find((c) => c.id === "tools-scope")?.label).toBe(
			"ツールへのアクセスが限定されている"
		);
	});

	test("translates category headings on every read", () => {
		expect(CATEGORY_LABELS.configuration).toBe("Configuration");
		registerActiveI18nRuntime(jaRuntime);
		expect(CATEGORY_LABELS.configuration).toBe("構成");
		expect(CATEGORY_DESCRIPTIONS.maintenance).toBe(
			"今も保守されているかどうか。"
		);
	});

	test("keeps the lifecycle posture inside one sentence", () => {
		const detail = runAgentScorecard(agent(0)).checks.find(
			(c) => c.id === "lifecycle"
		)?.detail;
		expect(detail).toBe("Trial can be tested under Core's lifecycle rules.");

		registerActiveI18nRuntime(jaRuntime);
		const japanese = runAgentScorecard(agent(0)).checks.find(
			(c) => c.id === "lifecycle"
		)?.detail;
		expect(japanese).toBe(
			"試用版は Core のライフサイクル規則でテストできます。"
		);
	});
});
