import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
	FeedbackActions,
	FeedbackSubmission,
} from "../feedback-host-context.tsx";
import type { FeedbackAttachment } from "./feedback-tool.ts";

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

const { FeedbackTool } = await import("./feedback-tool.tsx");
const { FeedbackHostContext } = await import("../feedback-host-context.tsx");

const ENVIRONMENT: FeedbackAttachment[] = [
	{
		group: "environment",
		id: "appVersion",
		label: "App version",
		value: "0.5.2",
	},
	{ group: "environment", id: "model", label: "Model", value: "sonnet" },
];
const ERROR_LINE: FeedbackAttachment = {
	group: "error",
	id: "error-1",
	label: "Recent error 1",
	value: "Bash: failed in ~/project",
};

interface Calls {
	collected: string[];
	opened: number;
	submitted: FeedbackSubmission[];
}

function host(overrides: Partial<FeedbackActions> = {}) {
	const calls: Calls = { collected: [], opened: 0, submitted: [] };
	const actions: FeedbackActions = {
		collectAttachments: (kind) => {
			calls.collected.push(kind);
			return Promise.resolve(
				kind === "bug" ? [...ENVIRONMENT, ERROR_LINE] : ENVIRONMENT
			);
		},
		openDestination: () => {
			calls.opened += 1;
			return Promise.resolve();
		},
		submitFeedback: (submission) => {
			calls.submitted.push(submission);
			return Promise.resolve({ destinationOpened: true, status: "copied" });
		},
		...overrides,
	};
	return { actions, calls };
}

