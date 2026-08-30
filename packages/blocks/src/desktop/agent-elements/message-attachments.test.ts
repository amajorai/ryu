import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { getMessageAttachments } from "./message-attachments.ts";

function message(parts: unknown[], extra?: Record<string, unknown>): UIMessage {
	return {
		id: "message-1",
		parts,
		role: "user",
		...extra,
	} as unknown as UIMessage;
}

test("normalizes file parts with mediaType and preserves colored-icon metadata", () => {
	const attachments = getMessageAttachments(
		message([
			{
				fileName: "Startup Runway v2.0.pdf",
				mediaType: "application/pdf",
				size: 2048,
				type: "file",
				url: "https://example.test/runway.pdf",
			},
		])
	);

	expect(attachments).toEqual([
		{
			filename: "Startup Runway v2.0.pdf",
			id: "message-1-part-0",
			isImage: false,
			mimeType: "application/pdf",
			size: 2048,
			url: "https://example.test/runway.pdf",
		},
	]);
});

test("normalizes image data and legacy experimental attachments", () => {
	const attachments = getMessageAttachments(
		message(
			[
				{
					data: "aGVsbG8=",
					mediaType: "image/png",
					type: "file",
				},
			],
			{
				experimental_attachments: [
					{
						contentType: "application/pdf",
						name: "Brief.pdf",
						url: "blob:brief",
					},
				],
			}
		)
	);

	expect(attachments[0]).toMatchObject({
		filename: "image-1.png",
		isImage: true,
		mimeType: "image/png",
		url: "data:image/png;base64,aGVsbG8=",
	});
	expect(attachments[1]).toMatchObject({
		filename: "Brief.pdf",
		isImage: false,
		mimeType: "application/pdf",
		url: "blob:brief",
	});
});

test("does not render the same persisted attachment twice", () => {
	const attachments = getMessageAttachments(
		message(
			[
				{
					filename: "image.png",
					mediaType: "image/png",
					type: "file",
					url: "https://example.test/image.png",
				},
			],
			{
				experimental_attachments: [
					{
						contentType: "image/png",
						filename: "image.png",
						url: "https://example.test/image.png",
					},
				],
			}
		)
	);

	expect(attachments).toHaveLength(1);
});
