import { describe, expect, test } from "bun:test";
import {
	activePermissionSchema,
	readPermissionToolFields,
} from "./permission-contract.ts";

describe("permission request boundary", () => {
	test("requires a real request id and option identities", () => {
		expect(
			activePermissionSchema.safeParse({
				requestId: "",
				options: [],
				toolCall: null,
			}).success
		).toBe(false);
		expect(
			activePermissionSchema.safeParse({
				requestId: "request-1",
				options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
				toolCall: null,
			}).success
		).toBe(true);
		expect(
			activePermissionSchema.safeParse({
				requestId: "request-1",
				options: [{ optionId: 42 }],
				toolCall: null,
			}).success
		).toBe(false);
	});
	test("reads flattened and inline tool fields and preserves command input", () => {
		expect(
			readPermissionToolFields({
				fields: {
					title: "Nested",
					kind: "execute",
					rawInput: { command: "pwd" },
				},
				title: "Inline",
			})
		).toEqual({
			title: "Inline",
			kind: "execute",
			rawInput: { command: "pwd" },
		});
	});
	test("invalid display fields cannot become tool commands or labels", () => {
		expect(
			readPermissionToolFields({ title: 123, kind: {}, rawInput: "pwd" })
		).toEqual({});
		expect(readPermissionToolFields(null)).toEqual({});
	});
});
