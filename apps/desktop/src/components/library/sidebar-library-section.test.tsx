import { afterEach, beforeAll, describe, expect, test } from "bun:test";
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
});
