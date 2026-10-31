// The sandbox-page transport (MV3 extension dashboard): the host hands the
// companion document to ITS sandbox frame once, and only in answer to that
// frame's readiness. Every rejection path is asserted without a DOM.

import { describe, expect, test } from "bun:test";
import {
	SANDBOX_DOCUMENT_KIND,
	sandboxDocumentMessageSchema,
	shouldSendSandboxDocument,
} from "./ExtensionHost.tsx";

const ready = { kind: "ryu-sandbox-ready" };

describe("shouldSendSandboxDocument", () => {
	test("answers the created frame's first readiness", () => {
		expect(
			shouldSendSandboxDocument(ready, {
				alreadySent: false,
				fromThisFrame: true,
			})
		).toBe(true);
	});

	test("refuses readiness from any other window", () => {
		expect(
			shouldSendSandboxDocument(ready, {
				alreadySent: false,
				fromThisFrame: false,
			})
		).toBe(false);
	});

	test("refuses a replayed readiness after the document was sent", () => {
		expect(
			shouldSendSandboxDocument(ready, {
				alreadySent: true,
				fromThisFrame: true,
			})
		).toBe(false);
	});

	test("refuses anything that is not a sandbox readiness", () => {
		for (const data of [
			null,
			"ryu-sandbox-ready",
			{ kind: "ryu-plugin-ready", nonce: "n" },
			{ kind: "ryu-sandbox-init" },
		]) {
			expect(
				shouldSendSandboxDocument(data, {
					alreadySent: false,
					fromThisFrame: true,
				})
			).toBe(false);
		}
	});
});

describe("sandboxDocumentMessageSchema", () => {
	test("accepts the host's document message", () => {
		expect(
			sandboxDocumentMessageSchema.safeParse({
				html: "<!doctype html><p>app</p>",
				kind: SANDBOX_DOCUMENT_KIND,
				nonce: "n-1",
			}).success
		).toBe(true);
	});

	test("rejects an empty document or a missing nonce", () => {
		expect(
			sandboxDocumentMessageSchema.safeParse({
				html: "",
				kind: SANDBOX_DOCUMENT_KIND,
				nonce: "n-1",
			}).success
		).toBe(false);
		expect(
			sandboxDocumentMessageSchema.safeParse({
				html: "<p>app</p>",
				kind: SANDBOX_DOCUMENT_KIND,
			}).success
		).toBe(false);
	});
});