async function mount(node: React.ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root: Root = createRoot(container);
	await act(async () => root.render(node));
	return {
		container,
		async unmount() {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

function buttonByText(container: HTMLElement, text: string) {
	return [...container.querySelectorAll("button")].find((button) =>
		button.textContent?.trim().startsWith(text)
	);
}

function card(container: HTMLElement) {
	return container.querySelector('[data-testid="feedback-card"]');
}

/**
 * Type into a controlled field the way React sees a user edit. react-dom may
 * load before the DOM is registered and then watches the focused field's
 * keyup instead of `input`, so send both.
 */
async function typeInto(
	field: HTMLInputElement | HTMLTextAreaElement,
	value: string
) {
	const prototype =
		field instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	await act(async () => {
		field.focus();
		setter?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

const IDEA = {
	body: "Exports ignore the dark theme.",
	kind: "idea",
	title: "Dark mode for exports",
};
const BUG = {
	actual: "The window closed.",
	body: "Ryu closes when I open a second chat.",
	kind: "bug",
	steps: "Open a chat, then open another.",
	title: "Crash on second chat",
};

let callSeq = 0;
function nextCallId() {
	callSeq += 1;
	return `feedback-call-${callSeq}`;
}

async function mountTool(
	input: unknown,
	options: {
		actions?: FeedbackActions;
		onFollowUp?: (text: string) => void | Promise<void>;
		state?: string;
		toolCallId?: string;
	} = {}
) {
	const part = {
		input,
		state: options.state ?? "output-available",
		toolCallId: options.toolCallId ?? nextCallId(),
	};
	return await mount(
		<FeedbackHostContext.Provider value={options.actions ?? null}>
			<FeedbackTool onFollowUp={options.onFollowUp} part={part} />
		</FeedbackHostContext.Provider>
	);
}

beforeEach(() => {
	globalThis.localStorage?.clear();
});

describe("feedback card, draft", () => {
	test("an idea shows the draft and environment lines, no errors", async () => {
		const { actions, calls } = host();
		const view = await mountTool(IDEA, {
			actions,
			onFollowUp: () => undefined,
		});
		try {
			const section = card(view.container);
			expect(section?.getAttribute("data-kind")).toBe("idea");
			expect(section?.getAttribute("data-state")).toBe("draft");
			expect(section?.getAttribute("aria-label")).toBe(
				"Share an idea with the Ryu team"
			);
			const title = view.container.querySelector("input");
			const body = view.container.querySelector("textarea");
			expect(title?.value).toBe("Dark mode for exports");
			expect(body?.value).toBe("Exports ignore the dark theme.");
			// An idea has no bug detail fields.
			expect(view.container.querySelectorAll("textarea")).toHaveLength(1);
			expect(calls.collected).toEqual(["idea"]);
			expect(
				view.container.querySelector('[data-testid="feedback-attached-count"]')
					?.textContent
			).toBe("2");
			expect(view.container.textContent).toContain("App version: 0.5.2");
			expect(view.container.textContent).not.toContain("Recent error");
			// Nothing was sent by showing the card.
			expect(calls.submitted).toHaveLength(0);
			expect(calls.opened).toBe(0);
		} finally {
			await view.unmount();
		}
	});

	test("a bug shows its details and the redacted recent errors", async () => {
		const { actions, calls } = host();
		const view = await mountTool(BUG, { actions, onFollowUp: () => undefined });
		try {
			const section = card(view.container);
			expect(section?.getAttribute("data-kind")).toBe("bug");
			expect(section?.getAttribute("aria-label")).toBe(
				"Report a problem to the Ryu team"
			);
			// Text, steps and what happened; "expected" was not drafted.
			expect(view.container.querySelectorAll("textarea")).toHaveLength(3);
			expect(view.container.textContent).toContain("Steps to reproduce");
			expect(view.container.textContent).toContain("What happened instead");
			expect(view.container.textContent).not.toContain("What you expected");
			expect(calls.collected).toEqual(["bug"]);
			expect(view.container.textContent).toContain(
				"Recent error 1: Bash: failed in ~/project"
			);
		} finally {
			await view.unmount();
		}
	});
});

describe("feedback card, sending", () => {
	test("sends exactly the edited draft and the lines left attached", async () => {
		const { actions, calls } = host();
		const followUps: string[] = [];
		const view = await mountTool(BUG, {
			actions,
			onFollowUp: (text) => {
				followUps.push(text);
			},
		});
		try {
			const title = view.container.querySelector("input");
			await typeInto(title as HTMLInputElement, "Crash when opening chats");
			const remove = view.container.querySelector<HTMLButtonElement>(
				'button[aria-label="Remove Recent error 1"]'
			);
			expect(remove).not.toBeNull();
			await act(async () => remove?.click());
			await act(async () =>
				view.container
					.querySelector<HTMLButtonElement>('button[aria-label="Remove Model"]')
					?.click()
			);
			expect(
				view.container.querySelector('[data-testid="feedback-attached-count"]')
					?.textContent
			).toBe("1");
			expect(calls.submitted).toHaveLength(0);

			await act(async () => {
				buttonByText(view.container, "Copy and open feedback board")?.click();
			});
			expect(calls.submitted).toHaveLength(1);
			const sent = calls.submitted[0];
			expect(sent?.draft.title).toBe("Crash when opening chats");
			expect(sent?.attachments.map((line) => line.id)).toEqual(["appVersion"]);
			expect(sent?.report).toContain("[Bug] Crash when opening chats");
			expect(sent?.report).toContain("App version: 0.5.2");
			expect(sent?.report).not.toContain("Recent error");
			expect(sent?.report).not.toContain("Model:");
			expect(followUps).toEqual([
				"I copied the bug report and opened the feedback board to post it myself. No need to draft it again.",
			]);

			// Thank-you state.
			expect(card(view.container)?.getAttribute("data-state")).toBe("copied");
			expect(view.container.textContent).toContain(
				"Thank you for your feedback"
			);
			expect(
				view.container.querySelector('[data-testid="feedback-copied-badge"]')
					?.textContent
			).toContain("Copied");
			expect(view.container.textContent).toContain("Crash when opening chats");
			expect(view.container.querySelector("textarea")).toBeNull();
			await act(async () => {
				buttonByText(view.container, "Open feedback board")?.click();
			});
			expect(calls.opened).toBe(1);
		} finally {
			await view.unmount();
		}
	});

	test("Not now sends nothing and tells the agent", async () => {
		const { actions, calls } = host();
		const followUps: string[] = [];
		const view = await mountTool(IDEA, {
			actions,
			onFollowUp: (text) => {
				followUps.push(text);
			},
		});
		try {
			await act(async () => {
				buttonByText(view.container, "Not now")?.click();
			});
			expect(calls.submitted).toHaveLength(0);
			expect(calls.opened).toBe(0);
			expect(followUps).toEqual(["Not now. I don't want to send this idea."]);
			expect(card(view.container)?.getAttribute("data-state")).toBe("declined");
			expect(view.container.textContent).toContain("Nothing was sent.");
			expect(
				buttonByText(view.container, "Copy and open feedback board")
			).toBeUndefined();
		} finally {
			await view.unmount();
		}
	});

	test("a failed copy keeps the draft open and says nothing was sent", async () => {
		const followUps: string[] = [];
		const { actions } = host({
			submitFeedback: () => Promise.reject(new Error("clipboard denied")),
		});
		const view = await mountTool(IDEA, {
			actions,
			onFollowUp: (text) => {
				followUps.push(text);
			},
		});
		try {
			await act(async () => {
				buttonByText(view.container, "Copy and open feedback board")?.click();
			});
			expect(card(view.container)?.getAttribute("data-state")).toBe("draft");
			expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
				"Couldn't copy the report. Nothing was sent."
			);
			expect(followUps).toEqual([]);
			expect(
				buttonByText(view.container, "Copy and open feedback board")?.disabled
			).toBe(false);
		} finally {
			await view.unmount();
		}
	});

	test("a board that does not open is reported, with a way to retry", async () => {
		const { actions, calls } = host({
			submitFeedback: () =>
				Promise.resolve({ destinationOpened: false, status: "copied" }),
		});
		const view = await mountTool(IDEA, {
			actions,
			onFollowUp: () => undefined,
		});
		try {
			await act(async () => {
				buttonByText(view.container, "Copy and open feedback board")?.click();
			});
			expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
				"Couldn't open the feedback board."
			);
			await act(async () => {
				buttonByText(view.container, "Open feedback board")?.click();
			});
			expect(calls.opened).toBe(1);
			expect(view.container.querySelector('[role="alert"]')).toBeNull();
		} finally {
			await view.unmount();
		}
	});

	test("an empty title cannot be sent", async () => {
		const { actions } = host();
		const view = await mountTool(IDEA, {
			actions,
			onFollowUp: () => undefined,
		});
		try {
			await typeInto(
				view.container.querySelector("input") as HTMLInputElement,
				"   "
			);
			expect(
				buttonByText(view.container, "Copy and open feedback board")?.disabled
			).toBe(true);
		} finally {
			await view.unmount();
		}
	});

	test("the agent's follow-up can be retried when the chat refuses it", async () => {
		const { actions, calls } = host();
		let attempts = 0;
		const view = await mountTool(IDEA, {
			actions,
			onFollowUp: () => {
				attempts += 1;
				return attempts === 1
					? Promise.reject(new Error("offline"))
					: Promise.resolve();
			},
		});
		try {
			await act(async () => {
				buttonByText(view.container, "Copy and open feedback board")?.click();
			});
			expect(buttonByText(view.container, "Send again")).toBeDefined();
			await act(async () => {
				buttonByText(view.container, "Send again")?.click();
			});
			expect(attempts).toBe(2);
			expect(buttonByText(view.container, "Send again")).toBeUndefined();
			// The report itself was copied once; only the message was retried.
			expect(calls.submitted).toHaveLength(1);
		} finally {
			await view.unmount();
		}
	});
});

describe("feedback card, after a reload", () => {
	test("the sent state survives a remount and does not collect again", async () => {
		const first = host();
		const toolCallId = nextCallId();
		const view = await mountTool(IDEA, {
			actions: first.actions,
			onFollowUp: () => undefined,
			toolCallId,
		});
		await act(async () => {
			buttonByText(view.container, "Copy and open feedback board")?.click();
		});
		await view.unmount();

		const second = host();
		const reopened = await mountTool(IDEA, {
			actions: second.actions,
			onFollowUp: () => undefined,
			toolCallId,
		});
		try {
			expect(card(reopened.container)?.getAttribute("data-state")).toBe(
				"copied"
			);
			expect(reopened.container.textContent).toContain(
				"Thank you for your feedback"
			);
			expect(
				buttonByText(reopened.container, "Copy and open feedback board")
			).toBeUndefined();
			expect(second.calls.collected).toEqual([]);
			expect(second.calls.submitted).toEqual([]);
		} finally {
			await reopened.unmount();
		}
	});

	test("a declined card stays closed after a remount", async () => {
		const { actions } = host();
		const toolCallId = nextCallId();
		const view = await mountTool(BUG, {
			actions,
			onFollowUp: () => undefined,
			toolCallId,
		});
		await act(async () => {
			buttonByText(view.container, "Not now")?.click();
		});
		await view.unmount();
		const reopened = await mountTool(BUG, {
			actions,
			onFollowUp: () => undefined,
			toolCallId,
		});
		try {
			expect(card(reopened.container)?.getAttribute("data-state")).toBe(
				"declined"
			);
		} finally {
			await reopened.unmount();
		}
	});
});

describe("feedback card, not actionable", () => {
	test("a streaming or rejected call draws no card", async () => {
		const { actions, calls } = host();
		const streaming = await mountTool(
			{ kind: "idea", title: "Dark" },
			{ actions, onFollowUp: () => undefined, state: "input-streaming" }
		);
		expect(card(streaming.container)).toBeNull();
		expect(streaming.container.textContent).toContain("Drafting a report");
		await streaming.unmount();

		const rejected = await mountTool(IDEA, {
			actions,
			onFollowUp: () => undefined,
			state: "output-error",
		});
		expect(card(rejected.container)).toBeNull();
		await rejected.unmount();

		const malformed = await mountTool(
			{ ...IDEA, kind: "praise" },
			{ actions, onFollowUp: () => undefined }
		);
		expect(card(malformed.container)).toBeNull();
		await malformed.unmount();
		expect(calls.collected).toEqual([]);
	});

	test("without a host or a reply channel the card is read-only", async () => {
		const noHost = await mountTool(IDEA, { onFollowUp: () => undefined });
		try {
			expect(card(noHost.container)?.getAttribute("data-state")).toBe(
				"read-only"
			);
			expect(noHost.container.textContent).toContain("Dark mode for exports");
			expect(noHost.container.textContent).toContain("Nothing was sent.");
			expect(noHost.container.querySelectorAll("button")).toHaveLength(0);
		} finally {
			await noHost.unmount();
		}
		const { actions, calls } = host();
		const noReply = await mountTool(IDEA, { actions });
		try {
			expect(card(noReply.container)?.getAttribute("data-state")).toBe(
				"read-only"
			);
			expect(calls.collected).toEqual([]);
		} finally {
			await noReply.unmount();
		}
	});
});
