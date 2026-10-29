import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { GatewayJsonValue } from "@/src/lib/api/gateway-json-contracts.ts";
import type { NativeLaunchOption } from "@/src/lib/api/inference.ts";

const ACTIVE_NODE: ApiTarget = {
	url: "https://node.example",
	token: "node-token",
	userJwt: "user-jwt",
};

const CATALOG: NativeLaunchOption[] = [
	{
		key: "threads_batch",
		label: "Batch threads",
		group: "CPU & threads",
		help: "Threads for prompt processing.",
		target: { type: "flag", name: "--threads-batch" },
		kind: { type: "int", min: -1 },
	},
	{
		key: "no_kv_offload",
		label: "Keep KV cache on CPU",
		group: "GPU & memory",
		help: "Disable KV cache offloading to the GPU (--no-kv-offload).",
		target: { type: "flag", name: "--no-kv-offload" },
		kind: { type: "bool" },
	},
	{
		key: "device",
		label: "Devices",
		group: "GPU & memory",
		help: "Comma-separated devices.",
		target: { type: "flag", name: "--device" },
		kind: { type: "text" },
	},
	{
		key: "mlx_vlm_apc_enabled",
		label: "Prefix cache",
		group: "Prompt cache",
		help: "APC_ENABLED: reuse KV blocks for repeated prompt prefixes.",
		target: { type: "env", name: "APC_ENABLED" },
		kind: { type: "bool" },
	},
	{
		key: "omlx_ssd_cache_dir",
		label: "SSD cache directory",
		group: "Prompt cache",
		help: "Where paged KV cache blocks are stored.",
		target: { type: "env", name: "OMLX_SSD_CACHE_DIR" },
		kind: { type: "text" },
	},
];
const catalogCalls: string[] = [];

mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => ACTIVE_NODE,
}));
mock.module("@/src/lib/api/inference.ts", () => ({
	getEngineLaunchOptions: async (_target: ApiTarget, engineId: string) => {
		catalogCalls.push(engineId);
		return CATALOG;
	},
}));
// Bridge the unit-test DOM's input events to the field callbacks.
mock.module("@ryu/ui/components/input", () => ({
	Input: ({ onChange, ...props }: ComponentProps<"input">) => (
		<input
			{...props}
			onChange={onChange}
			onInput={(event) =>
				onChange?.(Object.assign(event, { target: event.currentTarget }))
			}
		/>
	),
}));
mock.module("@ryu/ui/components/switch", () => ({
	Switch: ({
		checked,
		id,
		onCheckedChange,
	}: {
		checked: boolean;
		id?: string;
		onCheckedChange?: (checked: boolean) => void;
	}) => (
		<input
			checked={checked}
			id={id}
			onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
			role="switch"
			type="checkbox"
		/>
	),
}));

const { NativeLaunchOptions } = await import("./NativeLaunchOptions.tsx");

let container: HTMLDivElement;
let queryClient: QueryClient;
let root: Root | null;
let changes: (Record<string, GatewayJsonValue> | undefined)[];
let validity: boolean[];

beforeEach(() => {
	catalogCalls.length = 0;
	changes = [];
	validity = [];
	queryClient = new QueryClient({
		defaultOptions: { queries: { gcTime: 0, retry: false } },
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	if (root) {
		await act(async () => root?.unmount());
		root = null;
	}
	queryClient.clear();
	container.remove();
});

async function render(
	value: Record<string, GatewayJsonValue> | undefined
): Promise<void> {
	await act(async () => {
		root?.render(
			<QueryClientProvider client={queryClient}>
				<NativeLaunchOptions
					engineId="llamacpp-rerank"
					onChange={(next) => changes.push(next)}
					onValidityChange={(valid) => validity.push(valid)}
					value={value}
				/>
			</QueryClientProvider>
		);
	});
	await act(async () => {
		for (
			let attempt = 0;
			attempt < 40 && !container.textContent?.includes("Batch threads");
			attempt += 1
		) {
			await new Promise<void>((resolve) => setTimeout(resolve, 2));
		}
	});
}

function fieldNamed(name: string): HTMLInputElement {
	const label = Array.from(container.querySelectorAll("label")).find(
		(candidate) => candidate.textContent?.trim() === name
	);
	const field = label?.htmlFor ? document.getElementById(label.htmlFor) : null;
	if (!(field instanceof HTMLInputElement)) {
		throw new Error(`Could not find field: ${name}`);
	}
	return field;
}

async function type(name: string, value: string): Promise<void> {
	const field = fieldNamed(name);
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		setter?.call(field, value);
		field.dispatchEvent(new InputEvent("input", { bubbles: true }));
		await Promise.resolve();
	});
}

test("renders the engine's catalog grouped, with flag hints", async () => {
	await render(undefined);
	expect(catalogCalls).toEqual(["llamacpp-rerank"]);
	const text = container.textContent ?? "";
	expect(text).toContain("CPU & threads");
	expect(text).toContain("GPU & memory");
	expect(text).toContain("Threads for prompt processing. (--threads-batch)");
	// Help that already names the flag is not repeated.
	expect(text).not.toContain("(--no-kv-offload) (--no-kv-offload)");
});

test("environment options are grouped and name their variable once", async () => {
	await render(undefined);
	const text = container.textContent ?? "";
	expect(text).toContain("Prompt cache");
	expect(text).toContain(
		"Where paged KV cache blocks are stored. (env OMLX_SSD_CACHE_DIR)"
	);
	expect(text).not.toContain("(env APC_ENABLED)");
});

test("environment text options store and clear their value", async () => {
	await render(undefined);
	await type("SSD cache directory", "/Volumes/cache");
	expect(changes.at(-1)).toEqual({ omlx_ssd_cache_dir: "/Volumes/cache" });

	await render({ device: "CUDA0", omlx_ssd_cache_dir: "/Volumes/cache" });
	await type("SSD cache directory", "");
	expect(changes.at(-1)).toEqual({ device: "CUDA0" });
	await type("SSD cache directory", "   ");
	expect(changes.at(-1)).toEqual({ device: "CUDA0" });
});

test("numbers within range update the native map", async () => {
	await render({ device: "CUDA0" });
	await type("Batch threads", "8");
	expect(changes.at(-1)).toEqual({ device: "CUDA0", threads_batch: 8 });
	expect(validity.at(-1)).toBe(true);
});

test("out-of-range numbers block saving instead of being stored", async () => {
	await render(undefined);
	await type("Batch threads", "-5");
	expect(changes).toEqual([]);
	expect(validity.at(-1)).toBe(false);
	expect(container.querySelector('[role="alert"]')?.textContent).toBe(
		"Batch threads must be at least -1."
	);
	await type("Batch threads", "");
	expect(validity.at(-1)).toBe(true);
	expect(changes.at(-1)).toBeUndefined();
});

test("a flag switch stores true and clears the key when turned off", async () => {
	await render({ no_kv_offload: true });
	const toggle = fieldNamed("Keep KV cache on CPU");
	expect(toggle.checked).toBe(true);
	await act(async () => {
		toggle.click();
		await Promise.resolve();
	});
	expect(changes.at(-1)).toBeUndefined();
});

test("blank text clears the option", async () => {
	await render({ device: "CUDA0", threads_batch: 4 });
	await type("Devices", "   ");
	expect(changes.at(-1)).toEqual({ threads_batch: 4 });
});
