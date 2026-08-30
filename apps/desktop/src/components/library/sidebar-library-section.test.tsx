import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { GridIcon } from "@hugeicons/core-free-icons";
import { act } from "react";
import { createRoot } from "react-dom/client";
import SidebarLibrarySection from "./SidebarLibrarySection.tsx";

if (typeof document === "undefined") {
	GlobalRegistrator.register();
}

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const item = {
	icon: GridIcon,
	id: "skill-1",
	name: "Research skill",
	onOpen: () => {},
	subtitle: "Installed skill",
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeAll(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	container.remove();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

describe("SidebarLibrarySection", () => {
	test("renders Skills as a book shelf while the default stays a LibraryCard", () => {
		act(() => {
			root.render(
				<SidebarLibrarySection
					icon={GridIcon}
					items={[item]}
					label="Skills"
					query=""
					variant="books"
					view="showcase"
				/>
			);
		});

		expect(container.textContent).toContain(item.name);
		expect(
			container.querySelector('[class*="[container-type:inline-size]"]')
		).not.toBeNull();

		act(() => {
			root.render(
				<SidebarLibrarySection
					icon={GridIcon}
					items={[item]}
					label="Skills"
					query=""
					view="grid"
				/>
			);
		});

		expect(container.textContent).toContain(item.name);
		expect(container.querySelector('[data-slot="card"]')).not.toBeNull();
	});

	test("offers a keyboard-accessible secondary action on skill books", () => {
		const onOpen = mock(() => undefined);
		const onSelect = mock(() => undefined);
		const label = "Use Research skill with agents";
		act(() => {
			root.render(
				<SidebarLibrarySection
					icon={GridIcon}
					items={[
						{
							...item,
							onOpen,
							secondaryAction: { label, onSelect },
						},
					]}
					label="Skills"
					query=""
					variant="books"
					view="grid"
				/>
			);
		});

		const action = container.querySelector<HTMLButtonElement>(
			`button[aria-label="${label}"]`
		);
		expect(action).not.toBeNull();
		if (!action) {
			throw new Error("Missing secondary action");
		}
		action.focus();
		expect(document.activeElement).toBe(action);
		expect(action.className).toContain("focus-visible");
		act(() => action.click());
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onOpen).not.toHaveBeenCalled();
	});

	test("keeps the secondary action available from skill list cards", () => {
		const onSelect = mock(() => undefined);
		const label = "Use Research skill with agents";
		act(() => {
			root.render(
				<SidebarLibrarySection
					icon={GridIcon}
					items={[
						{
							...item,
							secondaryAction: { label, onSelect },
						},
					]}
					label="Skills"
					query=""
					variant="books"
					view="list"
				/>
			);
		});

		const action = container.querySelector<HTMLButtonElement>(
			`button[aria-label="${label}"]`
		);
		expect(action).not.toBeNull();
		if (!action) {
			throw new Error("Missing secondary action");
		}
		act(() => action.click());
		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	test("does not render a secondary action when an item has none", () => {
		act(() => {
			root.render(
				<SidebarLibrarySection
					icon={GridIcon}
					items={[item]}
					label="Skills"
					query=""
					variant="books"
					view="grid"
				/>
			);
		});

		expect(
			container.querySelector(
				'button[aria-label="Use Research skill with agents"]'
			)
		).toBeNull();
	});
});
