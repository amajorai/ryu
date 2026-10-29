import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

// The tray renders meshes and a drei plate; outside a Canvas keep the plate.
const drei = await import("@react-three/drei");
mock.module("@react-three/drei", () => ({
	...drei,
	Html: ({ children }: { children: ReactNode }) => children,
}));
const fiber = await import("@react-three/fiber");
mock.module("@react-three/fiber", () => ({
	...fiber,
	useFrame: () => undefined,
}));
const materials = await import("./game3d-materials.tsx");
mock.module("./game3d-materials.tsx", () => ({
	...materials,
	ToonMesh: () => null,
}));

GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TrayItem } = await import("./game3d-signs.tsx");
const { FIXTURE_NOW_MS, usefulStateFixture } = await import(
	"@ryuhq/protocol/interfaces-fixture"
);

afterAll(() => {
	GlobalRegistrator.unregister();
});

function tagOf(node: ReactNode): string | null {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => root.render(node));
	const text = container.querySelector("[data-tray-tag]")?.textContent ?? null;
	act(() => root.unmount());
	container.remove();
	return text;
}

describe("tray item tag", () => {
	test("shows its tag on the plate, but not icon-only or without one", () => {
		const ask = usefulStateFixture().asks?.[0];
		if (!ask) {
			throw new Error("the fixture needs an ask");
		}
		const tray = (iconOnly: boolean, tag?: string) => (
			<TrayItem
				ask={ask}
				at={[0, 0, 0]}
				focusable
				iconOnly={iconOnly}
				item={{ shape: "box" }}
				nowMs={FIXTURE_NOW_MS}
				onOpen={() => undefined}
				ownerName="Gu"
				reducedMotion
				tag={tag}
			/>
		);
		expect(tagOf(tray(false, "Edited 3 files"))).toBe("Edited 3 files");
		expect(tagOf(tray(true, "Edited 3 files"))).toBeNull();
		expect(tagOf(tray(false))).toBeNull();
	});
});
