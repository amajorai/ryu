import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { DirectionProvider } = await import("@ryu/ui/components/direction.tsx");
const { ProviderCommandDialog } = await import(
	"@/components/agent-elements/input/provider-command-dialog.tsx"
);
const { UniversalPickerBody } = await import(
	"@/components/agent-elements/input/universal-picker-body.tsx"
);
const { COMPOSER_SELECT_ITEM } = await import(
	"@/components/agent-elements/input/composer-select.ts"
);

/** Physical inline utilities that pin a picker row to the left in RTL. */
const PHYSICAL_CLASS =
	/(?:^|\s)(?:text-(?:left|right)|-?m[lr]-[\d[]|p[lr]-[\d[]|(?:left|right)-[\d[])/;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function refuse(): never {
	throw new Error("The RTL picker proof selected something unexpectedly");
}

beforeEach(() => {
	document.documentElement.dir = "rtl";
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	document.documentElement.removeAttribute("dir");
});

function RtlPicker() {
	return (
		<DirectionProvider direction="rtl">
			<ProviderCommandDialog
				renderBody={(close) => (
					<UniversalPickerBody
						close={close}
						data={{
							activeAgentId: "custom-codex",
							activeExtraSections: [],
							activeModelSection: {
								ariaLabel: "Select model",
								items: [
									{ description: "Fast", id: "model-a", name: "Model A" },
									{ description: "Deep", id: "model-b", name: "Model B" },
								],
								key: "model",
								label: "Model",
								onChange: refuse,
								value: "model-a",
							},
							agents: [],
							availableExternal: [],
							customAgents: [],
							installedExternal: [],
							installPendingId: null,
							onConfigureCredentials: refuse,
							onInstallExternal: refuse,
							onRemoveAgentAccount: refuse,
							onRemoveProviderAccount: refuse,
							onSelectAgent: refuse,
							onSelectProviderModel: refuse,
							onSelectProviderThinking: refuse,
							onSwitchAgentAccount: refuse,
							onSwitchProviderAccount: refuse,
							onUpgrade: refuse,
							onUseProvider: refuse,
							providers: [],
							ryuActive: false,
							ryuAgent: null,
							teams: [],
							thinkingLevels: [],
						}}
						mode="models"
					/>
				)}
				trigger={<button type="button">Choose model</button>}
			/>
		</DirectionProvider>
	);
}

async function click(label: string, selector: string) {
	const node = [...document.querySelectorAll<HTMLElement>(selector)].find(
		(candidate) => candidate.textContent?.trim() === label
	);
	if (!node) {
		throw new Error(`Missing ${label}; rendered ${document.body.textContent}`);
	}
	await act(async () => node.click());
}

test("composer picker rows align to the inline start", () => {
	expect(COMPOSER_SELECT_ITEM).toContain("text-start");
	expect(PHYSICAL_CLASS.test(COMPOSER_SELECT_ITEM)).toBe(false);
});

test("a drilled picker page renders no physical inline classes and mirrors its Back arrow", async () => {
	await act(async () => root.render(<RtlPicker />));
	await click("Choose model", "button");
	await click("ModelModel A", '[role="option"]');

	const options = [...document.querySelectorAll('[role="option"]')];
	expect(options.length).toBeGreaterThan(0);
	for (const option of options) {
		for (const node of [option, ...option.querySelectorAll("*")]) {
			const className = node.getAttribute("class") ?? "";
			expect(PHYSICAL_CLASS.test(className)).toBe(false);
		}
	}
	const back = options.find((option) =>
		option.textContent?.includes("Back to")
	);
	expect(back?.querySelector("[data-directional-icon]")).not.toBeNull();
});
