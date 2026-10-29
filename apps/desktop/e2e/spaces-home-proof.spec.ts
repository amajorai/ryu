import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const updatedAt = Date.parse("2026-09-14T08:00:00Z");

test("renders the shared-context Space home and filters its files table", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/spaces-home-proof.html");

	await expect(page.getByTestId("spaces-hero")).toBeVisible();
	await expect(page.getByTestId("space-upload-panel")).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Drop files here/ })
	).toBeVisible();
	await expect(
		page.getByText("Ingest a document", { exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "New" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Recent" })).toBeVisible();
	await expect(
		page.getByRole("textbox", { name: "Search documents" })
	).toBeVisible();
	await expect(page.getByRole("tab", { name: "Pinned" })).toBeVisible();
	await expect(page.getByRole("tab", { name: "Shared with Me" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Create Blank document" })
	).toBeVisible();
	await page.getByRole("tab", { name: "Pinned" }).click();
	await expect(
		page.getByText("No pinned pages yet.", { exact: true })
	).toBeVisible();
	await page.getByRole("tab", { name: "Recent" }).click();
	await expect(
		page
			.getByTestId("spaces-recent-pages")
			.getByRole("button", { name: "Open Launch brief" })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Files", exact: true })
	).toBeVisible();

	const table = page.getByRole("table", { name: "Files in this Space" });
	await expect(table).toBeVisible();
	await expect(
		table.getByText("Research synthesis.pdf", { exact: true })
	).toBeVisible();
	await expect(
		table.getByRole("cell", { name: "PDF", exact: true })
	).toBeVisible();

	await page.getByRole("textbox", { name: "Search files" }).fill("roadmap");
	await expect(table.getByText("Q4 roadmap", { exact: true })).toBeVisible();
	await expect(table.getByText("Launch brief", { exact: true })).toHaveCount(0);
	await expect(page.getByText("1 of 5 visible", { exact: true })).toBeVisible();

	await page
		.getByRole("textbox", { name: "Search files" })
		.fill("does-not-exist");
	await expect(page.getByText("0 of 5 visible", { exact: true })).toBeVisible();

	await page.getByRole("textbox", { name: "Search files" }).fill("research");
	await expect(
		table.getByText("Research synthesis.pdf", { exact: true })
	).toBeVisible();
	await expect(page.getByText("1 of 5 visible", { exact: true })).toBeVisible();

	await page.getByRole("textbox", { name: "Search files" }).fill("");
	await page
		.getByTestId("spaces-recent-pages")
		.getByRole("button", { name: "Open Launch brief" })
		.click();
	await expect(page.getByLabel("Opened document")).toHaveText(
		"page_launch:Launch brief"
	);
	await page.getByRole("button", { name: "Create Blank document" }).click();
	await expect(page.getByLabel("Last action")).toHaveText("new-page");
	expect(errors).toEqual([]);

	const proofPath = path.join(
		import.meta.dirname,
		"proof/spaces-home-proof.png"
	);
	await mkdir(path.dirname(proofPath), { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: proofPath,
	});
});

test("loads recent page previews through the live SpacesPage container", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const wireDocuments = [
		{
			chunk_count: 9,
			created_at: updatedAt,
			id: "page_launch",
			kind: "page",
			space_id: "space_product",
			title: "Launch brief",
			updated_at: updatedAt,
		},
		{
			chunk_count: 6,
			created_at: updatedAt - 86_400_000,
			id: "page_roadmap",
			kind: "page",
			space_id: "space_product",
			title: "Q4 roadmap",
			updated_at: updatedAt - 86_400_000,
		},
		{
			chunk_count: 4,
			created_at: updatedAt - 172_800_000,
			id: "page_interviews",
			kind: "page",
			space_id: "space_product",
			title: "Interview notes",
			updated_at: updatedAt - 172_800_000,
		},
		{
			byte_size: 2_621_440,
			chunk_count: 12,
			created_at: updatedAt - 259_200_000,
			id: "file_research",
			kind: "file",
			mime: "application/pdf",
			space_id: "space_product",
			title: "Research synthesis.pdf",
			updated_at: updatedAt - 259_200_000,
		},
		{
			chunk_count: 18,
			created_at: updatedAt - 345_600_000,
			id: "db_feedback",
			kind: "database",
			space_id: "space_product",
			title: "Feedback tracker",
			updated_at: updatedAt - 345_600_000,
		},
	];
	const sources = new Map<string, string>(
		Object.entries({
			page_interviews:
				"# Interview notes\n\nCustomers want the answer and the source together.",
			page_launch:
				"# Launch brief\n\nThe next release should feel calm, fast, and grounded in the work already done.\n\n- Make the first run obvious",
			page_roadmap:
				"# Q4 roadmap\n\nA small set of durable bets for the quarter.",
		})
	);

	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (!url.pathname.startsWith("/alpha/api/")) {
			return route.continue();
		}
		if (url.pathname === "/alpha/api/spaces") {
			return route.fulfill({
				json: {
					spaces: [
						{
							created_at: updatedAt,
							description:
								"Product decisions, launch notes, and the research behind them.",
							document_count: 5,
							id: "space_product",
							name: "Product research",
							retrieval_mode: "vector",
							system: false,
							updated_at: updatedAt,
							visibility: "private",
						},
					],
				},
			});
		}
		if (url.pathname === "/alpha/api/spaces/space_product/documents") {
			return route.fulfill({ json: { documents: wireDocuments } });
		}
		if (
			url.pathname === "/alpha/api/spaces/space_product/files" &&
			route.request().method() === "POST"
		) {
			return route.fulfill({
				json: {
					byte_size: 38,
					id: "file_uploaded",
					index: { message: null, state: "indexed", warnings: [] },
					mime: "text/markdown",
				},
			});
		}
		const documentMatch = url.pathname.match(
			/^\/alpha\/api\/spaces\/space_product\/documents\/([^/]+)$/
		);
		if (documentMatch) {
			const document = wireDocuments.find(
				(item) => item.id === documentMatch[1]
			);
			return route.fulfill({
				json: {
					...document,
					source: sources.get(documentMatch[1]) ?? "",
				},
			});
		}
		if (url.pathname.endsWith("/backups")) {
			return route.fulfill({
				json: { destinations: [], operations: [], policies: [] },
			});
		}
		if (url.pathname.endsWith("/imports")) {
			return route.fulfill({
				json: { imports: [], space_id: "space_product" },
			});
		}
		return route.fulfill({ json: {} });
	});

	await page.goto("/spaces-home-proof.html?live");
	await expect(page.getByLabel("Live spaces loaded")).toHaveText("1");
	await expect(page.getByTestId("spaces-hero")).toBeVisible();
	await expect(page.getByTestId("space-upload-panel")).toBeVisible();
	const dropzone = page
		.getByTestId("space-upload-panel")
		.getByRole("button", { name: /Drop files here/ });
	await dropzone.locator('input[type="file"]').setInputFiles({
		buffer: Buffer.from("# Uploaded notes\n\nThrough the Space drop zone."),
		mimeType: "text/markdown",
		name: "uploaded-notes.md",
	});
	await expect(
		page.getByTestId("space-upload-panel").getByText("uploaded-notes.md")
	).toBeVisible();
	await expect(
		page.getByTestId("space-upload-panel").getByText("Stored and searchable")
	).toBeVisible();
	await expect(
		page.getByText(
			"The next release should feel calm, fast, and grounded in the work already done.",
			{ exact: true }
		)
	).toBeVisible();
	await expect(
		page
			.getByRole("table", { name: "Files in this Space" })
			.getByText("Research synthesis.pdf", { exact: true })
	).toBeVisible();
	expect(errors).toEqual([]);

	const proofPath = path.join(
		import.meta.dirname,
		"proof/spaces-home-live-proof.png"
	);
	await mkdir(path.dirname(proofPath), { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: proofPath,
	});
});

test("keeps the paper previews and file actions usable on a narrow screen", async ({
	page,
}) => {
	await page.setViewportSize({ height: 844, width: 390 });
	await page.goto("/spaces-home-proof.html");

	await expect(page.getByRole("heading", { name: "Recent" })).toBeVisible();
	await expect(
		page
			.getByTestId("spaces-recent-pages")
			.getByRole("button", { name: "Open Launch brief" })
	).toBeVisible();
	await expect(
		page.getByRole("table", { name: "Files in this Space" })
	).toBeHidden();
	await expect(
		page
			.getByTestId("spaces-files-table")
			.getByRole("button", { name: "Open Research synthesis.pdf" })
	).toBeVisible();
});
