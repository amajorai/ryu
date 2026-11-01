import { describe, expect, test } from "bun:test";
import { declareCliSurface } from "./device-approval-link.ts";

describe("CLI approval link", () => {
	test("declares the CLI surface and keeps the code", () => {
		expect(
			declareCliSurface("https://ryu.example/device?user_code=ABCD-1234")
		).toBe("https://ryu.example/device?user_code=ABCD-1234&surface=cli");
	});

	test("replaces any surface the link already carried", () => {
		expect(declareCliSurface("https://ryu.example/device?surface=mobile")).toBe(
			"https://ryu.example/device?surface=cli"
		);
	});

	test("leaves a link that does not parse unchanged", () => {
		expect(declareCliSurface("not a url")).toBe("not a url");
	});
});
