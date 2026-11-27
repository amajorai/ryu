import { describe, expect, test } from "bun:test";
import { assistantFileCardMeta } from "./assistant-file-meta.ts";

const PDF_BASE64 = "JVBERi0xLjc=";

describe("assistantFileCardMeta", () => {
	test("admits a document data URL that the media guard refuses", () => {
		const meta = assistantFileCardMeta({
			filename: "report.pdf",
			mediaType: "application/pdf",
			type: "file",
			url: `data:application/pdf;base64,${PDF_BASE64}`,
		});
		expect(meta).toEqual({
			filename: "report.pdf",
			media: "application/pdf",
			size: undefined,
			url: `data:application/pdf;base64,${PDF_BASE64}`,
		});
	});

	test("builds the data URL from a bare base64 payload", () => {
		const meta = assistantFileCardMeta({
			data: PDF_BASE64,
			mimeType: "application/pdf",
			name: "a.pdf",
			size: 8,
			type: "file",
		});
		expect(meta?.url).toBe(`data:application/pdf;base64,${PDF_BASE64}`);
		expect(meta?.filename).toBe("a.pdf");
		expect(meta?.size).toBe(8);
	});

	test("a part without a name reads Attachment", () => {
		const meta = assistantFileCardMeta({
			mediaType: "text/csv",
			type: "file",
			url: "data:text/csv;base64,YSxiCjEsMg==",
		});
		expect(meta?.filename).toBe("Attachment");
		expect(meta?.media).toBe("text/csv");
	});

	test("drops the parameters of the media type", () => {
		const meta = assistantFileCardMeta({
			mediaType: "Text/CSV; charset=utf-8",
			type: "file",
			url: "data:text/csv;charset=utf-8;base64,YSxi",
		});
		expect(meta?.media).toBe("text/csv");
	});

	test("keeps what the media guard already admits", () => {
		const meta = assistantFileCardMeta({
			filename: "notes.txt",
			mediaType: "text/plain",
			size: 12,
			type: "file",
			url: "https://files.example.com/notes.txt",
		});
		expect(meta).toEqual({
			filename: "notes.txt",
			media: "text/plain",
			size: 12,
			url: "https://files.example.com/notes.txt",
		});
	});

	test("leaves images, video and audio to their own renderers", () => {
		for (const mediaType of ["image/png", "video/mp4"]) {
			expect(
				assistantFileCardMeta({
					mediaType,
					type: "file",
					url: `data:${mediaType};base64,AAAA`,
				})
			).toBeNull();
		}
		// Audio with a URL the media guard refuses gets no card either.
		expect(
			assistantFileCardMeta({
				mediaType: "audio/mpeg",
				type: "file",
				url: "javascript:alert(1)",
			})
		).toBeNull();
	});

	test("refuses a URL that is neither safe media nor a base64 data URL", () => {
		for (const url of [
			"javascript:alert(1)",
			"file:///C:/Users/someone/secret.txt",
			"data:text/html,<script>alert(1)</script>",
			'data:application/pdf;base64,AAAA" onload="x',
			"data:application/pdf;base64,AA AA",
		]) {
			expect(
				assistantFileCardMeta({
					mediaType: "application/pdf",
					type: "file",
					url,
				})
			).toBeNull();
		}
	});

	test("ignores parts that are not files", () => {
		expect(assistantFileCardMeta(null)).toBeNull();
		expect(assistantFileCardMeta("file")).toBeNull();
		expect(assistantFileCardMeta({ text: "hello", type: "text" })).toBeNull();
		expect(
			assistantFileCardMeta({ type: "file", url: "data:;base64,AAAA" })
		).toBeNull();
	});
});
