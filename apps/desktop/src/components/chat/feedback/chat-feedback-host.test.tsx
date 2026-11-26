import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { FeedbackActions } from "@ryu/blocks/desktop/agent-elements/feedback-host-context.tsx";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

// The shell is not running in a unit test: the app version and the browser
// hand-off are injected through `ChatFeedbackDeps` below instead.
mock.module("@tauri-apps/api/app", () => ({
	getVersion: () => Promise.resolve("0.0.0-test"),
}));

const { ChatFeedbackHost, createChatFeedbackActions } = await import(
	"./chat-feedback-host.tsx"
);
const { useFeedbackHost } = await import(
	"@ryu/blocks/desktop/agent-elements/feedback-host-context.tsx"
);

type Deps = NonNullable<Parameters<typeof createChatFeedbackActions>[1]>;
type Sources = ReturnType<Parameters<typeof createChatFeedbackActions>[0]>;

const TARGET = {
	token: "node-token",
	url: "http://127.0.0.1:7980",
} as ApiTarget;

function sources(overrides: Partial<Sources> = {}): Sources {
	return {
		agentId: "claude-code",
		model: "claude-sonnet-4-5",
		readMessages: () => [
			{
				parts: [
					{
						errorText: "cannot open /Users/maria/acme/.env",
						state: "output-error",
						type: "tool-Bash",
					},
				],
			},
		],
		target: TARGET,
		...overrides,
	};
}

function deps(overrides: Partial<Deps> = {}) {
	const calls = {
		clipboard: [] as string[],
		opened: 0,
		versionTargets: [] as ApiTarget[],
	};
	const value: Deps = {
		appVersion: () => Promise.resolve("0.5.2"),
		locale: () => "en",
		openBoard: () => {
			calls.opened += 1;
			return Promise.resolve();
		},
		versionInfo: (target) => {
			calls.versionTargets.push(target);
			return Promise.resolve({
				components: [
					{ name: "ryu-gateway", version: "0.5.1" },
					{ name: "llama.cpp", version: "b4000" },
				],
				platform: "windows-x86_64",
				ryu_version: "0.5.3",
			});
		},
		writeClipboard: (text) => {
			calls.clipboard.push(text);
			return Promise.resolve();
		},
		...overrides,
	};
	return { calls, value };
}

function lines(attachments: { label: string; value: string }[]) {
	return attachments.map((line) => `${line.label}: ${line.value}`);
}

const SUBMISSION = {
	attachments: [],
	draft: {
		actual: null,
		body: "Body",
		expected: null,
		kind: "idea" as const,
		steps: null,
		title: "Title",
	},
	report: "[Idea] Title\n\nBody",
};

describe("chat feedback host, attachments", () => {
	test("a bug gets versions, system, agent, model and redacted errors", async () => {
		const { calls, value } = deps();
		const actions = createChatFeedbackActions(() => sources(), value);
		expect(lines(await actions.collectAttachments("bug"))).toEqual([
			"Surface: Desktop",
			"App version: 0.5.2",
			"Core version: 0.5.3",
			"Gateway version: 0.5.1",
			"System: windows-x86_64",
			"Language: en",
			"Agent: claude-code",
			"Model: claude-sonnet-4-5",
			"Recent error 1: Bash: cannot open ~/acme/.env",
		]);
		expect(calls.versionTargets).toEqual([TARGET]);
		// Collecting reads; it never copies or opens anything.
		expect(calls.clipboard).toEqual([]);
		expect(calls.opened).toBe(0);
	});

	test("an idea carries no errors", async () => {
		const { value } = deps();
		const actions = createChatFeedbackActions(() => sources(), value);
		const idea = await actions.collectAttachments("idea");
		expect(idea.some((line) => line.group === "error")).toBe(false);
	});

	test("an unreachable Core or shell leaves lines out instead of failing", async () => {
		const { value } = deps({
			appVersion: () => Promise.reject(new Error("no shell")),
			versionInfo: () => Promise.reject(new Error("Core is down")),
		});
		const actions = createChatFeedbackActions(
			() => sources({ agentId: null, model: null, readMessages: () => [] }),
			value
		);
		expect(lines(await actions.collectAttachments("bug"))).toEqual([
			"Surface: Desktop",
			"Language: en",
		]);
	});

	test("reads the chat's current values on every call", async () => {
		const { value } = deps();
		let current = sources({ model: "first-model" });
		const actions = createChatFeedbackActions(() => current, value);
		expect(lines(await actions.collectAttachments("idea"))).toContain(
			"Model: first-model"
		);
		current = sources({ model: "second-model" });
		expect(lines(await actions.collectAttachments("idea"))).toContain(
			"Model: second-model"
		);
	});
});

describe("chat feedback host, sending", () => {
	test("copies the approved report, then opens the board", async () => {
		const { calls, value } = deps();
		const actions = createChatFeedbackActions(() => sources(), value);
		expect(await actions.submitFeedback(SUBMISSION)).toEqual({
			destinationOpened: true,
			status: "copied",
		});
		expect(calls.clipboard).toEqual(["[Idea] Title\n\nBody"]);
		expect(calls.opened).toBe(1);
	});

	test("a failed copy rejects and never opens the board", async () => {
		const { calls, value } = deps({
			writeClipboard: () => Promise.reject(new Error("denied")),
		});
		const actions = createChatFeedbackActions(() => sources(), value);
		await expect(actions.submitFeedback(SUBMISSION)).rejects.toThrow("denied");
		expect(calls.opened).toBe(0);
	});

	test("a board that will not open still counts as copied", async () => {
		const { calls, value } = deps({
			openBoard: () => Promise.reject(new Error("no browser")),
		});
		const actions = createChatFeedbackActions(() => sources(), value);
		expect(await actions.submitFeedback(SUBMISSION)).toEqual({
			destinationOpened: false,
			status: "copied",
		});
		expect(calls.clipboard).toHaveLength(1);
	});

	test("opening the destination again only opens the board", async () => {
		const { calls, value } = deps();
		const actions = createChatFeedbackActions(() => sources(), value);
		await actions.openDestination();
		expect(calls.opened).toBe(1);
		expect(calls.clipboard).toEqual([]);
	});
});

describe("chat feedback host, provider", () => {
	test("gives the cards one stable host across renders", async () => {
		const seen: (FeedbackActions | null)[] = [];
		function Probe() {
			seen.push(useFeedbackHost());
			return null;
		}
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const render = (model: string) =>
			act(async () =>
				root.render(
					<ChatFeedbackHost
						agentId="claude-code"
						model={model}
						readMessages={() => []}
						target={TARGET}
					>
						<Probe />
					</ChatFeedbackHost>
				)
			);
		await render("first-model");
		await render("second-model");
		await act(async () => root.unmount());
		container.remove();
		expect(seen.length).toBeGreaterThanOrEqual(2);
		expect(seen[0]).not.toBeNull();
		expect(seen.every((value) => value === seen[0])).toBe(true);
	});
});
