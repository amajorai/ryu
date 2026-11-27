import { describe, expect, test } from "bun:test";
import {
	blobFromDataUrl,
	blobFromFileUrl,
	isInlineFileUrl,
	type SaveBlobEnvironment,
	saveBlobAs,
} from "./file-card-download.ts";

describe("blobFromDataUrl", () => {
	test("decodes a base64 payload with its type", async () => {
		const blob = blobFromDataUrl("data:text/plain;base64,aGVsbG8=");
		// Some runtimes append a charset to text types.
		expect(blob?.type.startsWith("text/plain")).toBe(true);
		expect(await blob?.text()).toBe("hello");
	});

	test("keeps binary bytes exact", async () => {
		// 0x00 0xFF 0x10 0x80
		const blob = blobFromDataUrl("data:application/pdf;base64,AP8QgA==");
		const bytes = new Uint8Array((await blob?.arrayBuffer()) ?? []);
		expect([...bytes]).toEqual([0, 255, 16, 128]);
		expect(blob?.type).toBe("application/pdf");
	});

	test("decodes a percent-encoded payload and drops type parameters", async () => {
		const blob = blobFromDataUrl("data:text/csv;charset=utf-8,a%2Cb");
		expect(blob?.type).toBe("text/csv");
		expect(await blob?.text()).toBe("a,b");
	});

	test("falls back to a neutral type", () => {
		expect(blobFromDataUrl("data:;base64,AAAA")?.type).toBe(
			"application/octet-stream"
		);
	});

	test("is null for other URLs and broken payloads", () => {
		expect(blobFromDataUrl("https://example.com/a.pdf")).toBeNull();
		expect(blobFromDataUrl("data:text/plain")).toBeNull();
		expect(blobFromDataUrl("data:text/plain;base64,@@@")).toBeNull();
	});
});

describe("blobFromFileUrl", () => {
	test("never calls the network for a data URL", async () => {
		let calls = 0;
		const fetcher = (() => {
			calls += 1;
			return Promise.resolve(new Response("x"));
		}) as unknown as typeof fetch;
		const blob = await blobFromFileUrl(
			"data:text/plain;base64,aGVsbG8=",
			fetcher
		);
		expect(await blob?.text()).toBe("hello");
		expect(calls).toBe(0);
	});

	test("reads a blob URL without credentials", async () => {
		const seen: { init?: RequestInit; url: string }[] = [];
		const fetcher = ((url: string, init?: RequestInit) => {
			seen.push({ init, url });
			return Promise.resolve(new Response("bytes"));
		}) as unknown as typeof fetch;
		const blob = await blobFromFileUrl("blob:app/1", fetcher);
		expect(await blob?.text()).toBe("bytes");
		expect(seen).toEqual([
			{ init: { credentials: "omit" }, url: "blob:app/1" },
		]);
	});

	test.each([
		"https://example.com/a.bin",
		"http://192.168.1.1/admin",
		"/api/spaces/s/documents/d/blob",
		"HTTPS://example.com/a.bin",
		"//example.com/a.bin",
		"file:///C:/Windows/win.ini",
		" blob:app/1",
	])("never requests the address %s", async (url) => {
		let calls = 0;
		const fetcher = (() => {
			calls += 1;
			return Promise.resolve(new Response("x"));
		}) as unknown as typeof fetch;
		expect(await blobFromFileUrl(url, fetcher)).toBeNull();
		expect(calls).toBe(0);
	});

	test("is null when the request fails or is refused", async () => {
		const refused = (() =>
			Promise.resolve(
				new Response("no", { status: 403 })
			)) as unknown as typeof fetch;
		const broken = (() =>
			Promise.reject(new Error("offline"))) as unknown as typeof fetch;
		expect(await blobFromFileUrl("blob:app/1", refused)).toBeNull();
		expect(await blobFromFileUrl("blob:app/1", broken)).toBeNull();
	});
});

