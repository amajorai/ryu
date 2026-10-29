import { beforeEach, expect, test } from "bun:test";
import {
	getAcpConfig,
	getAcpMode,
	getAcpModel,
	setAcpConfigValue,
	setAcpMode,
	setAcpModel,
} from "./acp-selections.ts";

const store = new Map<string, string>();
let throwOnWrite = false;

Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => {
			if (throwOnWrite) {
				throw new Error("QuotaExceededError");
			}
			store.set(key, value);
		},
		removeItem: (key: string) => store.delete(key),
		clear: () => store.clear(),
	},
});

beforeEach(() => {
	store.clear();
	throwOnWrite = false;
});

test("mode and model selections persist per agent without clobbering siblings", () => {
	setAcpMode("claude", "plan");
	setAcpMode("codex", "auto");
	setAcpModel("claude", "opus");
	expect(getAcpMode("claude")).toBe("plan");
	expect(getAcpMode("codex")).toBe("auto");
	expect(getAcpModel("claude")).toBe("opus");
	expect(getAcpModel("codex")).toBeNull();
	expect(JSON.parse(store.get("ryu_acp_mode") ?? "{}")).toEqual({
		claude: "plan",
		codex: "auto",
	});
	setAcpMode("claude", "edit");
	expect(getAcpMode("claude")).toBe("edit");
	expect(getAcpMode("codex")).toBe("auto");
});

test("config values merge per agent and per config id", () => {
	setAcpConfigValue("claude", "effort", "high");
	setAcpConfigValue("claude", "verbosity", "low");
	setAcpConfigValue("codex", "effort", "low");
	setAcpConfigValue("claude", "effort", "max");
	expect(getAcpConfig("claude")).toEqual({ effort: "max", verbosity: "low" });
	expect(getAcpConfig("codex")).toEqual({ effort: "low" });
	expect(getAcpConfig("other")).toEqual({});
});

test("a null agent reads as no selection", () => {
	setAcpMode("claude", "plan");
	setAcpModel("claude", "opus");
	setAcpConfigValue("claude", "effort", "high");
	expect(getAcpMode(null)).toBeNull();
	expect(getAcpModel(null)).toBeNull();
	expect(getAcpConfig(null)).toEqual({});
});

test("corrupt stored JSON is tolerated and overwritten on the next write", () => {
	store.set("ryu_acp_mode", "{not json");
	store.set("ryu_acp_model", JSON.stringify({ claude: 7, codex: "gpt" }));
	store.set("ryu_acp_config", "[[[");
	expect(getAcpMode("claude")).toBeNull();
	// A malformed sibling entry is dropped while valid entries survive.
	expect(getAcpModel("codex")).toBe("gpt");
	expect(getAcpModel("claude")).toBeNull();
	expect(getAcpConfig("claude")).toEqual({});

	setAcpMode("claude", "plan");
	setAcpConfigValue("claude", "effort", "high");
	expect(getAcpMode("claude")).toBe("plan");
	expect(getAcpConfig("claude")).toEqual({ effort: "high" });
});

test("storage write failures do not throw", () => {
	throwOnWrite = true;
	expect(() => setAcpMode("claude", "plan")).not.toThrow();
	expect(() => setAcpConfigValue("claude", "effort", "high")).not.toThrow();
	expect(getAcpMode("claude")).toBeNull();
});
