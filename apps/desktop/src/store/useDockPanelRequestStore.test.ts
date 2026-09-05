import { describe, expect, test } from "bun:test";
import { useDockPanelRequestStore } from "./useDockPanelRequestStore.ts";

describe("dock panel requests", () => {
	test("carries the requested terminal side and one-shot command", () => {
		useDockPanelRequestStore.getState().open("terminal", "Terminal", "right", {
			command: "bun test",
			cwd: "/tmp/project",
			env: { RYU_PROJECT_PATH: "/tmp/project" },
			shell: null,
		});

		expect(useDockPanelRequestStore.getState().pending).toMatchObject({
			command: {
				command: "bun test",
				cwd: "/tmp/project",
				shell: null,
			},
			kind: "terminal",
			label: "Terminal",
			side: "right",
		});

		const firstNonce = useDockPanelRequestStore.getState().pending?.nonce ?? 0;
		useDockPanelRequestStore.getState().clear();
		expect(useDockPanelRequestStore.getState().pending).toBeNull();
		useDockPanelRequestStore.getState().open("terminal", "Terminal", "bottom", {
			command: "bun test",
			cwd: "/tmp/project",
			shell: null,
		});
		expect(useDockPanelRequestStore.getState().pending?.nonce).toBeGreaterThan(
			firstNonce
		);
		useDockPanelRequestStore.getState().clear();
	});
});
