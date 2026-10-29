import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import type { UploadCall } from "./spaces-upload-native-http.host.ts";

interface Snapshot {
	calls: UploadCall[];
	documents: Array<{
		id: string;
		title: string;
		mime: string;
		byte_size: number;
		data_base64: string;
		index: { state: string };
	}>;
	held: boolean;
	unexpected: string[];
}
async function state(request: APIRequestContext): Promise<Snapshot> {
	const response = await request.get("http://127.0.0.1:5711/__state");
	expect(response.ok()).toBe(true);
	return response.json();
}
async function control(
	request: APIRequestContext,
	action: string,
	title?: string
) {
	const response = await request.post("http://127.0.0.1:5711/__control", {
		headers: { "x-proof-control": "owned-fixture" },
		data: { action, title },
	});
	expect(response.ok()).toBe(true);
}
const uploads = (snapshot: Snapshot) =>
	snapshot.calls.filter(
		(call) =>
			call.method === "POST" && call.path === "/api/spaces/space-owned/files"
	);
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
	const rows: string[] = [];
	errors.set(page, rows);
	page.on("pageerror", (error) => rows.push(error.message));
});
test.afterEach(async ({ page, request }) => {
	const snapshot = await state(request);
	if (snapshot.held) {
		await control(request, "release");
	}
	expect(snapshot.unexpected).toEqual([]);
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__spacesUploadNativeUnexpected")
		)
	).toEqual([]);
	expect(errors.get(page)).toEqual([]);
});
// Host processes are new per config. Each case uses unique names and asserts its
// exact request slice against the preceding ledger, rather than clearing evidence.
test("real dropzone serializes held files, stores exact bytes and reads indexed versus unsearchable outcomes after reload", async ({
	page,
	request,
}) => {
	const before = await state(request);
	const offset = uploads(before).length;
	await control(request, "hold");
	await page.goto("/spaces-upload-native-http.html");
	await expect(page.getByTestId("space-count")).toHaveText(
		`${before.documents.length} documents`
	);
	const listReads = (await state(request)).calls.filter(
		(call) => call.method === "GET" && call.path === "/api/spaces"
	).length;
	const first = Buffer.from("indexed UTF8 \u2603\n");
	const second = Buffer.from([0, 255, 42, 128]);
	await page.locator('input[type="file"]').setInputFiles([
		{ name: "serial-indexed.txt", mimeType: "text/plain", buffer: first },
		{
			name: "serial-binary.bin",
			mimeType: "application/octet-stream",
			buffer: second,
		},
	]);
	await expect
		.poll(async () => uploads(await state(request)).length - offset)
		.toBe(1);
	expect((await state(request)).documents).toEqual(before.documents);
	await expect(
		page.getByText("serial-binary.bin", { exact: true })
	).toBeVisible();
	await control(request, "release");
	await expect(
		page.getByText("Stored and searchable", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Stored — this node cannot read this format yet", {
			exact: true,
		})
	).toBeVisible();
	await expect(
		page.getByRole("list", { name: "Persisted documents" })
	).toContainText("serial-indexed.txt");
	await expect(
		page.getByRole("list", { name: "Persisted documents" })
	).toContainText("serial-binary.bin");
	const saved = await state(request);
	expect(
		uploads(saved)
			.slice(offset)
			.map((call) => ({
				body: call.body,
				status: call.status,
				authorization: call.authorization,
				userJwt: call.userJwt,
				clientLabel: call.clientLabel,
				surface: call.surface,
			}))
	).toEqual(
		[
			{
				title: "serial-indexed.txt",
				mime: "text/plain",
				data_base64: first.toString("base64"),
			},
			{
				title: "serial-binary.bin",
				mime: "application/octet-stream",
				data_base64: second.toString("base64"),
			},
		].map((body) => ({
			body,
			status: 200,
			authorization: "Bearer spaces-upload-owned-token",
			userJwt: null,
			clientLabel: "Desktop",
			surface: "desktop",
		}))
	);
	expect(
		uploads(saved)
			.slice(offset)
			.every(
				(call) => typeof call.clientId === "string" && call.clientId.length > 0
			)
	).toBe(true);
	expect(
		saved.documents.slice(before.documents.length).map((row) => ({
			title: row.title,
			data: row.data_base64,
			state: row.index.state,
		}))
	).toEqual([
		{
			title: "serial-indexed.txt",
			data: first.toString("base64"),
			state: "indexed",
		},
		{
			title: "serial-binary.bin",
			data: second.toString("base64"),
			state: "skipped",
		},
	]);
	expect(
		saved.calls.filter(
			(call) => call.method === "GET" && call.path === "/api/spaces"
		).length - listReads
	).toBe(1);
	await page.reload();
	await expect(
		page.getByRole("list", { name: "Persisted documents" })
	).toContainText("serial-binary.bin");
	await expect(page.getByTestId("space-count")).toHaveText(
		`${saved.documents.length} documents`
	);
});
test("real storage503 keeps a retryable queue row and identical bytes retry persists exactly once with fresh document GET", async ({
	page,
	request,
}) => {
	const before = await state(request);
	const offset = uploads(before).length;
	await control(request, "refuse", "refused.txt");
	await page.goto("/spaces-upload-native-http.html");
	await expect(page.getByTestId("space-count")).toHaveText(
		`${before.documents.length} documents`
	);
	const bytes = Buffer.from("retry original exact contents");
	await page.locator('input[type="file"]').setInputFiles({
		name: "refused.txt",
		mimeType: "text/plain",
		buffer: bytes,
	});
	await expect(
		page.getByText("Storage temporarily refused", { exact: true })
	).toBeVisible();
	expect((await state(request)).documents).toEqual(before.documents);
	await control(request, "allow");
	await page
		.getByRole("button", { name: "Retry refused.txt", exact: true })
		.click();
	await expect(
		page.getByText("Stored and searchable", { exact: true })
	).toBeVisible();
	const saved = await state(request);
	expect(
		uploads(saved)
			.slice(offset)
			.map((call) => ({ body: call.body, status: call.status }))
	).toEqual(
		[503, 200].map((status) => ({
			body: {
				title: "refused.txt",
				mime: "text/plain",
				data_base64: bytes.toString("base64"),
			},
			status,
		}))
	);
	expect(
		saved.documents.filter((row) => row.title === "refused.txt")
	).toHaveLength(1);
	expect(saved.documents.at(-1)?.data_base64).toBe(bytes.toString("base64"));
	await page.reload();
	await expect(
		page.getByRole("list", { name: "Persisted documents" })
	).toContainText("refused.txt");
	await expect(page.getByTestId("space-count")).toHaveText(
		`${saved.documents.length} documents`
	);
});
test("oversized physical selection creates a removable error row without transmitting or persisting bytes", async ({
	page,
	request,
}) => {
	const before = await state(request);
	await page.goto("/spaces-upload-native-http.html");
	await expect(page.getByTestId("space-count")).toHaveText(
		`${before.documents.length} documents`
	);
	await page.locator('input[type="file"]').setInputFiles({
		name: "oversized.bin",
		mimeType: "application/octet-stream",
		buffer: Buffer.alloc(32 * 1024 * 1024 + 1),
	});
	await expect(
		page.getByText("Too large — the limit is 32 MB.", { exact: true })
	).toBeVisible();
	expect(uploads(await state(request))).toEqual(uploads(before));
	expect((await state(request)).documents).toEqual(before.documents);
	// The immutable oversized file cannot become uploadable through Retry.
	await expect(
		page.getByRole("button", { name: "Retry oversized.bin", exact: true })
	).toHaveCount(0);
	await page
		.getByRole("button", { name: "Remove oversized.bin", exact: true })
		.click();
	await expect(page.getByText("oversized.bin", { exact: true })).toHaveCount(0);
});
