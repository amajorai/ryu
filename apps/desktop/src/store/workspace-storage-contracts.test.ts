import { expect, it } from "bun:test";
import {
	projectEnvironmentsStorageSchema,
	projectIconStorageSchema,
	workspaceFoldersStorageSchema,
	workspaceStorageEntriesSchema,
} from "./workspace-storage-contracts.ts";

it("retains permissive legacy glyph values and legacy-shape precedence", () => {
	expect(
		projectIconStorageSchema.parse({
			type: "emoji",
			value: "",
			kind: "avatar",
			dataUrl: "ignored",
		})
	).toEqual({ kind: "emoji", emoji: "" });
	expect(
		projectIconStorageSchema.parse({ type: "image", value: "legacy:data" })
	).toEqual({ kind: "avatar", dataUrl: "legacy:data" });
	const id = "x".repeat(500);
	expect(
		projectIconStorageSchema.parse({ kind: "icon", id, color: "" })
	).toEqual({ kind: "icon", id, color: "" });
	const seed = "s".repeat(600);
	expect(
		projectIconStorageSchema.parse({
			kind: "dicebear",
			style: "future-style",
			seed,
		})
	).toEqual({ kind: "dicebear", style: "future-style", seed });
	expect(
		projectIconStorageSchema.parse({ kind: "emoji", emoji: "e".repeat(100) })
	).toEqual({ kind: "emoji", emoji: "e".repeat(100) });
});
it("normalizes only the existing dither and expressive owner fields", () => {
	expect(
		projectIconStorageSchema.parse({
			kind: "emoji",
			emoji: "🦉",
			dither: { from: "green", to: "future", direction: "diagonal" },
		})
	).toEqual({
		kind: "emoji",
		emoji: "🦉",
		dither: { from: "green", to: null, direction: "up" },
	});
	expect(
		projectIconStorageSchema.parse({
			kind: "dither",
			dither: { from: "blue", to: "red", direction: "left" },
		})
	).toEqual({
		kind: "dither",
		dither: { from: "blue", to: "red", direction: "left" },
	});
	expect(
		projectIconStorageSchema.parse({
			kind: "icon",
			id: "icon",
			dither: { from: "future" },
		})
	).toEqual({ kind: "icon", id: "icon" });
	expect(
		projectIconStorageSchema.parse({
			kind: "dither",
			dither: { from: "future" },
		})
	).toBeNull();
	expect(
		projectIconStorageSchema.parse({
			kind: "expressive",
			expression: "neutral",
			eyeScale: 10,
			animationDuration: 0,
			colors: { bg: " #fff " },
		})
	).toEqual({
		expression: "neutral",
		eyeScale: 3,
		animationDuration: 1,
		colors: { bg: "#fff" },
		kind: "expressive",
	});
	expect(
		projectIconStorageSchema.parse({
			kind: "expressive",
			expression: "future-expression",
		})
	).toBeNull();
});
it("keeps valid environment children and script metadata by identity while filtering malformed rows", () => {
	const setup = JSON.parse(
		'{"default":"echo ready","linux":"","macos":"","windows":"","__proto__":{"future":true}}'
	);
	const cleanup = {
		default: "echo done",
		linux: "",
		macos: "",
		windows: "",
		future: { revision: 2 },
	};
	const variable = {
		id: "",
		key: "TOKEN",
		value: "",
		future: { encrypted: false },
	};
	const action = {
		id: "run",
		name: "",
		scripts: setup,
		future: { badge: "new" },
	};
	const input = [
		null,
		7,
		{ id: "bad", name: "Missing scripts" },
		{
			id: "",
			name: "  Environment  ",
			setup,
			cleanup,
			variables: [variable, { id: "bad" }, null],
			actions: [action, { id: "bad", name: "Bad", scripts: {} }],
		},
	];
	const result = projectEnvironmentsStorageSchema.parse(input);
	expect(result).toHaveLength(1);
	expect(result[0]).toEqual({
		id: "",
		name: "Environment",
		setup,
		cleanup,
		variables: [variable],
		actions: [action],
	});
	expect(result[0]?.setup).toBe(setup);
	expect(result[0]?.cleanup).toBe(cleanup);
	expect(result[0]?.variables[0]).toBe(variable);
	expect(result[0]?.actions[0]).toBe(action);
	expect(
		Object.getOwnPropertyDescriptor(result[0]?.setup, "__proto__")?.value
	).toEqual({ future: true });
	expect(
		projectEnvironmentsStorageSchema.parse([
			{ id: "environment", name: " ", setup, cleanup },
		])
	).toEqual([]);
});
it("preserves raw map and array keys, refining only supported folder strings", () => {
	const map = JSON.parse(
		'{"__proto__":{"kind":"emoji","emoji":"🦉"},"future":{"arbitrary":[null,7]}}'
	);
	expect(workspaceStorageEntriesSchema.parse(map)).toBe(map);
	expect(
		Object.entries(workspaceStorageEntriesSchema.parse(map)).map(([key]) => key)
	).toEqual(["__proto__", "future"]);
	const array = [{ kind: "avatar", dataUrl: "" }, "name"];
	expect(workspaceStorageEntriesSchema.parse(array)).toBe(array);
	expect(workspaceStorageEntriesSchema.safeParse(null).success).toBe(false);
	expect(
		workspaceFoldersStorageSchema.parse(["", "/project", null, 7, "/future"])
	).toEqual(["", "/project", "/future"]);
	expect(workspaceFoldersStorageSchema.parse({ future: true })).toEqual([]);
});
