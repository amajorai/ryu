import { beforeEach, describe, expect, test } from "bun:test";
import { useInterfaceActive } from "./use-interface-active.ts";

describe("useInterfaceActive", () => {
	beforeEach(() => {
		useInterfaceActive.setState({ active: false, previewLatched: false });
	});

	test("latches previews the first time an interface is active, for the session", () => {
		const { setActive } = useInterfaceActive.getState();
		expect(useInterfaceActive.getState().previewLatched).toBe(false);
		setActive(true);
		expect(useInterfaceActive.getState()).toMatchObject({
			active: true,
			previewLatched: true,
		});
		setActive(false);
		expect(useInterfaceActive.getState()).toMatchObject({
			active: false,
			previewLatched: true,
		});
	});

	test("repeating a value keeps the same state object", () => {
		const before = useInterfaceActive.getState();
		before.setActive(false);
		expect(useInterfaceActive.getState()).toBe(before);
	});
});
