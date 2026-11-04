// The Quiz board is a CSS grid that mirrors under dir="rtl", so its arrow keys
// follow the reading direction: ArrowLeft walks toward the inline end.
import "./board-test-dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { MotionGlobalConfig } from "motion/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QuizInterface } from "./quiz-interface.tsx";

type Direction = "ltr" | "rtl";

MotionGlobalConfig.skipAnimations = true;

const BASE = Date.parse("2026-10-12T12:00:00Z");

function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id">
): InterfaceThread {
	return {
		agentIds: [],
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: input.id,
		updatedAt: new Date(BASE - 60 * 60_000).toISOString(),
		...input,
	};
}

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Writes the release notes",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "Triages bugs",
			id: "agent-grace",
			name: "Grace",
			status: "working",
		},
	],
	groups: [
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-ada"],
			name: "Website",
		},
	],
	threads: [
		thread({ agentIds: ["agent-ada"], id: "thread-notes" }),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-question",
			projectId: "project-site",
		}),
		thread({ agentIds: ["agent-grace"], id: "thread-triage" }),
	],
	version: 1,
};

const PORT: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

let mounted: { container: HTMLElement; root: Root } | null = null;

afterEach(async () => {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => root.unmount());
		container.remove();
		mounted = null;
	}
});

async function mountQuiz(direction: Direction): Promise<HTMLElement> {
	const container = document.createElement("div");
	container.setAttribute("dir", direction);
	container.style.direction = direction;
	document.body.append(container);
	const root = createRoot(container);
	await act(async () =>
		root.render(
			<QuizInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={PORT}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		)
	);
	mounted = { container, root };
	return container;
}

function tile(container: HTMLElement, label: string): HTMLElement {
	const found = [...container.querySelectorAll("button")].find((candidate) =>
		candidate.getAttribute("aria-label")?.startsWith(label)
	);
	if (!found) {
		throw new Error(`no tile labelled ${label}`);
	}
	return found;
}

async function press(target: Element, key: string) {
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

const focusedLabel = () => document.activeElement?.getAttribute("aria-label");

describe("quiz board arrow keys under right-to-left", () => {
	test("ArrowRight moves toward the next column in LTR", async () => {
		const container = await mountQuiz("ltr");
		const first = tile(container, "Website for 500");
		await act(async () => first.focus());
		await press(first, "ArrowRight");
		expect(focusedLabel()).toStartWith("Ada for 500");
	});

	test("ArrowLeft moves toward the next column in RTL", async () => {
		const container = await mountQuiz("rtl");
		const first = tile(container, "Website for 500");
		await act(async () => first.focus());
		await press(first, "ArrowRight");
		expect(focusedLabel()).toStartWith("Website for 500");
		await press(first, "ArrowLeft");
		expect(focusedLabel()).toStartWith("Ada for 500");
	});
});
