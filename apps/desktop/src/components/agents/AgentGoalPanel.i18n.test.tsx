// The prompt-cache confirmation names what changed. Those field labels must
// reach the dialog in the reader's language, not as English fragments inside a
// translated sentence.

import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { AgentGoalPanel } = await import("./AgentGoalPanel.tsx");

const GOAL_EN = "The bot's goal";
const GOAL_JA = "ボットの目標";

const JA: Record<string, string> = {
	[GOAL_EN]: GOAL_JA,
	"Main-thread reply length": "メインスレッドの返信の長さ",
	"{number, select, singular {{list} is part of the system prompt for {reach}. Each thread's next message re-sends its whole conversation at the full input price, once; replies after that are cached again. Switching models costs the same.} other {{list} are part of the system prompt for {reach}. Each thread's next message re-sends its whole conversation at the full input price, once; replies after that are cached again. Switching models costs the same.}}":
		"{number, select, singular {{list}は{reach}のシステムプロンプトの一部です。} other {{list}はいずれも{reach}のシステムプロンプトの一部です。}}",
	"this bot's threads, in every project":
		"すべてのプロジェクトにあるこのボットのスレッド",
};

const target = {
	token: "goal-token",
	url: "https://agent-goal.fixture",
	userJwt: null,
};
const originalFetch = globalThis.fetch;

function serveStoredGoal(): void {
	globalThis.fetch = Object.assign(
		(_input: RequestInfo | URL, _init?: RequestInit) =>
			Promise.resolve(
				Response.json({ guidance: { briefReplies: null, goal: "Ship" } })
			),
		{ preconnect: originalFetch.preconnect }
	);
}

async function until(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(`${what} did not settle: ${document.body.textContent}`);
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
}

async function typeGoal(container: HTMLElement, value: string): Promise<void> {
	const textarea = container.querySelector("textarea");
	if (!textarea) {
		throw new Error("goal field absent");
	}
	// The element's own prototype: React tracks the value through its setter.
	const setValue = Object.getOwnPropertyDescriptor(
		Object.getPrototypeOf(textarea),
		"value"
	)?.set;
	await act(async () => {
		setValue?.call(textarea, value);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

/** The panel's only button: "Save goal", localized by the catalog. */
async function clickSave(container: HTMLElement): Promise<void> {
	const button = container.querySelector("button");
	if (!button || button.disabled) {
		throw new Error("save button absent or disabled");
	}
	await act(async () => button.click());
}

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

test("the save confirmation names the bot's goal in Japanese", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	serveStoredGoal();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<AgentGoalPanel agentId="agent-1" target={target} />
			</I18nProvider>
		);
	});
	await until(
		() => container.querySelector("textarea")?.value === "Ship",
		"stored goal"
	);
	await typeGoal(container, "Ship weekly");
	await until(
		() => container.querySelector("button")?.disabled === false,
		"save button"
	);
	await clickSave(container);
	await until(
		() => document.body.querySelector('[role="alertdialog"]') !== null,
		"confirmation"
	);

	const dialog = document.body.querySelector('[role="alertdialog"]');
	const text = dialog?.textContent ?? "";
	expect(text).toContain(
		`${GOAL_JA}はすべてのプロジェクトにあるこのボットのスレッドのシステムプロンプトの一部です。`
	);
	expect(text).not.toContain(GOAL_EN);

	await act(async () => root.unmount());
});
