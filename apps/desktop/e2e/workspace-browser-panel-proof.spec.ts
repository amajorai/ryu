import path from "node:path";
import { expect, test } from "@playwright/test";

interface CapturedRequest {
	authorization: string | null;
	body: unknown;
	contentType: string | null;
	method: string;
	path: string;
	status: number | null;
}

interface FixtureTab {
	id: string;
	title: string;
	url: string;
}

interface FixtureAnnotation {
	comment: string;
	created_at: string;
	id: string;
	kind: "area" | "element" | "elements";
	rect: { height: number; width: number; x: number; y: number };
	style?: Record<string, string>;
	targets: unknown[];
}

interface BrowserProofSnapshot {
	annotations: Record<string, FixtureAnnotation[]>;
	assistant: { mode: string; pendingPrompt: string | null };
	requests: CapturedRequest[];
	tabs: FixtureTab[];
	unexpectedRoutes: string[];
}

interface BrowserProofWindow {
	__workspaceBrowserPanelProof: {
		armNextFailure: (method: string, path: string) => void;
		snapshot: () => BrowserProofSnapshot;
	};
}

const STORY_URL = "/workspace-browser-panel-proof.html";
const BROWSER_API = "/api/ext/@ryu/browser";
const TABS_PATH = `${BROWSER_API}/tabs`;
const TOKEN = "workspace-browser-proof-token";
const INITIAL_TAB = {
	id: "browser-proof-start",
	title: "Workspace start page",
	url: "https://workspace.example.test/start",
};
const NEW_TAB = {
	id: "browser-proof-new-tab",
	title: "Workspace project preview",
	url: "https://workspace.example.test/projects/launch",
};
const NOTE_COMMENT = "Make the project action easier to spot.";
const NOTE_STYLE = { color: "#0f172a", font_size: "18px" };

function evidencePath(name: string): string {
	return path.resolve(
		import.meta.dirname,
		`../../../docs/proof/test-coverage-sweep-20260924/evidence/${name}.png`
	);
}

async function openPanel(page: import("@playwright/test").Page): Promise<void> {
	await page.route("**/*", async (route) => {
		const hostname = new URL(route.request().url()).hostname;
		if (hostname === "127.0.0.1" || hostname === "localhost") {
			await route.continue();
			return;
		}
		await route.abort();
	});
	await page.goto(`${STORY_URL}?reset=true`, {
		waitUntil: "domcontentloaded",
	});
	await expect(
		page.getByRole("heading", { name: "Workspace browser panel" })
	).toBeVisible();
	await expect(page).toHaveURL(/\/workspace-browser-panel-proof\.html$/);
	const toggleButtons = page
		.getByTestId("workspace-panel-toggles")
		.getByRole("button");
	await expect(toggleButtons).toHaveCount(3);
	const pinnedSummaryToggle = toggleButtons.nth(0);
	await pinnedSummaryToggle.hover();
	await expect(
		page.getByText("Hide pinned summary", { exact: true })
	).toBeVisible();
	await pinnedSummaryToggle.click();
	await expect(page.getByTestId("workspace-panel-state")).toHaveAttribute(
		"data-pinned-summary-open",
		"false"
	);

	const bottomToggle = toggleButtons.nth(1);
	await bottomToggle.hover();
	await expect(
		page.getByText("Show bottom panel", { exact: true })
	).toBeVisible();
	await bottomToggle.click();
	await expect(page.getByTestId("workspace-panel-state")).toHaveAttribute(
		"data-bottom-open",
		"true"
	);

	const rightToggle = toggleButtons.nth(2);
	await rightToggle.hover();
	await expect(
		page.getByText("Show right panel", { exact: true })
	).toBeVisible();
	await rightToggle.click();
	await expect(page.getByTestId("workspace-panel-state")).toHaveAttribute(
		"data-right-open",
		"true"
	);
	await expect(
		page.getByPlaceholder("Open a URL in the browser sidecar…")
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: INITIAL_TAB.title, exact: true })
	).toBeVisible();
	await expect(page.getByTestId("browser-annotation-frame")).toBeVisible();
}

