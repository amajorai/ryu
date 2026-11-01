// Fixture ledgers, readers and native slot handlers for the Desktop General
// settings story (split from desktop-general-settings-proof.tsx to stay under
// the file-size limit).
import type { z } from "zod";
import type { PluginDocument } from "../../src/lib/api/plugin-wire-values.ts";

declare const window: GeneralProofWindow;

export interface GeneralProofCall {
	args?: Record<string, unknown>;
	command: string;
}

export interface GeneralGatewayCall {
	body: PluginDocument | null;
	method: string;
	path: string;
}

export interface GeneralProofFixture {
	failNextCommand: (command: string, message?: string) => void;
	failNextFolderDialog: (message?: string) => void;
	failNextGatewayRequest: (path: string, message?: string) => void;
	setFolderSelection: (path: string | null) => void;
}

export interface GeneralProofWindow extends Window {
	__GENERAL_NATIVE_STORE_MODE__?: "native" | "browser-fallback";
	__generalGatewayCalls: GeneralGatewayCall[];
	__generalNativeStoreCalls: Array<{
		args?: Record<string, unknown>;
		command: string;
		acknowledged: boolean;
		value?: unknown;
	}>;
	__generalProofCalls: GeneralProofCall[];
	__generalProofFixture: GeneralProofFixture;
	__generalUnknownCommands: string[];
	__TAURI_INTERNALS__?: {
		invoke: (
			command: string,
			args?: Record<string, unknown>
		) => Promise<unknown>;
		transformCallback: (...args: unknown[]) => number;
	};
}

export function readFixtureBoolean(key: string, fallback: boolean): boolean {
	const stored = localStorage.getItem(key);
	return stored === null ? fallback : stored === "true";
}

export function readFixtureValue<T>(
	key: string,
	fallback: T,
	schema: z.ZodType<T>
): T {
	try {
		const stored = localStorage.getItem(key);
		return stored === null ? fallback : schema.parse(JSON.parse(stored));
	} catch {
		return fallback;
	}
}

/** Native commands the story does not model; the specs require it stays empty. */
export const generalUnknownCommands: string[] = [];

export function exactBooleanArgument(
	command: string,
	args: Record<string, unknown> | undefined,
	key: string
) {
	const value = args?.[key];
	if (
		!args ||
		typeof args !== "object" ||
		Array.isArray(args) ||
		Object.keys(args).length !== 1 ||
		typeof value !== "boolean"
	) {
		generalUnknownCommands.push(command);
		throw new Error(`Invalid Boolean General native request: ${command}`);
	}
	return value;
}

const SECRET_SLOT_PREFIX = "general-proof:sealed-slot:";
// The desktop's sealed secret slots (`desktop_secret_*`). The native command
// seals with the desktop key; this fixture only models the slot boundary, with
// a record that survives reload. In browser-fallback mode the host has no
// slots: an unknown command resolves `undefined`, which the auth client reads
// as "no native backend" and keeps the vault in memory only.
export function handleSecretSlot(
	command: string,
	args: Record<string, unknown> | undefined
): string | null | undefined {
	if (window.__GENERAL_NATIVE_STORE_MODE__ === "browser-fallback") {
		return undefined;
	}
	const name = args?.name;
	if (name !== "auth-vault" && name !== "license-key") {
		generalUnknownCommands.push(command);
		throw new Error(`Invalid secret slot request: ${command}`);
	}
	const key = `${SECRET_SLOT_PREFIX}${name}`;
	if (command === "desktop_secret_get") {
		return localStorage.getItem(key);
	}
	if (command === "desktop_secret_set" && typeof args?.value === "string") {
		localStorage.setItem(key, args.value);
		return null;
	}
	if (command === "desktop_secret_delete") {
		localStorage.removeItem(key);
		return null;
	}
	generalUnknownCommands.push(command);
	throw new Error(`Invalid secret slot request: ${command}`);
}

// A Gateway always serves `auth` and `providers`; Desktop validates the full
// served shape (since 4f7563c79d) before the ACP card reads `acp`.
export const SERVED_GATEWAY_CONFIG_BASE = {
	auth: { api_keys: [], require_auth: false },
	providers: {
		anthropic: null,
		core: null,
		genai: null,
		local: null,
		openai: null,
		openrouter: null,
	},
};
