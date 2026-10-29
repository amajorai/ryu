import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// The full history view's scroll area waits on Web Animations, which happy-dom
// does not implement.
Reflect.set(Element.prototype, "getAnimations", () => []);
// The machine clock is Tokyo; the person chose New York as the display zone.
// Every grouping below disagrees between the two, so a machine-local
// implementation cannot pass.
const machineZone = process.env.TZ;
process.env.TZ = "Asia/Tokyo";
const { createRoot } = await import("react-dom/client");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { ChatHistoryProvider } = await import(
	"@/src/contexts/ChatHistoryContext.tsx"
);
const { TabsContext } = await import("@/src/contexts/TabsContext.tsx");
const { AgentRunHistoryView } = await import(
	"@/src/components/agents/AgentRunHistoryView.tsx"
);
const { nextDisplayDayBoundaryMs, resetTimezone, setTimezonePreference } =
	await import("@ryu/ui/lib/timezone.ts");

const AGENT_ID = "agent-day-groups";
// New York's spring-forward day: 23 hours long, midnight at 04:00Z.
const MIDNIGHT = Date.parse("2026-03-09T04:00:00.000Z");
const conversations = [
	["chat-late", "Late planning", "2026-03-09T03:10:00.000Z", AGENT_ID],
	["chat-early", "Early review", "2026-03-08T05:30:00.000Z", AGENT_ID],
	["chat-eve", "Evening triage", "2026-03-08T03:30:00.000Z", AGENT_ID],
	["chat-old", "Older sync", "2026-03-06T15:00:00.000Z", AGENT_ID],
	["chat-foreign", "Other agent", "2026-03-09T03:20:00.000Z", "another-agent"],
].map(([id, title, at, agent]) => ({
	agent_id: agent,
	archived: false,
	branch: null,
	created_at: Date.parse(at as string),
	folder_path: null,
	id,
	message_count: 2,
	run_status: null,
	title,
	updated_at: Date.parse(at as string),
	visibility: "private",
	worktree_path: null,
}));
const servedConversations = JSON.stringify(conversations);
/** Core's scheduled jobs; the overview case serves one routine for this agent. */
let servedJobs: unknown[] = [];
const requests: string[] = [];
const unexpected: string[] = [];
const openStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request: Request): Response => {
		const url = new URL(request.url);
		if (request.headers.get("authorization") !== "Bearer day-token") {
			unexpected.push(`unauthorized ${url.pathname}`);
			return NativeResponse.json({ error: "Refused" }, { status: 403 });
		}
		requests.push(`${request.method} ${url.pathname}`);
		if (request.method !== "GET") {
			unexpected.push(`${request.method} ${url.pathname}`);
			return NativeResponse.json({ error: "Read only" }, { status: 405 });
		}
		if (url.pathname === "/node/api/conversations") {
			return NativeResponse.json({
				conversations: JSON.parse(servedConversations),
			});
		}
		if (url.pathname === "/node/heartbeat/jobs") {
			return NativeResponse.json({ jobs: servedJobs });
		}
		if (url.pathname === "/node/api/runs/stream") {
			const frame = new TextEncoder().encode(
				`data: ${JSON.stringify({ type: "snapshot", runs: [] })}\n\n`
			);
			let owned: ReadableStreamDefaultController<Uint8Array> | undefined;
			return new NativeResponse(
				new ReadableStream<Uint8Array>({
					start(controller) {
						owned = controller;
						openStreams.add(controller);
						controller.enqueue(frame);
					},
					cancel() {
						if (owned) {
							openStreams.delete(owned);
						}
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } }
			);
		}
		unexpected.push(`GET ${url.pathname}`);
		return NativeResponse.json({ error: "Unsupported" }, { status: 404 });
	},
});

const initialStore = useNodeStore.getState();
let root: Root | undefined;
let container: HTMLDivElement | undefined;
const opened: string[] = [];

