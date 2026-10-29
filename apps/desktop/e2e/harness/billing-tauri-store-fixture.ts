import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";

const STORE_KEY_PREFIX = "billing-tab-proof:tauri-store:";

function valueKey(fileName: string, key: string): string {
	return `${STORE_KEY_PREFIX}${fileName}:${key}`;
}

export async function load(fileName: string) {
	return {
		get: async (key: string): Promise<ProofJsonValue | undefined> => {
			const raw = localStorage.getItem(valueKey(fileName, key));
			return raw === null ? undefined : parseProofJson(raw);
		},
		save: async (): Promise<void> => {
			const key = `${STORE_KEY_PREFIX}${fileName}:save-count`;
			const count = Number(localStorage.getItem(key) ?? "0");
			localStorage.setItem(key, String(count + 1));
		},
		set: async <FixturePayload>(
			key: string,
			value: FixturePayload
		): Promise<void> => {
			localStorage.setItem(valueKey(fileName, key), JSON.stringify(value));
		},
	};
}
