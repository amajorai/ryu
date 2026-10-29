import { describe, expect, test } from "bun:test";
import {
	buildFirstProjectInput,
	FIRST_PROJECT_NAME_MAX,
	firstProjectError,
} from "./first-project.ts";

const draft = {
	about: "  Launch the new site  ",
	folder: null,
	icon: null,
	name: "  Atlas  ",
};

describe("first project", () => {
	test("requires a non-blank name within the limit", () => {
		expect(firstProjectError(draft)).toBeNull();
		expect(firstProjectError({ ...draft, name: "   " })).toBe(
			"Give your project a name."
		);
		expect(
			firstProjectError({
				...draft,
				name: "x".repeat(FIRST_PROJECT_NAME_MAX + 1),
			})
		).toContain("under");
	});

	test("the personalized agent coordinates and the about text becomes instructions", () => {
		expect(buildFirstProjectInput(draft, "ryu")).toEqual({
			name: "Atlas",
			description: "Launch the new site",
			instructions: "Launch the new site",
			icon: null,
			coordinatorAgent: "ryu",
		});
	});

	test("a picked folder is carried as the device-local working folder", () => {
		expect(
			buildFirstProjectInput({ ...draft, folder: "/work/atlas" }, "ryu").cwd
		).toBe("/work/atlas");
	});
});