/** Day-store timers and focus/visibility listeners, by creation stack. */
function auditDayResources() {
	const originalSet = globalThis.setTimeout;
	const originalClear = globalThis.clearTimeout;
	const targets = [window, document].map((target) => ({
		target,
		add: target.addEventListener,
		remove: target.removeEventListener,
	}));
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const listeners = new Set<EventListenerOrEventListenerObject>();
	const owned = () =>
		new Error("display-day ownership").stack?.includes("/lib/display-day.ts") ??
		false;
	globalThis.setTimeout = ((
		handler: (...args: unknown[]) => void,
		delay?: number,
		...args: unknown[]
	) => {
		const track = owned();
		const handle = originalSet(() => {
			timers.delete(handle);
			handler(...args);
		}, delay);
		if (track) {
			timers.add(handle);
		}
		return handle;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
		timers.delete(handle);
		return originalClear(handle);
	}) as typeof clearTimeout;
	for (const { target, add, remove } of targets) {
		target.addEventListener = function (
			this: EventTarget,
			type: string,
			callback: EventListenerOrEventListenerObject | null,
			options?: AddEventListenerOptions | boolean
		) {
			if (callback && owned() && ["focus", "visibilitychange"].includes(type)) {
				listeners.add(callback);
			}
			if (callback) {
				add.call(this, type, callback, options);
			}
		};
		target.removeEventListener = function (
			this: EventTarget,
			type: string,
			callback: EventListenerOrEventListenerObject | null,
			options?: EventListenerOptions | boolean
		) {
			if (callback) {
				listeners.delete(callback);
				remove.call(this, type, callback, options);
			}
		};
	}
	return {
		counts: () => ({ timers: timers.size, listeners: listeners.size }),
		restore: () => {
			globalThis.setTimeout = originalSet;
			globalThis.clearTimeout = originalClear;
			for (const { target, add, remove } of targets) {
				target.addEventListener = add;
				target.removeEventListener = remove;
			}
		},
	};
}

async function mount(
	view: { compact: boolean; testId: string } = {
		compact: true,
		testId: "agent-activity-feed",
	}
): Promise<HTMLElement> {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const tabs = {
		openTab: (path: string, options: { conversationId?: string }) => {
			opened.push(`${path}#${options.conversationId ?? ""}`);
		},
	};
	await act(async () => {
		root?.render(
			<ChatHistoryProvider>
				<TabsContext.Provider value={tabs as never}>
					<AgentRunHistoryView agentId={AGENT_ID} compact={view.compact} />
				</TabsContext.Provider>
			</ChatHistoryProvider>
		);
	});
	for (let attempt = 0; attempt < 250; attempt++) {
		const feed = container.querySelector<HTMLElement>(
			`[data-testid="${view.testId}"]`
		);
		if (feed) {
			return feed;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 4));
		});
	}
	throw new Error(`${view.testId} never rendered the served data`);
}

/** What a person reads: each day heading with its rows' titles and times. */
function readFeed(feed: HTMLElement) {
	return [...feed.querySelectorAll("section")].map((section) => ({
		day: section.querySelector("h3")?.textContent,
		rows: [...section.querySelectorAll("button")].map(
			(row) =>
				`${row.querySelector("span.truncate.font-medium")?.textContent} ${row.querySelector("span.shrink-0.text-xs")?.textContent}`
		),
	}));
}

beforeEach(() => {
	requests.length = 0;
	unexpected.length = 0;
	opened.length = 0;
	servedJobs = [];
	localStorage.clear();
	useNodeStore.setState({
		defaultNode: "day",
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
		nodes: [
			{
				name: "day",
				url: `${server.url.origin}/node`,
				token: "day-token",
				userJwt: "day-jwt",
			},
		],
	});
	setTimezonePreference("America/New_York");
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	container = undefined;
	setSystemTime();
	resetTimezone();
	useNodeStore.setState(initialStore, true);
	if (unexpected.length > 0) {
		throw new Error(`Undeclared native requests: ${unexpected.join(", ")}`);
	}
});
afterAll(() => {
	for (const stream of openStreams) {
		stream.close();
	}
	server.stop(true);
	globalThis.fetch = nativeFetch;
	if (machineZone === undefined) {
		delete process.env.TZ;
	} else {
		process.env.TZ = machineZone;
	}
});

