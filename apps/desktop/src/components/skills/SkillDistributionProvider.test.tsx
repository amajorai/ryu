import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type {
	SkillAgentTarget,
	SkillDistributionResult,
	SkillInstallResult,
	SkillTargetsSnapshot,
} from "@/src/lib/api/skills.ts";
import type {
	SkillDistributionFlow,
	SkillDistributionServices,
} from "./SkillDistributionProvider.tsx";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);

const { SkillTargetsRequiredError } = await import("@/src/lib/api/skills.ts");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { SkillDistributionProvider, useSkillDistributionFlow } = await import(
	"./SkillDistributionProvider.tsx"
);

const targets: SkillAgentTarget[] = [
	{
		detected: true,
		featured: true,
		globalSkillsDir: "~/.codex/skills",
		id: "codex",
		name: "Codex",
		projectSkillsDir: ".agents/skills",
		resolvedGlobalPath: "/Users/demo/.codex/skills",
		selectable: true,
		unavailableReason: null,
	},
	{
		detected: false,
		featured: true,
		globalSkillsDir: "~/.cursor/skills",
		id: "cursor",
		name: "Cursor",
		projectSkillsDir: ".agents/skills",
		resolvedGlobalPath: "/Users/demo/.cursor/skills",
		selectable: true,
		unavailableReason: null,
	},
];

const snapshot: SkillTargetsSnapshot = {
	droppedTargetIds: [],
	preferences: { configured: false, targetIds: [], version: 1 },
	targets,
	warning: null,
};

function distribution(
	overrides: SkillDistributionResult["targets"] = []
): SkillDistributionResult {
	return { skillId: "demo", targets: overrides };
}

function successfulInstall(
	result: SkillDistributionResult | null = distribution()
): SkillInstallResult {
	return { distribution: result, path: "/skills/demo/SKILL.md", slug: "demo" };
}

function Harness({
	onFlow,
}: {
	onFlow: (flow: SkillDistributionFlow) => void;
}) {
	const flow = useSkillDistributionFlow();
	useEffect(() => onFlow(flow), [flow, onFlow]);
	return null;
}

function role(name: string): HTMLElement {
	const found = Array.from(
		document.querySelectorAll<HTMLElement>('[role="checkbox"]')
	).find((element) => element.getAttribute("aria-label") === name);
	if (!found) {
		throw new Error(`Missing checkbox ${name}`);
	}
	return found;
}

function button(name: string): HTMLButtonElement {
	const found = Array.from(document.querySelectorAll("button")).find(
		(element) => element.textContent?.trim() === name
	);
	if (!found) {
		throw new Error(`Missing button ${name}`);
	}
	return found;
}

async function click(element: Element) {
	await act(async () => {
		element.dispatchEvent(
			new PointerEvent("pointerdown", { bubbles: true, button: 0 })
		);
		element.dispatchEvent(
			new PointerEvent("pointerup", { bubbles: true, button: 0 })
		);
		element.dispatchEvent(
			new MouseEvent("click", { bubbles: true, button: 0 })
		);
		await Promise.resolve();
	});
}

async function choose(name: string) {
	const input = role(name).nextElementSibling;
	if (!(input instanceof HTMLInputElement)) {
		throw new Error(`Missing native checkbox ${name}`);
	}
	await act(async () => {
		input.click();
		await Promise.resolve();
	});
}

