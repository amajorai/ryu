import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SkillAgentTarget } from "@/src/lib/api/skills.ts";
import type { SkillTargetChoice } from "./SkillTargetDialog.tsx";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);

const { orderSkillTargets, SkillTargetDialog } = await import(
	"./SkillTargetDialog.tsx"
);

function target(
	id: string,
	name: string,
	overrides: Partial<SkillAgentTarget> = {}
): SkillAgentTarget {
	return {
		detected: false,
		featured: false,
		globalSkillsDir: `~/.${id}/skills`,
		id,
		name,
		projectSkillsDir: ".agents/skills",
		resolvedGlobalPath: `/Users/demo/.${id}/skills`,
		selectable: true,
		unavailableReason: null,
		...overrides,
	};
}

const targets = [
	target("open-code", "OpenCode"),
	target("cursor", "Cursor", { featured: true }),
	target("codex", "Codex", { detected: true, featured: true }),
	target("claude-code", "Claude Code", { featured: true }),
	target("project-agent", "Project Agent", {
		globalSkillsDir: null,
		resolvedGlobalPath: null,
		selectable: false,
		unavailableReason: "project-only target has no global skills directory",
	}),
];

function byRole(role: string, name?: string): HTMLElement {
	const elements = Array.from(
		document.querySelectorAll<HTMLElement>(`[role="${role}"]`)
	);
	const found = name
		? elements.find((element) => element.getAttribute("aria-label") === name)
		: elements[0];
	if (!found) {
		throw new Error(`Missing ${role}${name ? ` named ${name}` : ""}`);
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
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function clickCheckbox(name: string) {
	const checkbox = byRole("checkbox", name);
	const input = checkbox.nextElementSibling;
	if (!(input instanceof HTMLInputElement)) {
		throw new Error(`Missing native input for ${name}`);
	}
	await act(async () => {
		input.click();
		await Promise.resolve();
	});
}

describe("SkillTargetDialog", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		document.body.replaceChildren();
	});

	it("orders detected agents first and deduplicates featured targets", () => {
		const duplicateCodex = target("codex", "Codex duplicate", {
			featured: true,
		});
		expect(
			orderSkillTargets([...targets, duplicateCodex]).map((item) => item.id)
		).toEqual(["codex", "claude-code", "cursor", "open-code", "project-agent"]);
	});

	it("opens after being mounted closed", async () => {
		const props = {
			actionLabel: "Install" as const,
			initialChoice: { remember: false, targetIds: [] },
			onCancel: () => undefined,
			onConfirm: () => undefined,
			targets,
		};
		await act(async () =>
			root.render(<SkillTargetDialog {...props} open={false} />)
		);
		await act(async () => root.render(<SkillTargetDialog {...props} open />));
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
	});

	it("keeps detected agents first and reveals the full searchable list", async () => {
		await act(async () => {
			root.render(
				<SkillTargetDialog
					actionLabel="Install"
					initialChoice={{ remember: false, targetIds: [] }}
					onCancel={() => undefined}
					onConfirm={() => undefined}
					open
					targets={targets}
				/>
			);
		});

		const checkboxes = Array.from(
			document.querySelectorAll<HTMLElement>('[role="checkbox"]')
		);
		expect(checkboxes[0]?.getAttribute("aria-label")).toBe("Codex");
		expect(document.body.textContent).not.toContain("OpenCode");

		await click(button("Show all supported agents"));
		const search = byRole(
			"searchbox",
			"Search supported agents"
		) as HTMLInputElement;
		await act(async () => {
			const valueSetter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value"
			)?.set;
			valueSetter?.call(search, "open code");
			search.dispatchEvent(new InputEvent("input", { bubbles: true }));
			search.dispatchEvent(new Event("change", { bubbles: true }));
			await Promise.resolve();
		});
		expect(byRole("checkbox", "OpenCode")).toBeTruthy();
		expect(document.body.textContent).not.toContain("Claude Code");
	});

	it("shows project-only targets disabled in the full list", async () => {
		await act(async () => {
			root.render(
				<SkillTargetDialog
					actionLabel="Export"
					initialChoice={{ remember: false, targetIds: [] }}
					onCancel={() => undefined}
					onConfirm={() => undefined}
					open
					targets={targets}
				/>
			);
		});
		await click(button("Show all supported agents"));
		const checkbox = byRole("checkbox", "Project Agent");
		expect(checkbox.getAttribute("aria-disabled")).toBe("true");
		expect(document.body.textContent).toContain("Project-only target");
	});

	it("confirms an empty one-time selection and keeps remember unchecked", async () => {
		const choices: SkillTargetChoice[] = [];
		await act(async () => {
			root.render(
				<SkillTargetDialog
					actionLabel="Install"
					initialChoice={{ remember: false, targetIds: [] }}
					onCancel={() => undefined}
					onConfirm={(value) => {
						choices.push(value);
					}}
					open
					targets={targets}
				/>
			);
		});
		expect(
			byRole("checkbox", "Remember for future skill installs").getAttribute(
				"aria-checked"
			)
		).toBe("false");
		await click(button("Install"));
		expect(choices).toEqual([{ remember: false, targetIds: [] }]);
	});

	it("returns selected ids and remember state, while cancel stays separate", async () => {
		const choices: SkillTargetChoice[] = [];
		let cancelCount = 0;
		await act(async () => {
			root.render(
				<SkillTargetDialog
					actionLabel="Export"
					initialChoice={{ remember: false, targetIds: [] }}
					onCancel={() => {
						cancelCount += 1;
					}}
					onConfirm={(value) => {
						choices.push(value);
					}}
					open
					targets={targets}
				/>
			);
		});
		await clickCheckbox("Codex");
		await clickCheckbox("Remember for future skill installs");
		await click(button("Export"));
		expect(choices).toEqual([{ remember: true, targetIds: ["codex"] }]);
		await click(button("Cancel"));
		expect(cancelCount).toBe(1);
	});
});