async function readProof(
	page: import("@playwright/test").Page
): Promise<BrowserProofSnapshot> {
	return page.evaluate(() =>
		/* SAFETY: workspace-browser-panel-proof.tsx installs __workspaceBrowserPanelProof before this proof page is evaluated. */ (
			window as Window & BrowserProofWindow
		).__workspaceBrowserPanelProof.snapshot()
	);
}

function requestsFor(
	snapshot: BrowserProofSnapshot,
	method: string,
	path: string
): CapturedRequest[] {
	return snapshot.requests.filter(
		(request) => request.method === method && request.path === path
	);
}

function requestContract(request: CapturedRequest) {
	return {
		authorization: request.authorization,
		body: request.body,
		contentType: request.contentType,
		method: request.method,
		path: request.path,
		status: request.status,
	};
}

async function armFailure(
	page: import("@playwright/test").Page,
	method: string,
	path: string
): Promise<void> {
	await page.evaluate(
		({ method, path }) => {
			/* SAFETY: workspace-browser-panel-proof.tsx installs __workspaceBrowserPanelProof before this proof page is evaluated. */ (
				window as Window & BrowserProofWindow
			).__workspaceBrowserPanelProof.armNextFailure(method, path);
		},
		{ method, path }
	);
}

function projectedPoint(
	point: { x: number; y: number },
	frame: { height: number; width: number; x: number; y: number }
) {
	return {
		x: Math.min(Math.max(((point.x - frame.x) / frame.width) * 1440, 0), 1440),
		y: Math.min(Math.max(((point.y - frame.y) / frame.height) * 900, 0), 900),
	};
}

test.describe.configure({ mode: "serial", timeout: 90_000 });