async function waitForDialog() {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (document.querySelector('[role="dialog"]')) {
			return;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
	throw new Error(`Dialog did not open: ${document.body.innerHTML}`);
}

async function start<T>(
	action: () => Promise<T>
): Promise<{ promise: Promise<T> }> {
	let promise: Promise<T> | undefined;
	await act(async () => {
		promise = action();
		await Promise.resolve();
		await Promise.resolve();
	});
	if (!promise) {
		throw new Error("Action did not start");
	}
	return { promise };
}

describe("SkillDistributionProvider", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let flow: SkillDistributionFlow;
	let install: ReturnType<typeof mock<SkillDistributionServices["install"]>>;
	let fetchTargets: ReturnType<
		typeof mock<SkillDistributionServices["fetchTargets"]>
	>;
	let distribute: ReturnType<
		typeof mock<SkillDistributionServices["distribute"]>
	>;

	beforeEach(async () => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		useNodeStore.setState({
			defaultNode: "local",
			nodes: [{ name: "local", url: "http://node-a", token: "a" }],
		});
		install = mock(async () => successfulInstall());
		fetchTargets = mock(async () => snapshot);
		distribute = mock(async () => distribution());
		const services = { install, fetchTargets, distribute };
		await act(async () => {
			root.render(
				<SkillDistributionProvider services={services}>
					<Harness
						onFlow={(value) => {
							flow = value;
						}}
					/>
				</SkillDistributionProvider>
			);
		});
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		document.body.replaceChildren();
	});

	it("retries a first install after target selection", async () => {
		install
			.mockRejectedValueOnce(new SkillTargetsRequiredError())
			.mockResolvedValueOnce(successfulInstall());

		const { promise } = await start(() =>
			flow.installCatalogSkill({ id: "demo" })
		);
		await waitForDialog();
		await choose("Codex");
		await choose("Cursor");
		await choose("Remember for future skill installs");
		await click(button("Install"));
		await expect(promise).resolves.toEqual(successfulInstall());

		expect(install).toHaveBeenCalledTimes(2);
		expect(install).toHaveBeenLastCalledWith(
			expect.anything(),
			{ id: "demo" },
			{
				promptForTargets: true,
				targetIds: ["codex", "cursor"],
				rememberTargetIds: true,
			}
		);
	});

	it("uses configured Core defaults without fetching targets or opening", async () => {
		install.mockResolvedValueOnce(successfulInstall(null));
		await expect(
			flow.installCatalogSkill({ id: "remembered", source: "private" })
		).resolves.toEqual(successfulInstall(null));
		expect(install).toHaveBeenCalledWith(
			expect.anything(),
			{ id: "remembered", source: "private" },
			{ promptForTargets: true }
		);
		expect(fetchTargets).not.toHaveBeenCalled();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it("cancel resolves null and performs no retry", async () => {
		install.mockRejectedValueOnce(new SkillTargetsRequiredError());
		const { promise } = await start(() =>
			flow.installCatalogSkill({ id: "demo" })
		);
		await waitForDialog();
		await click(button("Cancel"));
		await expect(promise).resolves.toBeNull();
		expect(install).toHaveBeenCalledTimes(1);
	});

	it("manual distribution always opens and accepts an empty one-time choice", async () => {
		fetchTargets.mockResolvedValueOnce({
			...snapshot,
			preferences: { configured: true, targetIds: ["codex"], version: 1 },
		});
		const { promise } = await start(() =>
			flow.distributeInstalledSkill("demo")
		);
		await waitForDialog();
		expect(
			role("Remember for future skill installs").getAttribute("aria-checked")
		).toBe("true");
		await choose("Codex");
		await choose("Remember for future skill installs");
		await click(button("Export"));
		await expect(promise).resolves.toEqual(distribution());
		expect(distribute).toHaveBeenCalledWith(expect.anything(), "demo", {
			remember: false,
			targetIds: [],
		});
		expect(document.body.textContent).toContain(
			"No agents selected. This skill remains available in Ryu only."
		);
	});

	it("opens a configured-empty saved preference with remember checked", async () => {
		fetchTargets.mockResolvedValueOnce({
			...snapshot,
			preferences: { configured: true, targetIds: [], version: 1 },
		});
		const { promise } = await start(() =>
			flow.distributeInstalledSkill("demo")
		);
		await waitForDialog();
		expect(
			role("Remember for future skill installs").getAttribute("aria-checked")
		).toBe("true");
		expect(role("Codex").getAttribute("aria-checked")).toBe("false");
		await click(button("Cancel"));
		await expect(promise).resolves.toBeNull();
	});

	it("announces exact partial success and conflict messages", async () => {
		distribute.mockResolvedValueOnce(
			distribution([
				{
					message: null,
					path: "/codex/demo",
					status: "copied",
					targetId: "codex",
				},
				{
					message: "different bytes",
					path: "/cursor/demo",
					status: "conflict",
					targetId: "cursor",
				},
			])
		);
		const { promise } = await start(() =>
			flow.distributeInstalledSkill("demo")
		);
		await waitForDialog();
		await choose("Codex");
		await choose("Cursor");
		await click(button("Export"));
		await promise;
		expect(document.body.textContent).toContain(
			"Installed in Ryu. Added to 1 agent."
		);
		expect(document.body.textContent).toContain(
			"Cursor has a different copy. Ryu left it unchanged."
		);
	});

	it("reads the active node independently for each dialog open", async () => {
		const { promise: first } = await start(() =>
			flow.distributeInstalledSkill("one")
		);
		await waitForDialog();
		await click(button("Cancel"));
		await first;
		useNodeStore.setState({
			defaultNode: "other",
			nodes: [{ name: "other", url: "http://node-b", token: "b" }],
		});
		const { promise: second } = await start(() =>
			flow.distributeInstalledSkill("two")
		);
		await waitForDialog();
		await click(button("Cancel"));
		await second;
		expect(fetchTargets.mock.calls.map((call) => call[0].url)).toEqual([
			"http://node-a",
			"http://node-b",
		]);
	});

	it("does not let a second open replace the pending selection", async () => {
		const { promise: first } = await start(() =>
			flow.distributeInstalledSkill("one")
		);
		await waitForDialog();
		await expect(flow.distributeInstalledSkill("two")).rejects.toThrow(
			"A skill target selection is already open."
		);
		await click(button("Cancel"));
		await expect(first).resolves.toBeNull();
		expect(fetchTargets).toHaveBeenCalledTimes(1);
	});

	it("keeps an explicit target through precondition, dialog, and retry", async () => {
		install
			.mockRejectedValueOnce(new SkillTargetsRequiredError())
			.mockResolvedValueOnce(successfulInstall());
		const explicitTarget = { url: "http://hinted-node", token: "hint" };
		const { promise } = await start(() =>
			flow.installCatalogSkill({
				id: "demo",
				source: "private",
				target: explicitTarget,
			})
		);
		await waitForDialog();
		useNodeStore.setState({
			defaultNode: "other",
			nodes: [{ name: "other", url: "http://node-b", token: "b" }],
		});
		await choose("Codex");
		await click(button("Install"));
		await promise;

		expect(fetchTargets).toHaveBeenCalledWith(explicitTarget);
		expect(install.mock.calls.map((call) => call[0])).toEqual([
			explicitTarget,
			explicitTarget,
		]);
		expect(install).toHaveBeenLastCalledWith(
			explicitTarget,
			{ id: "demo", source: "private" },
			{
				promptForTargets: true,
				rememberTargetIds: false,
				targetIds: ["codex"],
			}
		);
	});

	it("resolves a pending open as cancelled when the provider unmounts", async () => {
		fetchTargets.mockImplementationOnce(
			() => new Promise<SkillTargetsSnapshot>(() => undefined)
		);
		const { promise } = await start(() =>
			flow.distributeInstalledSkill("demo")
		);
		await act(async () => root.unmount());
		const outcome = await Promise.race([
			promise,
			new Promise<"timed-out">((resolve) =>
				setTimeout(() => resolve("timed-out"), 20)
			),
		]);
		expect(outcome).toBeNull();
	});

	it("absorbs a late target-fetch rejection after unmount", async () => {
		let rejectFetch: ((error: Error) => void) | undefined;
		fetchTargets.mockImplementationOnce(
			() =>
				new Promise<SkillTargetsSnapshot>((_resolve, reject) => {
					rejectFetch = reject;
				})
		);
		const { promise } = await start(() =>
			flow.distributeInstalledSkill("demo")
		);
		await act(async () => root.unmount());
		await expect(promise).resolves.toBeNull();
		rejectFetch?.(new Error("late target failure"));
		await Promise.resolve();
		await Promise.resolve();
		expect(fetchTargets).toHaveBeenCalledTimes(1);
	});
});
