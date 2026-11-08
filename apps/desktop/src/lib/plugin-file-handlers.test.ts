import { describe, expect, test } from "bun:test";
import { assertOpenedFileUri } from "@ryu/app-host/opened-file";
import {
	createOpenedFileAccess,
	encodeOpenedFileText,
	fileHandlersFor,
} from "./plugin-file-handlers.ts";

describe("opened file scope", () => {
	test("text writes preserve Unicode and BOM using the byte-preserving backend", () => {
		const text = "\uFEFFα🙂";
		const decoded = Uint8Array.from(
			atob(encodeOpenedFileText(text)),
			(character) => character.charCodeAt(0)
		);
		expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(decoded)).toBe(
			text
		);
	});
	test("reads and saves only the selected path, preserving external edits", async () => {
		let text = "original";
		const paths: string[] = [];
		const access = createOpenedFileAccess("D:/work/shape.txt", true, {
			read: async (path) => {
				paths.push(path);
				return text;
			},
			write: async (path, value) => {
				paths.push(path);
				text = value;
			},
		});
		const snapshot = await access.read();
		const saved = await access.write?.("edited", snapshot.revision);
		expect(saved?.text).toBe("edited");
		text = "external edit";
		await expect(
			access.write?.("stale overwrite", saved?.revision ?? "")
		).rejects.toThrow("changed on disk");
		expect(text).toBe("external edit");
		expect(paths.every((path) => path === "D:/work/shape.txt")).toBe(true);
		expect(() => assertOpenedFileUri(access, "ryu-file:other")).toThrow(
			"Only the file"
		);
	});

	test("an oversized write rejects with a code, not an English sentence", async () => {
		const access = createOpenedFileAccess("/work/big.txt", true, {
			read: async () => "",
			write: async () => undefined,
		});
		const snapshot = await access.read();
		await expect(
			access.write?.("x".repeat(8 * 1024 * 1024 + 1), snapshot.revision)
		).rejects.toThrow("file_too_large");
	});

	test("binary reads hash the exact bytes and fall back to a blob for non-UTF-8", async () => {
		const utf8 = new TextEncoder().encode("\uFEFFhéllo 🙂");
		const raw = new Uint8Array([0xff, 0x00, 0xc3, 0x28, 0x80]);
		const toBase64 = (bytes: Uint8Array<ArrayBuffer>) => {
			let binary = "";
			for (const byte of bytes) {
				binary += String.fromCharCode(byte);
			}
			return btoa(binary);
		};
		const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>) =>
			Array.from(
				new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
				(byte) => byte.toString(16).padStart(2, "0")
			).join("");
		const blobs: Record<string, string> = {
			"/work/text.md": toBase64(utf8),
			"/work/raw.bin": toBase64(raw),
		};
		const io = {
			read: async () => "",
			write: async () => undefined,
			readBinary: async (path: string) => blobs[path] ?? "",
		};
		const text = await createOpenedFileAccess(
			"/work/text.md",
			false,
			io
		).read();
		expect(text.text).toBe("\uFEFFhéllo 🙂");
		expect(text.revision).toBe(await sha256Hex(utf8));
		const binary = await createOpenedFileAccess(
			"/work/raw.bin",
			false,
			io
		).read();
		expect(binary.text).toBeUndefined();
		expect(binary.blob).toBe(blobs["/work/raw.bin"]);
		expect(binary.revision).toBe(await sha256Hex(raw));
	});

	test("read-only handlers receive no writer", () => {
		const access = createOpenedFileAccess("/work/view.txt", false);
		expect(access.write).toBeUndefined();
	});
	test("binary bytes remain unchanged through read and save", async () => {
		let blob = btoa(String.fromCharCode(0, 255, 254, 128));
		const access = createOpenedFileAccess("/work/image.bin", true, {
			read: async () => "",
			write: async () => undefined,
			readBinary: async () => blob,
			writeBinary: async (_path, next) => {
				blob = next;
			},
		});
		const original = await access.read();
		expect(original.blob).toBe(blob);
		const replacement = btoa(String.fromCharCode(255, 1, 128));
		const saved = await access.writeBlob?.(replacement, original.revision);
		expect(saved?.blob).toBe(replacement);
	});
	test("two editor panels cannot overwrite each other with the same revision", async () => {
		let text = "initial";
		const io = {
			read: async () => text,
			write: async (_path: string, next: string) => {
				text = next;
			},
		};
		const first = createOpenedFileAccess("/work/shared.txt", true, io);
		const second = createOpenedFileAccess("/work/shared.txt", true, io);
		const snapshot = await first.read();
		const results = await Promise.allSettled([
			first.write?.("first", snapshot.revision),
			second.write?.("second", snapshot.revision),
		]);
		expect(results[0].status).toBe("fulfilled");
		expect(results[1].status).toBe("rejected");
		expect(text).toBe("first");
	});

	test("matching extensions cannot mount another plugin's companion", () => {
		const handler = {
			id: "text",
			title: "Text",
			companion: "editor",
			extensions: ["txt"],
			editable: true,
			plugin: "@example/editor",
		};
		expect(fileHandlersFor("HELLO.TXT", [handler], [])).toEqual([]);
	});
});
