import { describe, expect, test } from "bun:test";
import { glanceKeyAction } from "./glance-model.ts";

const key = (name: string) => ({
	altKey: false,
	ctrlKey: false,
	key: name,
	metaKey: false,
});

describe("glanceKeyAction reading direction", () => {
	test("left-to-right: ArrowRight pages to the next face", () => {
		expect(glanceKeyAction(key("ArrowRight"))).toBe("next");
		expect(glanceKeyAction(key("ArrowLeft"), 1)).toBe("previous");
	});

	test("right-to-left: ArrowLeft pages to the next face", () => {
		expect(glanceKeyAction(key("ArrowLeft"), -1)).toBe("next");
		expect(glanceKeyAction(key("ArrowRight"), -1)).toBe("previous");
		expect(glanceKeyAction(key("Escape"), -1)).toBe("close");
	});
});
