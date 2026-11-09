import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const LOCAL_NODE = {
	name: "local",
	token: null,
	url: "http://127.0.0.1:7980",
	userJwt: null,
};

// Skip the real local bring-up: no Core, no Tauri, no catalog call.
const realLocalStack = await import("./OnboardingPage.local-stack.ts");
mock.module("./OnboardingPage.local-stack.ts", () => ({
	...realLocalStack,
	refreshLocalNode: () => Promise.resolve(LOCAL_NODE),
	waitForLocalStack: () => Promise.resolve(),
}));
const realAgents = await import("./OnboardingPage.agents.tsx");
mock.module("./OnboardingPage.agents.tsx", () => ({
	...realAgents,
	loadOnboardingAgents: () =>
		Promise.resolve({ found: [], ok: true, suggested: [] }),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { STAGE_AGENTS } = await import("./OnboardingPage.local-stack.ts");
const { useOnboardingAgentsStep } = await import(
	"./OnboardingPage.agents-step.ts"
);

const LOOKING_JA = "システム上のエージェントを探しています…";
// Stub Arabic copy: the shipped catalog may not carry this key yet.
const CATALOGS: Record<string, Record<string, string>> = {
	ar: { "Looking for agents on your system…": "جارٍ البحث عن وكلاء على نظامك…" },
	ja: { "Looking for agents on your system…": LOOKING_JA },
};

const noop = () => undefined;

type BeginLocalSetup = ReturnType<
	typeof useOnboardingAgentsStep
>["beginLocalSetup"];

function Harness({
	onReady,
	statuses,
}: {
	onReady: (begin: BeginLocalSetup) => void;
	statuses: [string | null, number | null | undefined][];
}) {
	const { beginLocalSetup } = useOnboardingAgentsStep({
		agentsNode: null,
		agentsRetrying: false,
		cancelledRef: { current: false },
		featureIndex: 0,
		goToFeatures: noop,
		goToMic: noop,
		localReport: {
			done: noop,
			status: (line: string | null, percent?: number | null) => {
				statuses.push([line, percent]);
			},
		},
		setAgentsNode: noop,
		setAgentsRetrying: noop,
		setAgentsUnavailable: noop,
		setFeatureIndex: noop,
		setFoundAgents: noop,
		setPhase: noop,
		setSelected: noop,
		setSuggestedAgents: noop,
	} as unknown as Parameters<typeof useOnboardingAgentsStep>[0]);
	onReady(beginLocalSetup);
	return null;
}

async function runLocalSetup(
	locale: string
): Promise<[string | null, number | null | undefined][]> {
	registerLiteralCatalogLoader((requested) => {
		const base = requested.split("-")[0] ?? requested;
		return CATALOGS[base] ?? {};
	});
	const statuses: [string | null, number | null | undefined][] = [];
	let begin: BeginLocalSetup | null = null;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<Harness
					onReady={(next) => {
						begin = next;
					}}
					statuses={statuses}
				/>
			</I18nProvider>
		);
	});
	// Let the stub catalog load before the status line is produced.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	await act(async () => {
		await (begin as BeginLocalSetup | null)?.();
	});
	await act(async () => root.unmount());
	container.remove();
	return statuses;
}

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

test("the agent detection status line is localized", async () => {
	const statuses = await runLocalSetup("ja");
	expect(statuses[0]).toEqual([LOOKING_JA, STAGE_AGENTS]);
	// Detection finished: the bar is handed back.
	expect(statuses.at(-1)?.[0]).toBeNull();
});

test("an RTL reader gets the Arabic status line", async () => {
	const statuses = await runLocalSetup("ar");
	expect(statuses[0]?.[0]).toBe("جارٍ البحث عن وكلاء على نظامك…");
});