test("the compact activity feed groups and stamps served runs in the display zone, then rolls them to Yesterday at its midnight", async () => {
	setSystemTime(MIDNIGHT - 80);
	expect(nextDisplayDayBoundaryMs(MIDNIGHT - 80)).toBe(MIDNIGHT);
	const audit = auditDayResources();
	try {
		const feed = await mount();
		expect(requests).toContain("GET /node/api/conversations");
		expect(readFeed(feed)).toEqual([
			{
				day: "Today",
				rows: ["Late planning 11:10 PM", "Early review 12:30 AM"],
			},
			{ day: "Yesterday", rows: ["Evening triage 10:30 PM"] },
			{ day: "Mar 6", rows: ["Older sync 10:00 AM"] },
		]);
		// The clock alone crosses New York midnight (Tokyo is mid-afternoon):
		// no request, prop or record changes; only the shared day wake fires.
		const requestCount = requests.length;
		await act(async () => {
			setSystemTime(MIDNIGHT + 1);
			await new Promise((resolve) => setTimeout(resolve, 120));
		});
		expect(readFeed(feed)).toEqual([
			{
				day: "Yesterday",
				rows: ["Late planning 11:10 PM", "Early review 12:30 AM"],
			},
			{ day: "Mar 7", rows: ["Evening triage 10:30 PM"] },
			{ day: "Mar 6", rows: ["Older sync 10:00 AM"] },
		]);
		expect(requests.length).toBe(requestCount);
		expect(feed.textContent).not.toContain("Other agent");
		expect(JSON.stringify(conversations)).toBe(servedConversations);
		// Opening a regrouped row still targets its own conversation.
		const late = [...feed.querySelectorAll("button")].find((row) =>
			row.textContent?.includes("Late planning")
		);
		await act(async () => {
			late?.click();
		});
		expect(opened).toEqual(["/chat#chat-late"]);
		expect(audit.counts()).toEqual({ timers: 1, listeners: 2 });
		await act(async () => root?.unmount());
		root = undefined;
		expect(audit.counts()).toEqual({ timers: 0, listeners: 0 });
	} finally {
		audit.restore();
	}
});

test("runs stamped on a later display day keep their date instead of joining Today", async () => {
	// 10:00 on Mar 7 in New York: "Late planning" and "Early review" fall on
	// Mar 8, a day that has not started here (a node clock running ahead).
	setSystemTime(Date.parse("2026-03-07T15:00:00.000Z"));
	const feed = await mount();
	expect(readFeed(feed)).toEqual([
		{
			day: "Mar 8",
			rows: ["Late planning 11:10 PM", "Early review 12:30 AM"],
		},
		{ day: "Today", rows: ["Evening triage 10:30 PM"] },
		{ day: "Yesterday", rows: ["Older sync 10:00 AM"] },
	]);
});

test("a display-zone change regroups the mounted feed without refetching", async () => {
	setSystemTime(Date.parse("2026-03-09T03:30:00.000Z"));
	const feed = await mount();
	expect(readFeed(feed)).toEqual([
		{
			day: "Today",
			rows: ["Late planning 11:10 PM", "Early review 12:30 AM"],
		},
		{ day: "Yesterday", rows: ["Evening triage 10:30 PM"] },
		{ day: "Mar 6", rows: ["Older sync 10:00 AM"] },
	]);
	const requestCount = requests.length;
	await act(async () => {
		setTimezonePreference("Asia/Tokyo");
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(readFeed(feed)).toEqual([
		{ day: "Today", rows: ["Late planning 12:10 PM"] },
		{
			day: "Yesterday",
			rows: ["Early review 2:30 PM", "Evening triage 12:30 PM"],
		},
		{ day: "Mar 7", rows: ["Older sync 12:00 AM"] },
	]);
	expect(requests.length).toBe(requestCount);
});

test("the routine overview's window-ending stamp reads in the display zone and follows a zone change without refetching", async () => {
	servedJobs = [
		{
			created_at: "2026-03-01T00:00:00.000Z",
			enabled: true,
			history: [],
			id: "routine-digest",
			name: "Morning digest",
			schedule: { kind: "every", interval: "6h" },
			target: { agent_id: AGENT_ID, prompt: "Summarize", type: "agent" },
			updated_at: "2026-03-01T00:00:00.000Z",
		},
	];
	// 03:30Z is 23:30 on March 8 in New York and 12:30 on March 9 in Tokyo.
	setSystemTime(Date.parse("2026-03-09T03:30:00.000Z"));
	const overview = await mount({
		compact: false,
		testId: "agent-run-overview",
	});
	expect(requests).toContain("GET /node/heartbeat/jobs");
	const windowEnding = () =>
		[...overview.querySelectorAll("p")]
			.map((paragraph) => paragraph.textContent ?? "")
			.find((text) => text.startsWith("Window ending"));
	expect(overview.textContent).toContain("Morning digest");
	expect(windowEnding()).toBe(
		"Window ending Mar 8, 23:30. Open an automated run below to inspect its full persistent transcript."
	);
	const requestCount = requests.length;
	await act(async () => {
		setTimezonePreference("Asia/Tokyo");
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(windowEnding()).toBe(
		"Window ending Mar 9, 12:30. Open an automated run below to inspect its full persistent transcript."
	);
	expect(requests.length).toBe(requestCount);
});