describe("isInlineFileUrl", () => {
	test("admits data and blob URLs only", () => {
		expect(isInlineFileUrl("data:application/pdf;base64,AAAA")).toBe(true);
		expect(isInlineFileUrl("blob:app/1")).toBe(true);
		expect(isInlineFileUrl("https://example.com/a.pdf")).toBe(false);
		expect(isInlineFileUrl("/api/spaces/s/documents/d/blob")).toBe(false);
		expect(isInlineFileUrl("")).toBe(false);
	});
});

interface FakeLink {
	clicked: number;
	download: string;
	hidden: boolean;
	href: string;
	rel: string;
	removed: boolean;
}

function fakeEnvironment() {
	const links: FakeLink[] = [];
	const appended: FakeLink[] = [];
	const revoked: string[] = [];
	const scheduled: (() => void)[] = [];
	const handed: Blob[] = [];
	const document = {
		body: {
			append: (link: FakeLink) => {
				appended.push(link);
			},
		},
		createElement: () => {
			const link: FakeLink & { click: () => void; remove: () => void } = {
				click: () => {
					link.clicked += 1;
				},
				clicked: 0,
				download: "",
				hidden: false,
				href: "",
				rel: "",
				remove: () => {
					link.removed = true;
				},
				removed: false,
			};
			links.push(link);
			return link;
		},
	};
	const environment = {
		createObjectURL: (blob: Blob) => {
			handed.push(blob);
			return "blob:story/1";
		},
		document,
		revokeObjectURL: (url: string) => {
			revoked.push(url);
		},
		schedule: (run: () => void) => {
			scheduled.push(run);
		},
	} as unknown as SaveBlobEnvironment;
	return { appended, environment, handed, links, revoked, scheduled };
}

describe("saveBlobAs", () => {
	test("clicks a hidden download link and revokes the URL later", () => {
		const fake = fakeEnvironment();
		const name = saveBlobAs(
			new Blob(["x"], { type: "application/pdf" }),
			"Q3 report.pdf",
			fake.environment
		);
		expect(name).toBe("Q3 report.pdf");
		expect(fake.links).toHaveLength(1);
		const link = fake.links[0];
		expect(link?.href).toBe("blob:story/1");
		expect(link?.download).toBe("Q3 report.pdf");
		expect(link?.hidden).toBe(true);
		expect(link?.clicked).toBe(1);
		expect(link?.removed).toBe(true);
		expect(fake.appended).toHaveLength(1);
		// Not revoked until the scheduled clean-up runs.
		expect(fake.revoked).toEqual([]);
		for (const run of fake.scheduled) {
			run();
		}
		expect(fake.revoked).toEqual(["blob:story/1"]);
	});

	test("hands the browser neutral bytes, so an agent's page can never open as a page", async () => {
		const fake = fakeEnvironment();
		const page = "<script>alert(1)</script>";
		const name = saveBlobAs(
			new Blob([page], { type: "text/html" }),
			"invoice",
			fake.environment
		);
		// The name still follows the type the agent gave.
		expect(name).toBe("invoice.html");
		expect(fake.handed).toHaveLength(1);
		expect(fake.handed[0]?.type).toBe("application/octet-stream");
		expect(await fake.handed[0]?.text()).toBe(page);
	});

	test.each([
		["../../../Windows/System32/evil.dll", "evil.dll"],
		["C:\\Users\\dana\\AppData\\Startup\\run.bat", "run.bat"],
		["/etc/cron.d/job", "job.txt"],
		["", "download.txt"],
	])("suggests a bare name for %s", (title, expected) => {
		const fake = fakeEnvironment();
		const name = saveBlobAs(
			new Blob(["x"], { type: "text/plain" }),
			title,
			fake.environment
		);
		expect(name).toBe(expected);
		expect(fake.links[0]?.download).toBe(expected);
		expect(name).not.toMatch(/[\\/:]/u);
	});
});
