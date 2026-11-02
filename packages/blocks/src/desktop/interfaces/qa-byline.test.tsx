// The Q&A byline is one whole message per variant, so a translation can put
// the name, the verb and the age in its own order. A German catalog that
// moves the age first shows the byline reads from the message, not from
// English fragments ("answered", "asked") glued around the parts.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceAgent,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { Root } from "react-dom/client";
import type { QaBylineKind, QaQuestion } from "./qa-model.ts";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { I18nProvider } = await import("@ryu/i18n/react");
const { QaByline } = await import("./qa-byline.tsx");

const DE: Record<string, string> = {
	"<name>{names}</name> <live>is answering</live>":
		"<name>{names}</name> <live>antwortet gerade</live>",
	"<name>{names}</name> answered <time>{ago}</time>":
		"<time>{ago}</time> hat <name>{names}</name> geantwortet",
	"<name>{names}</name>: <failed>run failed</failed>":
		"<name>{names}</name>: <failed>Lauf fehlgeschlagen</failed>",
	"<you>You</you> asked <time>{ago}</time>":
		"<time>{ago}</time> hast <you>du</you> gefragt",
	"An agent": "Ein Agent",
	"No answers yet": "Noch keine Antworten",
	"Waiting on {names}": "Wartet auf {names}",
};

const NOW = Date.parse("2026-11-02T12:00:00Z");
const ADA: InterfaceAgent = {
	avatarUrl: null,
	description: "",
	id: "agent-ada",
	name: "Ada",
	status: "idle",
};

function question(byline: QaBylineKind, answerers = [ADA]): QaQuestion {
	const thread: InterfaceThread = {
		agentIds: answerers.map((agent) => agent.id),
		id: "thread-notes",
		lastMessage: "Draft is ready.",
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: byline === "answering",
		teamId: null,
		title: "Release notes",
		updatedAt: new Date(NOW - 5 * 60_000).toISOString(),
	};
	return {
		answerers,
		answers: 1,
		byline,
		excerpt: thread.lastMessage,
		status: "your-turn",
		thread,
		topics: [],
	};
}

let mounted: { container: HTMLElement; root: Root } | undefined;

async function renderDe(item: QaQuestion): Promise<HTMLElement> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("de") ? DE : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="de" initialPackId={null}>
				<QaByline now={NOW} question={item} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

afterEach(async () => {
	registerLiteralCatalogLoader(null);
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

/** The byline's words, without the faces. */
function words(root: HTMLElement): string {
	return (root.querySelector("div > span:last-child")?.textContent ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

describe("Q&A byline in German", () => {
	test("answered: the catalog's word order, the name kept as written", async () => {
		const root = await renderDe(question("answered"));
		const text = words(root);
		expect(text).toMatch(/^.+ hat Ada geantwortet$/);
		expect(text).not.toContain("answered");
		const name = [...root.querySelectorAll('[data-ryu-i18n="off"]')].find(
			(element) => element.textContent === "Ada"
		);
		expect(name).toBeDefined();
		expect(root.querySelector("time")?.getAttribute("dateTime")).toBe(
			question("answered").thread.updatedAt
		);
	});

	test("answering: one sentence in the success tone", async () => {
		const root = await renderDe(question("answering"));
		expect(words(root)).toBe("Ada antwortet gerade");
		expect(root.querySelector(".text-status-success")?.textContent).toBe(
			"antwortet gerade"
		);
	});

	test("failed: the name and the failure, then the age", async () => {
		const root = await renderDe(question("failed"));
		const text = words(root);
		expect(text).toStartWith("Ada: Lauf fehlgeschlagen");
		expect(text).not.toContain("run failed");
		expect(root.querySelector("time")).not.toBeNull();
	});

	test("asked: the user's question and who it waits on", async () => {
		const root = await renderDe(question("asked"));
		const text = words(root);
		expect(text).toMatch(/^.+ hast du gefragt·Wartet auf Ada$/);
		expect(text).not.toContain("asked");
		expect(text).not.toContain("You");
	});

	test("unasked: no answers yet, and no agent named", async () => {
		const root = await renderDe(question("unasked", []));
		const text = words(root);
		expect(text).toMatch(/^.+ hast du gefragt·Noch keine Antworten$/);
	});

	test("an unnamed agent reads from the catalog too", async () => {
		const root = await renderDe(question("answering", []));
		expect(words(root)).toBe("Ein Agent antwortet gerade");
	});
});
