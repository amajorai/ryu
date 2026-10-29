import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { UniversalPickerData } from "@/components/agent-elements/input/universal-picker-body.tsx";
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ProviderCommandDialog } = await import(
	"@/components/agent-elements/input/provider-command-dialog.tsx"
);
const { UniversalPickerBody } = await import(
	"@/components/agent-elements/input/universal-picker-body.tsx"
);
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const changes: string[] = [];
const unexpected: string[] = [];
function refuseOtherSelection(): never {
	throw new Error("Model chooser attempted a different target action");
}
const base: UniversalPickerData = {
	activeAgentId: "custom-codex",
	activeExtraSections: [],
	activeModelSection: null,
	agents: [],
	availableExternal: [],
	customAgents: [],
	installedExternal: [],
	installPendingId: null,
	providers: [],
	ryuActive: false,
	ryuAgent: null,
	teams: [],
	thinkingLevels: [],
	onConfigureCredentials: refuseOtherSelection,
	onInstallExternal: refuseOtherSelection,
	onRemoveAgentAccount: refuseOtherSelection,
	onRemoveProviderAccount: refuseOtherSelection,
	onSelectAgent: refuseOtherSelection,
	onSelectProviderModel: refuseOtherSelection,
	onSelectProviderThinking: refuseOtherSelection,
	onSwitchAgentAccount: refuseOtherSelection,
	onSwitchProviderAccount: refuseOtherSelection,
	onUpgrade: refuseOtherSelection,
	onUseProvider: refuseOtherSelection,
};
const originalFetch = globalThis.fetch;
beforeEach(() => {
	changes.length = unexpected.length = 0;
	globalThis.fetch = Object.assign(
		async (...args: Parameters<typeof fetch>) => {
			const input = args[0];
			unexpected.push(String(input));
			throw new Error(`Unexpected HTTP in model chooser: ${String(input)}`);
		},
		{
			preconnect: (...args: Parameters<typeof fetch.preconnect>) => {
				unexpected.push(`preconnect:${String(args[0])}`);
				throw new Error(
					`Unexpected preconnect in model chooser: ${String(args[0])}`
				);
			},
		}
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	globalThis.fetch = originalFetch;
	expect(unexpected).toEqual([]);
});
function Harness({ withModel = true }: { withModel?: boolean }) {
	const [model, setModel] = useState("model-a");
	return (
		<ProviderCommandDialog
			trigger={<button type="button">Choose model</button>}
			renderBody={(close) => (
				<UniversalPickerBody
					mode="models"
					close={close}
					data={{
						...base,
						activeModelSection: withModel
							? {
									key: "model",
									ariaLabel: "Select model",
									label: "Model",
									value: model,
									items: [
										{ id: "model-a", name: "Proof Model A" },
										{ id: "model-b", name: "Proof Model B" },
									],
									onChange: (id) => {
										changes.push(id);
										setModel(id);
									},
								}
							: null,
					}}
				/>
			)}
		/>
	);
}
async function click(label: string, role: string) {
	const button = [
		...document.querySelectorAll<HTMLElement>(
			role === "button" ? "button" : '[role="option"]'
		),
	].find((node) => node.textContent?.trim() === label);
	if (!button)
		throw new Error(
			`Missing real ${role} ${label}; rendered ${document.body.textContent}`
		);
	await act(async () => button.click());
}
test("the real model dialog exposes the current engine catalog without any configured providers and selects exactly that model", async () => {
	await act(async () => root.render(<Harness />));
	await click("Choose model", "button");
	await click("ModelProof Model A", "option");
	await click("Proof Model B", "option");
	expect(changes).toEqual(["model-b"]);
	expect(document.querySelector('[role="dialog"]')).toBeNull();
	await click("Choose model", "button");
	await click("ModelProof Model B", "option");
	const selected = [...document.querySelectorAll('[role="option"]')].find(
		(node) => node.textContent?.trim() === "Proof Model B"
	);
	expect(selected?.getAttribute("data-checked")).toBe("true");
	expect(changes).toEqual(["model-b"]);
});

test("canceling a drilled model page does not choose a model and reopening starts at the catalog root", async () => {
	await act(async () => root.render(<Harness />));
	await click("Choose model", "button");
	await click("ModelProof Model A", "option");
	const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
	if (!input) throw new Error("Real command search input is missing");
	await act(async () =>
		input.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Escape",
				code: "Escape",
				bubbles: true,
			})
		)
	);
	expect(document.querySelector('[role="dialog"]')).toBeNull();
	expect(changes).toEqual([]);
	await click("Choose model", "button");
	await click("ModelProof Model A", "option");
	await click("Proof Model B", "option");
	expect(changes).toEqual(["model-b"]);
});