test("opens, retries, annotates, reads back, and closes a local browser workspace tab", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openPanel(page);

	const initial = await readProof(page);
	expect(initial.tabs).toEqual([INITIAL_TAB]);
	const initialListRead = requestsFor(initial, "GET", TABS_PATH).at(-1);
	expect(initialListRead).toMatchObject({
		authorization: `Bearer ${TOKEN}`,
		body: null,
		method: "GET",
		path: TABS_PATH,
		status: 200,
	});
	expect(initial.unexpectedRoutes).toEqual([]);

	const urlInput = page.getByPlaceholder("Open a URL in the browser sidecar…");
	await armFailure(page, "POST", TABS_PATH);
	await urlInput.fill("workspace.example.test/projects/launch");
	await urlInput.press("Enter");
	await expect(page.getByText("503", { exact: true })).toBeVisible();
	await expect(urlInput).toHaveValue("workspace.example.test/projects/launch");
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("workspace-browser-panel-open-error-retry"),
	});

	await urlInput.press("Enter");
	await expect(urlInput).toHaveValue("");
	const newTabButton = page.getByRole("button", {
		name: NEW_TAB.title,
		exact: true,
	});
	await expect(newTabButton).toBeVisible();
	await expect(page.getByTestId("browser-annotation-frame")).toBeVisible();
	const opened = await readProof(page);
	expect(opened.tabs).toEqual([INITIAL_TAB, NEW_TAB]);
	expect(requestsFor(opened, "POST", TABS_PATH).map(requestContract)).toEqual([
		{
			authorization: `Bearer ${TOKEN}`,
			body: { url: NEW_TAB.url },
			contentType: "application/json",
			method: "POST",
			path: TABS_PATH,
			status: 503,
		},
		{
			authorization: `Bearer ${TOKEN}`,
			body: { url: NEW_TAB.url },
			contentType: "application/json",
			method: "POST",
			path: TABS_PATH,
			status: 201,
		},
	]);
	await expect(page.getByText("503", { exact: true })).toHaveCount(0);

	const refresh = page.getByRole("button", { name: "Refresh", exact: true });
	const listReadCount = requestsFor(
		await readProof(page),
		"GET",
		TABS_PATH
	).length;
	await refresh.click();
	await expect
		.poll(
			async () => requestsFor(await readProof(page), "GET", TABS_PATH).length
		)
		.toBe(listReadCount + 1);

	const initialTabRow = page
		.locator("li")
		.filter({ hasText: INITIAL_TAB.title });
	await initialTabRow
		.getByRole("button", { name: INITIAL_TAB.title, exact: true })
		.click();
	await expect(newTabButton).toBeVisible();
	const startScreenshotPath = `${BROWSER_API}/tabs/${INITIAL_TAB.id}/screenshot`;
	const startShotCount = requestsFor(
		await readProof(page),
		"POST",
		startScreenshotPath
	).length;
	await expect
		.poll(
			async () =>
				requestsFor(await readProof(page), "POST", startScreenshotPath).length
		)
		.toBeGreaterThan(startShotCount);
	await newTabButton.click();

	await initialTabRow.getByRole("button", { name: "×", exact: true }).click();
	await expect(initialTabRow).toHaveCount(0);
	await expect(newTabButton).toBeVisible();
	const afterCloseStart = await readProof(page);
	expect(afterCloseStart.tabs).toEqual([NEW_TAB]);
	expect(
		requestsFor(
			afterCloseStart,
			"DELETE",
			`${BROWSER_API}/tabs/${INITIAL_TAB.id}`
		).map(requestContract)
	).toEqual([
		{
			authorization: `Bearer ${TOKEN}`,
			body: null,
			contentType: "application/json",
			method: "DELETE",
			path: `${BROWSER_API}/tabs/${INITIAL_TAB.id}`,
			status: 200,
		},
	]);

	const surface = page.getByTestId("browser-annotation-surface");
	await surface.getByRole("button", { name: "Annotate", exact: true }).click();
	await expect(
		surface.getByRole("button", { name: "Annotation mode on", exact: true })
	).toBeVisible();
	await expect(
		surface.getByRole("textbox", { name: "Annotation comment" })
	).toHaveCount(0);
	const newContextPath = `${BROWSER_API}/tabs/${NEW_TAB.id}/context`;
	await expect
		.poll(
			async () =>
				requestsFor(await readProof(page), "POST", newContextPath).length
		)
		.toBeGreaterThan(0);
	const initialContextRequest = requestsFor(
		await readProof(page),
		"POST",
		newContextPath
	).at(-1);
	expect(initialContextRequest?.body).toEqual({
		include_screenshot: true,
		selections: [],
	});

	const frame = surface.getByTestId("browser-annotation-frame");
	await expect(frame.getByRole("img", { name: NEW_TAB.title })).toBeVisible();
	const frameBox = await frame.boundingBox();
	expect(frameBox).not.toBeNull();
	if (!frameBox) {
		throw new Error("The rendered browser screenshot has no measurable frame.");
	}
	const start = {
		x: Math.round(frameBox.x + frameBox.width * 0.16),
		y: Math.round(frameBox.y + frameBox.height * 0.2),
	};
	const end = {
		x: Math.round(frameBox.x + frameBox.width * 0.72),
		y: Math.round(frameBox.y + frameBox.height * 0.7),
	};
	const projectedStart = projectedPoint(start, frameBox);
	const projectedEnd = projectedPoint(end, frameBox);
	const selection = {
		height: Math.abs(projectedEnd.y - projectedStart.y),
		width: Math.abs(projectedEnd.x - projectedStart.x),
		x: Math.min(projectedStart.x, projectedEnd.x),
		y: Math.min(projectedStart.y, projectedEnd.y),
	};
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(end.x, end.y);
	await page.mouse.up();
	const comment = surface.getByRole("textbox", { name: "Annotation comment" });
	await expect(comment).toBeVisible();
	const addNote = surface.getByRole("button", {
		name: "Add note",
		exact: true,
	});
	await expect(addNote).toBeDisabled();
	await expect
		.poll(
			async () =>
				requestsFor(await readProof(page), "POST", newContextPath).length
		)
		.toBeGreaterThan(1);
	expect(
		requestsFor(await readProof(page), "POST", newContextPath).at(-1)?.body
	).toEqual({
		include_screenshot: true,
		selections: [selection],
	});

	await comment.fill(NOTE_COMMENT);
	await surface.getByRole("button", { name: "Adjust styling" }).click();
	await surface.getByLabel("Font size").fill(NOTE_STYLE.font_size);
	await surface.getByLabel("Text color").fill(NOTE_STYLE.color);
	await expect(addNote).toBeEnabled();
	const annotationPath = `${BROWSER_API}/tabs/${NEW_TAB.id}/annotations`;
	const annotationBody = {
		comment: NOTE_COMMENT,
		kind: "area",
		rect: selection,
		selections: [selection],
		style: NOTE_STYLE,
	};
	await armFailure(page, "POST", annotationPath);
	await addNote.click();
	await expect(page.getByText("503", { exact: true })).toBeVisible();
	await expect(comment).toHaveValue(NOTE_COMMENT);
	await expect(addNote).toBeEnabled();
	const failedAnnotationState = await readProof(page);
	expect(failedAnnotationState.annotations[NEW_TAB.id]).toEqual([]);
	const failedAnnotationWrite = requestsFor(
		failedAnnotationState,
		"POST",
		annotationPath
	);
	expect(failedAnnotationWrite.map(requestContract)).toEqual([
		{
			authorization: `Bearer ${TOKEN}`,
			body: annotationBody,
			contentType: "application/json",
			method: "POST",
			path: annotationPath,
			status: 503,
		},
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("workspace-browser-panel-note-error-retry"),
	});

	await addNote.click();
	await expect(
		surface.getByTestId("browser-annotation-marker-1")
	).toBeVisible();
	await expect(page.getByText("503", { exact: true })).toHaveCount(0);
	const savedAnnotation = await readProof(page);
	expect(
		requestsFor(savedAnnotation, "POST", annotationPath).map(requestContract)
	).toEqual([
		{
			authorization: `Bearer ${TOKEN}`,
			body: annotationBody,
			contentType: "application/json",
			method: "POST",
			path: annotationPath,
			status: 503,
		},
		{
			authorization: `Bearer ${TOKEN}`,
			body: annotationBody,
			contentType: "application/json",
			method: "POST",
			path: annotationPath,
			status: 201,
		},
	]);
	expect(savedAnnotation.annotations[NEW_TAB.id]).toMatchObject([
		{
			comment: NOTE_COMMENT,
			id: "browser-proof-annotation-1",
			kind: "area",
			rect: selection,
			style: NOTE_STYLE,
		},
	]);
	await surface
		.getByRole("button", { name: "Annotation mode on", exact: true })
		.click();
	await expect(surface.getByText(NOTE_COMMENT, { exact: true })).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("workspace-browser-panel-annotation-saved"),
	});

	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Workspace browser panel" })
	).toBeVisible();
	const persistedAfterReload = await readProof(page);
	expect(persistedAfterReload.tabs).toEqual([NEW_TAB]);
	expect(persistedAfterReload.annotations[NEW_TAB.id]).toMatchObject([
		{ comment: NOTE_COMMENT, id: "browser-proof-annotation-1" },
	]);
	await expect(page.getByTestId("workspace-panel-state")).toHaveAttribute(
		"data-bottom-open",
		"false"
	);
	await page
		.getByTestId("workspace-panel-toggles")
		.getByRole("button")
		.nth(1)
		.click();
	await expect(page.getByTestId("workspace-panel-state")).toHaveAttribute(
		"data-bottom-open",
		"true"
	);
	await expect(
		page.getByRole("button", { name: NEW_TAB.title, exact: true })
	).toBeVisible();
	await expect(page.getByTestId("browser-annotation-frame")).toBeVisible();
	const reloadedSurface = page.getByTestId("browser-annotation-surface");
	await reloadedSurface
		.getByRole("button", { name: "Annotate", exact: true })
		.click();
	await expect(
		reloadedSurface.getByTestId("browser-annotation-marker-1")
	).toBeVisible();
	await reloadedSurface
		.getByRole("button", { name: "Annotation mode on", exact: true })
		.click();
	await expect(
		reloadedSurface.getByText(NOTE_COMMENT, { exact: true })
	).toBeVisible();
	expect((await readProof(page)).annotations[NEW_TAB.id]).toMatchObject([
		{ comment: NOTE_COMMENT, id: "browser-proof-annotation-1" },
	]);

	await reloadedSurface
		.getByRole("button", { name: "Ask Ryu to address notes", exact: true })
		.click();
	expect((await readProof(page)).assistant).toEqual({
		mode: "sidebar",
		pendingPrompt:
			"Review the embedded browser context and every saved annotation. Address each requested visual change in the live tab, using the browser context, snapshot, and control tools as needed.",
	});

	await reloadedSurface
		.getByRole("button", { name: "Remove annotation 1", exact: true })
		.click();
	await expect(
		reloadedSurface.getByText(NOTE_COMMENT, { exact: true })
	).toHaveCount(0);
	const afterAnnotationDelete = await readProof(page);
	expect(afterAnnotationDelete.annotations[NEW_TAB.id]).toEqual([]);
	expect(
		requestsFor(
			afterAnnotationDelete,
			"DELETE",
			`${annotationPath}/browser-proof-annotation-1`
		).map(requestContract)
	).toEqual([
		{
			authorization: `Bearer ${TOKEN}`,
			body: null,
			contentType: "application/json",
			method: "DELETE",
			path: `${annotationPath}/browser-proof-annotation-1`,
			status: 200,
		},
	]);

	const newTabRow = page.locator("li").filter({ hasText: NEW_TAB.title });
	await newTabRow.getByRole("button", { name: "×", exact: true }).click();
	await expect(page.getByText("No open tabs.", { exact: true })).toBeVisible();
	const closed = await readProof(page);
	expect(closed.tabs).toEqual([]);
	expect(closed.annotations[NEW_TAB.id]).toBeUndefined();
	expect(closed.unexpectedRoutes).toEqual([]);
	expect(pageErrors).toEqual([]);
});

