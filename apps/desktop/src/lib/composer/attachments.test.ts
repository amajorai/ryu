import { describe, expect, test } from "bun:test";
import {
	isTextAttachmentFile,
	readTextAttachment,
} from "@/src/lib/composer/attachments.ts";

function decodeDataUrl(url: string): string {
	const base64 = url.slice(url.indexOf(",") + 1);
	const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

describe("readTextAttachment", () => {
	test("rejects binary content behind a text extension", async () => {
		const file = new File([new Uint8Array([0x00, 0x01, 0xff])], "notes.txt", {
			type: "text/plain",
		});
		await expect(readTextAttachment(file)).rejects.toThrow(
			"doesn't look like a text file"
		);
	});

	test("rejects invalid UTF-8 without NUL bytes", async () => {
		const file = new File([new Uint8Array([0x41, 0xff, 0xfe, 0x42])], "a.log");
		await expect(readTextAttachment(file)).rejects.toThrow(
			"doesn't look like a text file"
		);
	});

	test("keeps TypeScript sources typed as video/mp2t", async () => {
		const file = new File(["// TS\nconst x = 1;"], "main.ts", {
			type: "video/mp2t",
		});
		expect(isTextAttachmentFile(file)).toBe(true);
		const staged = await readTextAttachment(file);
		expect(decodeDataUrl(staged.url)).toBe("// TS\nconst x = 1;");
	});

	test("round-trips multibyte UTF-8 as text/plain", async () => {
		const source = 'fn main() { println!("héllo ✓"); }';
		const staged = await readTextAttachment(new File([source], "main.rs"));
		expect(staged.mimeType).toBe("text/plain");
		expect(decodeDataUrl(staged.url)).toBe(source);
	});

	test("accepts a multibyte character split by the sample boundary", async () => {
		const source = `${"a".repeat(8191)}✓ tail`;
		const staged = await readTextAttachment(new File([source], "notes.md"));
		expect(decodeDataUrl(staged.url)).toBe(source);
	});
});
