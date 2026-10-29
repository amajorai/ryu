import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";

const STORE_KEY_PREFIX = "island-settings-proof:tauri-store:";
const STORE_CALLS_KEY = "island-settings-proof:tauri-store:calls";

interface StoreCall {
	fileName: string;
	key?: string;
	method: "get" | "load" | "save" | "set";
	value?: unknown;
}

function recordCall(call: StoreCall): void {
	const raw = localStorage.getItem(STORE_CALLS_KEY);
	const calls = raw === null ? [] : JSON.parse(raw);
	calls.push(call);
	localStorage.setItem(STORE_CALLS_KEY, JSON.stringify(calls));
}

function valueKey(fileName: string, key: string): string {
	return `${STORE_KEY_PREFIX}${fileName}:${key}`;
}

export async function load(fileName: string) {
	recordCall({ fileName, method: "load" });
	return {
		get: async (key: string): Promise<ProofJsonValue | undefined> => {
			const raw = localStorage.getItem(valueKey(fileName, key));
			const value = raw === null ? undefined : parseProofJson(raw);
			recordCall({ fileName, key, method: "get", value });
			return value;
		},
		save: async (): Promise<void> => {
			recordCall({ fileName, method: "save" });
			const key = `${STORE_KEY_PREFIX}${fileName}:save-count`;
			const current = Number(localStorage.getItem(key) ?? "0");
			localStorage.setItem(key, String(current + 1));
		},
		set: async <Value>(key: string, value: Value): Promise<void> => {
			recordCall({ fileName, key, method: "set", value });
			localStorage.setItem(valueKey(fileName, key), JSON.stringify(value));
		},
	};
}
