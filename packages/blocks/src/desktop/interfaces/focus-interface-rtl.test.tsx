// Focus, the library reader, the board's lane edges and the status glyphs
// under dir="rtl": previous/next chevrons and the Reply glyph mirror with the
// layout, and Focus's page-level arrow keys follow the reading direction.
import "./board-test-dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { DirectionProvider } from "@ryu/ui/components/direction.tsx";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { LaneEdge } from "./board-interface-lane-edge.tsx";
import { DeskStatusIcon, DeskStatusPill } from "./desk-status.tsx";
import { FocusInterface } from "./focus-interface.tsx";
import { InboxStatusIcon } from "./inbox-status.tsx";
import type { LibraryBook } from "./library-model.ts";
import { ChapterReader } from "./library-reader.tsx";

const MIRROR = "rtl:-scale-x-100";
const NOW = Date.now();

function thread(id: string, minutesAgo: number): InterfaceThread {
	return {
		agentIds: [],
		id,
		lastMessage: "Hello",
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: id,
		updatedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
	};
}

const SNAPSHOT: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [thread("one", 1), thread("two", 2), thread("three", 3)],
	version: 1,
};

const NOOP_PORT: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

/** Class lists of every lucide glyph whose name matches `name`. */
function glyphClasses(html: string, name: string): string[] {
	const pattern = new RegExp(
		`<svg[^>]*class="([^"]*lucide-${name}[^"]*)"`,
		"gu"
	);
	return [...html.matchAll(pattern)].map((match) => match[1] ?? "");
}

/** "mirrored" when every `name` glyph mirrors, "missing" when none renders. */
function mirrorOf(html: string, name: string): string {
	const classes = glyphClasses(html, name);
	if (classes.length === 0) {
		return "missing";
	}
	return classes.every((list) => list.split(" ").includes(MIRROR))
		? "mirrored"
		: "unmirrored";
}

let mounted: { container: HTMLElement; root: Root } | null = null;

afterEach(() => {
	if (mounted) {
		const { container, root } = mounted;
		act(() => root.unmount());
		container.remove();
		mounted = null;
	}
});

async function mount(element: ReactElement, direction: "ltr" | "rtl") {
	const container = document.createElement("div");
	container.setAttribute("dir", direction);
	container.style.direction = direction;
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(element));
	mounted = { container, root };
	return container;
}

async function press(key: string) {
	await act(async () => {
		document.body.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

function position(container: HTMLElement) {
	return container.querySelector("[aria-live='polite']")?.textContent ?? "";
}

async function focusPositionAfter(direction: "ltr" | "rtl", keys: string[]) {
	const container = await mount(
		<FocusInterface
			activeThreadId={null}
			loading={false}
			params={{}}
			port={NOOP_PORT}
			snapshot={SNAPSHOT}
			threadView={null}
		/>,
		direction
	);
	for (const key of keys) {
		await press(key);
	}
	return position(container);
}

describe("Focus arrow keys follow the reading direction", () => {
	test("ArrowRight steps to the next thread in LTR", async () => {
		expect(await focusPositionAfter("ltr", ["ArrowRight"])).toBe("2 of 3");
	});

	test("ArrowLeft steps to the next thread in RTL", async () => {
		expect(await focusPositionAfter("rtl", ["ArrowLeft"])).toBe("2 of 3");
	});

	test("ArrowRight steps back in RTL", async () => {
		const keys = ["ArrowLeft", "ArrowLeft", "ArrowRight", "ArrowRight"];
		expect(await focusPositionAfter("rtl", keys)).toBe("1 of 3");
	});
});

describe("Focus advertises the arrow keys it answers to", () => {
	function shortcuts(direction: "ltr" | "rtl", activeThreadId: string | null) {
		const html = renderToStaticMarkup(
			<DirectionProvider direction={direction}>
				<FocusInterface
					activeThreadId={activeThreadId}
					loading={false}
					params={{}}
					port={NOOP_PORT}
					snapshot={SNAPSHOT}
					threadView={activeThreadId ? <p>chat</p> : null}
				/>
			</DirectionProvider>
		);
		return [...html.matchAll(/aria-keyshortcuts="([JK] [^"]+)"/gu)].map(
			(match) => match[1]
		);
	}

	test("card and frame steps in LTR", () => {
		expect(shortcuts("ltr", null)).toEqual(["K ArrowLeft", "J ArrowRight"]);
		expect(shortcuts("ltr", "two")).toEqual(["K ArrowLeft", "J ArrowRight"]);
	});

	test("card and frame steps swap arrows in RTL", () => {
		expect(shortcuts("rtl", null)).toEqual(["K ArrowRight", "J ArrowLeft"]);
		expect(shortcuts("rtl", "two")).toEqual(["K ArrowRight", "J ArrowLeft"]);
	});
});

describe("directional glyphs passed as props or variables mirror", () => {
	test("Focus card Previous and Next chevrons", () => {
		const html = renderToStaticMarkup(
			<FocusInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(mirrorOf(html, "chevron-left")).toBe("mirrored");
		expect(mirrorOf(html, "chevron-right")).toBe("mirrored");
	});

	test("Focus frame Previous thread and Next thread chevrons", () => {
		const html = renderToStaticMarkup(
			<FocusInterface
				activeThreadId="two"
				loading={false}
				params={{}}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={<p>chat</p>}
			/>
		);
		expect(mirrorOf(html, "chevron-left")).toBe("mirrored");
		expect(mirrorOf(html, "chevron-right")).toBe("mirrored");
	});

	test("library page turns", () => {
		const chapters = SNAPSHOT.threads.map((item, index) => ({
			finished: true,
			number: index + 1,
			status: "quiet" as const,
			thread: item,
		}));
		const book: LibraryBook = {
			agentId: null,
			authors: [],
			chapters,
			description: "",
			finishedCount: chapters.length,
			groupId: null,
			id: "book",
			kind: "unassigned",
			title: "Book",
			updatedAt: null,
			waiting: [],
			working: false,
		};
		const html = renderToStaticMarkup(
			<ChapterReader
				book={book}
				now={NOW}
				onBack={() => undefined}
				onOpenChapter={() => undefined}
				threadId="two"
				threadView={<p>chat</p>}
			/>
		);
		expect(mirrorOf(html, "chevron-left")).toBe("mirrored");
		expect(mirrorOf(html, "chevron-right")).toBe("mirrored");
	});

	test("board lane edges", () => {
		for (const [side, glyph] of [
			["start", "chevron-left"],
			["end", "chevron-right"],
		] as const) {
			const html = renderToStaticMarkup(
				<LaneEdge count={2} onStep={() => undefined} side={side} />
			);
			expect(mirrorOf(html, glyph)).toBe("mirrored");
		}
	});

	test("the Reply status glyph mirrors and the others stay put", () => {
		const reply = renderToStaticMarkup(
			<>
				<InboxStatusIcon status="your-turn" />
				<DeskStatusIcon status="your-turn" />
				<DeskStatusPill status="your-turn" />
			</>
		);
		expect(glyphClasses(reply, "reply")).toHaveLength(3);
		expect(mirrorOf(reply, "reply")).toBe("mirrored");
		const clock = renderToStaticMarkup(<InboxStatusIcon status="waiting" />);
		expect(clock).not.toContain(MIRROR);
	});
});
