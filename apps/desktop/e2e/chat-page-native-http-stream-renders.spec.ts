import { expect, type Page, test } from "@playwright/test";
import { chatPageControl } from "./chat-page-native-http-support.ts";
import {
	installStreamRenderProbe,
	type StreamRenderProbe,
} from "./chat-page-stream-render-probe.ts";

// The shipping Layout and ChatPage, streaming 200 text chunks into one reply.
// Only the transcript should follow each chunk: the page shell, the title bar
// and the composer render when the turn starts and ends, not once per token.
const CHUNKS = 200;
// Above the active tab's 50 ms stream throttle, so every chunk is its own update.
const CHUNK_INTERVAL_MS = 70;
// Style recalc across all 200 chunks. About 0.6 s when each chunk restyles only
// the nodes it adds; a document-level `:has()` rule over a descendant (see
// styles/window-chrome.css) restyled the whole page per chunk: about 35 s.
const STYLE_RECALC_BUDGET_S = 5;
const WATCHED = [
	"ChatPage",
	"AgentChat",
	"MessageList",
	"InputBar",
	"CouncilInputBar",
	"TitleBar",
	"WorkspacePanels",
	"LiveMessageList",
	"UserMessage",
	"TypingIndicator",
	...(process.env.RYU_STREAM_RENDER_ALL ? ["*"] : []),
];

type ProbeMethod = keyof StreamRenderProbe;

/** Calls one probe method in the page and returns its (serializable) result. */
function probe<M extends ProbeMethod>(
	page: Page,
	method: M,
	...args: Parameters<StreamRenderProbe[M]>
) {
	return page.evaluate(
		({ method, args }) => {
			const fixture = Reflect.get(
				window,
				"__streamRenderProbe"
			) as StreamRenderProbe;
			return (fixture[method] as (...values: unknown[]) => unknown)(...args);
		},
		{ method, args: args as unknown[] }
	) as Promise<Awaited<ReturnType<StreamRenderProbe[M]>>>;
}

