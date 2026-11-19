import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n";
import { formatMessage } from "@ryu/i18n/core";
import {
	monitorStatusLabel,
	monitorValueLabel,
} from "./monitors-value-label.ts";

const tl: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {});

describe("monitorValueLabel", () => {
	test("labels the stored check tokens", () => {
		expect(monitorValueLabel("uptime", "up", tl)).toBe("Up");
		expect(monitorValueLabel("uptime", "down", tl)).toBe("Down");
		expect(monitorValueLabel("keyword", "present", tl)).toBe("Keyword present");
		expect(monitorValueLabel("keyword", "absent", tl)).toBe("Keyword absent");
		expect(monitorValueLabel("stock", "in_stock", tl)).toBe("In stock");
		expect(monitorValueLabel("stock", "out_of_stock", tl)).toBe("Out of stock");
	});

	test("counts content characters with a plural", () => {
		expect(monitorValueLabel("content_diff", "1 chars", tl)).toBe(
			"1 character"
		);
		expect(monitorValueLabel("content_diff", "1204 chars", tl)).toBe(
			"1,204 characters"
		);
	});

	test("keeps a price or a token from another check type as stored", () => {
		expect(monitorValueLabel("price", "19.99", tl)).toBe("19.99");
		expect(monitorValueLabel("price", "up", tl)).toBe("up");
	});
});

describe("monitorStatusLabel", () => {
	test("labels each check status", () => {
		expect(monitorStatusLabel("triggered", tl)).toBe("Alert triggered");
		expect(monitorStatusLabel("error", tl)).toBe("Check failed");
		expect(monitorStatusLabel("ok", tl)).toBe("Check passed");
	});
});
