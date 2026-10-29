import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const nativeMatchMedia = window.matchMedia.bind(window);
Reflect.set(window, "matchMedia", (query: string) => {
	const result = nativeMatchMedia(query);
	if (query.includes("prefers-reduced-motion")) {
		Reflect.set(result, "matches", true);
	}
	return result;
});

const { ProjectFolder } = await import("@ryu/ui/components/project-folder.tsx");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function flushEffects(): Promise<void> {
	await act(async () => {
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	});
}

async function waitForCondition(condition: () => boolean): Promise<boolean> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (condition()) {
			return true;
		}
		await act(async () => {
			await new Promise<void>((resolve) => window.setTimeout(resolve, 5));
		});
	}
	return condition();
}

function requiredElement<ElementType extends Element>(
	selector: string,
	parent: ParentNode = document
): ElementType {
	const element = parent.querySelector<ElementType>(selector);
	if (!element) {
		throw new Error(`Missing test element: ${selector}`);
	}
	return element;
}

function requiredButtonWithText(text: string): HTMLButtonElement {
	for (const button of document.querySelectorAll<HTMLButtonElement>("button")) {
		if (button.textContent?.includes(text)) {
			return button;
		}
	}
	throw new Error(`Missing test button: ${text}`);
}

beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	document.body.replaceChildren();
});

describe("ProjectFolder interactions", () => {
	test("fanned rich previews are siblings of the folder button and primary navigation preserves destination focus", async () => {
		const destination = document.createElement("button");
		destination.textContent = "Destination editor";
		document.body.append(destination);
		let openedPath = "";

		act(() => {
			root.render(
				<ProjectFolder
					defaultOpen
					previews={[
						{
							content: (
								<article>
									<a href="https://example.com">Rich preview link</a>
								</article>
							),
							id: "page-1",
							label: "Open page",
							onClick: () => {
								openedPath = "/spaces/space-1/doc/page-1";
								destination.focus();
							},
						},
					]}
					title="Research"
				/>
			);
		});

		const folderButton = requiredElement<HTMLButtonElement>(
			'button[aria-haspopup="dialog"]',
			container
		);
		const fanLink = requiredElement<HTMLAnchorElement>("a", container);
		expect(fanLink.closest("[inert]")).not.toBeNull();
		expect(container.querySelector("button a[href]")).toBeNull();
		act(() => folderButton.click());
		await flushEffects();

		const dialog = requiredElement<HTMLElement>('[role="dialog"]');
		const activationButton = requiredElement<HTMLButtonElement>(
			'button[aria-label="Open page"]',
			dialog
		);
		expect(activationButton.querySelector("a")).toBeNull();
		const previewLink = requiredElement<HTMLAnchorElement>("a", dialog);
		expect(previewLink.closest("[inert]")).not.toBeNull();

		act(() => activationButton.click());
		const overlayClosed = await waitForCondition(
			() => document.querySelector('[role="dialog"]') === null
		);

		expect(openedPath).toBe("/spaces/space-1/doc/page-1");
		expect(overlayClosed).toBeTrue();
		expect(document.activeElement === destination).toBeTrue();
	});

	test("Escape and the close button restore focus to the folder", async () => {
		act(() => {
			root.render(
				<ProjectFolder
					previews={[{ content: <span>Preview</span>, id: "preview" }]}
					title="Research"
				/>
			);
		});

		const folderButton = requiredElement<HTMLButtonElement>(
			'button[aria-haspopup="dialog"]',
			container
		);
		act(() => folderButton.click());
		await flushEffects();
		act(() =>
			document.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			)
		);
		expect(
			await waitForCondition(() => document.activeElement === folderButton)
		).toBeTrue();

		act(() => folderButton.click());
		await flushEffects();
		const closeButton = requiredElement<HTMLButtonElement>(
			'button[aria-label="Close folder"]'
		);
		act(() => closeButton.click());
		expect(
			await waitForCondition(() => document.activeElement === folderButton)
		).toBeTrue();
	});

	test("empty-state primary actions can close before navigating", async () => {
		const destination = document.createElement("button");
		document.body.append(destination);
		let created = false;

		act(() => {
			root.render(
				<ProjectFolder
					emptyContent={(closeBeforeNavigation) => (
						<button
							onClick={() => {
								closeBeforeNavigation();
								created = true;
								destination.focus();
							}}
							type="button"
						>
							Create page
						</button>
					)}
					previews={[]}
					title="Empty Space"
				/>
			);
		});

		const folderButton = requiredElement<HTMLButtonElement>(
			'button[aria-haspopup="dialog"]',
			container
		);
		act(() => folderButton.click());
		await flushEffects();
		act(() => requiredButtonWithText("Create page").click());
		const overlayClosed = await waitForCondition(
			() => document.querySelector('[role="dialog"]') === null
		);

		expect(created).toBeTrue();
		expect(overlayClosed).toBeTrue();
		expect(document.activeElement === destination).toBeTrue();
	});

	test("callback and inner-action preview roots are both keyed", async () => {
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (...values: unknown[]) => {
			errors.push(values.map(String).join(" "));
		};

		try {
			act(() => {
				root.render(
					<ProjectFolder
						defaultExpanded
						previews={[
							{
								content: <span>Primary action</span>,
								id: "primary",
								onClick: () => undefined,
							},
							{
								content: <button type="button">Inner action</button>,
								id: "inner",
							},
						]}
						title="Mixed previews"
					/>
				);
			});
			await flushEffects();
		} finally {
			console.error = originalError;
		}

		expect(
			errors.some((message) => message.includes('unique "key" prop'))
		).toBeFalse();
		expect(
			requiredElement('[role="dialog"]').querySelector("button button")
		).toBeNull();
	});
});
