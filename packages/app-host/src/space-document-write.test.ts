import { expect, test } from "bun:test";
import { spaceDocumentWriteResultSchema } from "./space-document-write.ts";

test("database writes preserve revision results and omit absent version ids", () => {
	const applied = {
		changed: true,
		duplicate: false,
		revision: 2,
		updated_at: 123,
		version_id: "version",
		metadata: { future: true },
	};
	const duplicate = {
		changed: false,
		duplicate: true,
		revision: 2,
		updated_at: 123,
	};
	expect(spaceDocumentWriteResultSchema.parse(applied)).toBe(applied);
	expect(spaceDocumentWriteResultSchema.parse(duplicate)).toBe(duplicate);
	expect(
		Object.hasOwn(spaceDocumentWriteResultSchema.parse(duplicate), "version_id")
	).toBe(false);
	expect(
		spaceDocumentWriteResultSchema.safeParse({ revision: 2 }).success
	).toBe(false);
	expect(
		spaceDocumentWriteResultSchema.safeParse({ ...applied, duplicate: "false" })
			.success
	).toBe(false);
});
