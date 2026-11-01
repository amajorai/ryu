import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	CloudTaskBackendId,
	CloudTaskBackendsView,
	PlanAccountView,
} from "@/src/lib/api/cloud-task-backends.ts";
import type { CloudTaskBackendChoice } from "@/src/lib/cloud-task-backend-choice.ts";

// "Run on" for a new Claude Code or Codex cloud task: which plan options it
// lists, the "Runs as" mode for a pin, and when it warns that a personal plan
// could run from a datacenter IP. The flag hook and the two node fetches are
// replaced; the choice store and the node store are real.

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let flagOn = true;
mock.module("@/src/hooks/useFeatureFlag.ts", () => ({
	useFeatureFlag: () => flagOn,
}));
let offered: CloudTaskBackendId[] = [];
let accounts: PlanAccountView[] | null = null;
const realBackends = await import("@/src/lib/api/cloud-task-backends.ts");
mock.module("@/src/lib/api/cloud-task-backends.ts", () => ({
	...realBackends,
	fetchCloudTaskBackends: () =>
		Promise.resolve({
			backends: offered.map((backend) => ({ backend })),
			owner: true,
			rollout: true,
			settings: { enabled: true },
		} as unknown as CloudTaskBackendsView),
	fetchPlanAccounts: () => Promise.resolve(accounts),
}));
const { createRoot } = await import("react-dom/client");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { useCloudTaskBackendChoices } = await import(
	"@/src/lib/cloud-task-backend-choice.ts"
);
const { CloudTaskBackendChooser } = await import(
	"./CloudTaskBackendChooser.tsx"
);

const SCOPE = "chooser-scope";
const target: ApiTarget = {
	url: "https://chooser.fixture",
	token: "node-token",
	userJwt: "user-jwt",
};
const originalNodes = useNodeStore.getState().nodes;
const roots: Root[] = [];

beforeEach(() => {
	flagOn = true;
	offered = [
		"ryu-box",
		"anthropic-subscription-cli",
		"anthropic-subscription-sdk",
		"openai-subscription-cli",
	];
	accounts = [];
	useCloudTaskBackendChoices.setState({ choices: {} });
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	useNodeStore.setState({ nodes: originalNodes });
	useCloudTaskBackendChoices.setState({ choices: {} });
});

function choose(choice: CloudTaskBackendChoice) {
	useCloudTaskBackendChoices.getState().setChoice(SCOPE, choice);
}

async function renderChooser(executor = "claude-code") {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () =>
		root.render(
			<CloudTaskBackendChooser
				executor={executor}
				scope={SCOPE}
				target={target}
			/>
		)
	);
	await act(async () => {
		await Bun.sleep(20);
	});
	return container;
}

const warning = (container: HTMLElement) =>
	container.querySelector("[data-testid='datacenter-plan-warning']");

test("lists the agent's plan options and labels cloud runs", async () => {
	const container = await renderChooser();
	const labels = [...container.querySelectorAll("option")].map(
		(option) => option.textContent
	);
	expect(labels).toEqual([
		"Run on: Auto",
		"Run on: Your Claude plan (Claude cloud), then Ryu Box (agent in the cloud)",
		"Run on: Your Claude plan (Claude cloud) only",
		"Run on: Your Claude plan (on this computer), then Ryu Box (agent in the cloud)",
		"Run on: Your Claude plan (on this computer) only",
		"Run on: Ryu Box (agent in the cloud)",
	]);
});

test("splits a plan backend per linked account", async () => {
	offered = ["anthropic-subscription-cli"];
	accounts = [
		{ id: "work", label: "work", provider: "anthropic" },
		{ id: "home", label: "home", provider: "anthropic" },
		{ id: "gpt", label: "gpt", provider: "openai" },
	] as PlanAccountView[];
	const container = await renderChooser();
	const values = [...container.querySelectorAll("option")].map(
		(option) => option.value
	);
	expect(values).toEqual([
		"auto",
		"anthropic-subscription-cli|work",
		"anthropic-subscription-cli|work|strict",
		"anthropic-subscription-cli|home",
		"anthropic-subscription-cli|home|strict",
		"ryu-box",
	]);
});

test("Auto with Claude Code warns of a datacenter plan and names no mode", async () => {
	const container = await renderChooser();
	expect(warning(container)).not.toBeNull();
	expect(container.textContent).not.toContain("Runs as:");
});

test("Auto with an agent that never uses a plan does not warn", async () => {
	offered = ["ryu-box"];
	const container = await renderChooser("ryu");
	// No plan option for this agent, so there is nothing to choose.
	expect(container.querySelector("select")).toBeNull();
	expect(warning(container)).toBeNull();
});

test("a strict Claude cloud pin runs in the cloud without a warning", async () => {
	choose({
		kind: "pinned",
		backend: "anthropic-subscription-cli",
		strict: true,
		accountId: "default",
	});
	const container = await renderChooser();
	expect(container.querySelector("select")?.value).toBe(
		"anthropic-subscription-cli|default|strict"
	);
	expect(container.textContent).toContain("Runs as: Agent in the cloud");
	expect(warning(container)).toBeNull();
});

test("a non-strict Claude cloud pin warns of the Ryu Box fallback", async () => {
	choose({
		kind: "pinned",
		backend: "anthropic-subscription-cli",
		strict: false,
		accountId: "default",
	});
	const container = await renderChooser();
	expect(warning(container)).not.toBeNull();
});

test("a strict on-this-computer pin warns only on a managed node", async () => {
	choose({
		kind: "pinned",
		backend: "anthropic-subscription-sdk",
		strict: true,
		accountId: "default",
	});
	const own = await renderChooser();
	expect(own.textContent).toContain("Runs as: On this node, no sandbox");
	expect(warning(own)).toBeNull();

	await act(async () => {
		useNodeStore.setState({
			nodes: [
				{
					managed: true,
					name: "cloud",
					token: "node-token",
					url: `${target.url}/`,
				},
			],
		});
	});
	// The mounted chooser follows the node store too.
	expect(warning(own)).not.toBeNull();
	const managed = await renderChooser();
	expect(warning(managed)).not.toBeNull();
});

test("a Ryu Box pin with Claude Code warns of a datacenter plan", async () => {
	choose({ kind: "pinned", backend: "ryu-box", strict: true });
	const container = await renderChooser();
	expect(container.textContent).toContain("Runs as: Agent in the cloud");
	expect(warning(container)).not.toBeNull();
});

test("renders nothing when the flag is off or no plan option fits", async () => {
	flagOn = false;
	expect((await renderChooser()).childElementCount).toBe(0);
	flagOn = true;
	offered = ["ryu-box", "openai-subscription-cli"];
	expect((await renderChooser("claude-code")).childElementCount).toBe(0);
});