test("empty URL submit is inert and Refresh exposes and recovers a sidecar read error", async ({
	page,
}) => {
	await openPanel(page);
	const urlInput = page.getByPlaceholder("Open a URL in the browser sidecar…");
	await urlInput.press("Enter");
	expect(requestsFor(await readProof(page), "POST", TABS_PATH)).toEqual([]);

	await armFailure(page, "GET", TABS_PATH);
	const refresh = page.getByRole("button", { name: "Refresh", exact: true });
	await refresh.click();
	await expect(
		page.getByText("Browser sidecar unreachable (503)", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: INITIAL_TAB.title, exact: true })
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("workspace-browser-panel-refresh-error"),
	});

	await refresh.click();
	await expect(
		page.getByText("Browser sidecar unreachable (503)", { exact: true })
	).toHaveCount(0);
	const recovered = await readProof(page);
	const listReads = requestsFor(recovered, "GET", TABS_PATH);
	expect(listReads.slice(-2).map(requestContract)).toEqual([
		{
			authorization: `Bearer ${TOKEN}`,
			body: null,
			contentType: "application/json",
			method: "GET",
			path: TABS_PATH,
			status: 503,
		},
		{
			authorization: `Bearer ${TOKEN}`,
			body: null,
			contentType: "application/json",
			method: "GET",
			path: TABS_PATH,
			status: 200,
		},
	]);
	expect(recovered.tabs).toEqual([INITIAL_TAB]);
	expect(recovered.unexpectedRoutes).toEqual([]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("workspace-browser-panel-refresh-recovered"),
	});
});