test("streaming 200 chunks re-renders the transcript, not the page shell or composer", async ({
	page,
	request,
}) => {
	test.setTimeout(120_000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await chatPageControl(request, { action: "reset", scenario: "share" });
	await page.setViewportSize({ width: 1480, height: 960 });
	await page.addInitScript(installStreamRenderProbe, WATCHED);
	await page.goto("/chat-page-native-http.html");
	const composer = page
		.getByPlaceholder("Ask a follow up")
		.filter({ visible: true });
	await expect(composer).toBeVisible({ timeout: 60_000 });
	await probe(page, "arm");
	await composer.fill("Stream two hundred chunks.");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await expect.poll(() => probe(page, "opened")).toBe(true);
	await probe(page, "push", [
		{ type: "start", messageId: "probe-live" },
		{ type: "text-start", id: "probe-text" },
		{ type: "text-delta", id: "probe-text", delta: "Probe reply:" },
	]);
	await expect(page.getByText(/^Probe reply:/)).toBeVisible();
	// Let the turn-start work (status, typing row, header) settle first.
	await page.waitForTimeout(500);
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Performance.enable");
	const recalcSeconds = async () =>
		(await cdp.send("Performance.getMetrics")).metrics.find(
			(metric) => metric.name === "RecalcStyleDuration"
		)?.value ?? 0;
	const recalcBefore = await recalcSeconds();
	await probe(page, "reset");
	await probe(page, "streamChunks", CHUNKS, CHUNK_INTERVAL_MS);
	await expect(page.getByText(new RegExp(`chunk-${CHUNKS}$`))).toBeVisible();
	await page.waitForTimeout(200);
	const styleRecalcS = (await recalcSeconds()) - recalcBefore;
	const counts = await probe(page, "counts");
	const commits = await probe(page, "commits");
	const log = await probe(page, "log");
	const report = {
		chunks: CHUNKS,
		commits,
		renders: counts,
		styleRecalcS,
		log,
	};
	test.info().annotations.push({
		type: "stream-renders",
		description: JSON.stringify(report),
	});
	if (process.env.RYU_STREAM_RENDER_REPORT) {
		process.stdout.write(`stream-renders ${JSON.stringify(report)}\n`);
	}
	await probe(page, "close");
	await expect(
		page.getByRole("button", { name: "Send", exact: true })
	).toBeVisible();
	expect(errors).toEqual([]);

	// The transcript follows the stream...
	expect(counts.MessageList ?? 0).toBeGreaterThanOrEqual(CHUNKS * 0.5);
	// ...while the page shell, title bar and composer do not.
	const budget = CHUNKS * 0.1;
	expect(counts.ChatPage ?? 0).toBeLessThanOrEqual(budget);
	expect(counts.AgentChat ?? 0).toBeLessThanOrEqual(budget);
	expect(counts.InputBar ?? 0).toBeLessThanOrEqual(budget);
	expect(counts.CouncilInputBar ?? 0).toBeLessThanOrEqual(budget);
	expect(counts.TitleBar ?? 0).toBeLessThanOrEqual(budget);
	expect(counts.WorkspacePanels ?? 0).toBeLessThanOrEqual(budget);
	// Inside the live turn, only the streaming reply follows: the user's own
	// message and the typing indicator above it keep still.
	expect(counts.UserMessage ?? 0).toBeLessThanOrEqual(budget);
	expect(counts.TypingIndicator ?? 0).toBeLessThanOrEqual(budget);
	// ...and no chunk restyles the whole document.
	expect(styleRecalcS).toBeLessThanOrEqual(STYLE_RECALC_BUDGET_S);
});

// Find in chat searches the text as it streams, so while it is open the page
// follows every chunk again. The model picker placed in the tab bar is rebuilt
// on every page render; it must re-render in place without re-pushing the
// title bar's actions (which re-rendered the whole title bar per chunk).
test("find in chat follows streamed text while the tab-bar picker holds the title bar still", async ({
	page,
	request,
}) => {
	test.setTimeout(120_000);
	const chunks = 60;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await chatPageControl(request, { action: "reset", scenario: "share" });
	await page.setViewportSize({ width: 1480, height: 960 });
	await page.addInitScript(() => {
		localStorage.setItem("ryu:chat-picker-placement", "tab-bar");
	});
	await page.addInitScript(installStreamRenderProbe, WATCHED);
	await page.goto("/chat-page-native-http.html");
	const composer = page
		.getByPlaceholder("Ask a follow up")
		.filter({ visible: true });
	await expect(composer).toBeVisible({ timeout: 60_000 });
	const tabBarPicker = page.getByTestId("chat-model-agent-picker-tab-bar");
	await expect(tabBarPicker).toBeVisible();
	await expect(tabBarPicker.getByTestId("chat-model-agent-picker")).toHaveCount(
		1
	);
	await probe(page, "arm");
	await composer.fill("Stream while I search.");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await expect.poll(() => probe(page, "opened")).toBe(true);
	await probe(page, "push", [
		{ type: "start", messageId: "probe-live" },
		{ type: "text-start", id: "probe-text" },
		{ type: "text-delta", id: "probe-text", delta: "Probe reply:" },
	]);
	await expect(page.getByText(/^Probe reply:/)).toBeVisible();
	await page.keyboard.press("Control+f");
	const searchInput = page.getByTestId("chat-search-input");
	await expect(searchInput).toBeVisible();
	await searchInput.fill(`chunk-${chunks}`);
	await expect(page.getByTestId("chat-search-status")).not.toHaveText("1 of 1");
	await page.waitForTimeout(300);
	await probe(page, "reset");
	await probe(page, "streamChunks", chunks, CHUNK_INTERVAL_MS);
	await expect(page.getByText(new RegExp(`chunk-${chunks}$`))).toBeVisible();
	// The match exists only in text that streamed after the search opened.
	await expect(page.getByTestId("chat-search-status")).toHaveText("1 of 1");
	const counts = await probe(page, "counts");
	if (process.env.RYU_STREAM_RENDER_REPORT) {
		const log = await probe(page, "log");
		process.stdout.write(
			`stream-renders-search ${JSON.stringify({ chunks, renders: counts, log })}\n`
		);
	}
	await probe(page, "close");
	await expect(
		page.getByRole("button", { name: "Send", exact: true })
	).toBeVisible();
	expect(errors).toEqual([]);
	// The page follows the stream while searching...
	expect(counts.ChatPage ?? 0).toBeGreaterThanOrEqual(chunks * 0.5);
	// ...and the title bar does not.
	expect(counts.TitleBar ?? 0).toBeLessThanOrEqual(chunks * 0.1);
	await expect(tabBarPicker.getByTestId("chat-model-agent-picker")).toHaveCount(
		1
	);
});
