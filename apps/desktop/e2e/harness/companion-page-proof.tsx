import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { type ProofJsonRecord, parseProofJsonRecord } from "../fixture-json.ts";
import {
	answerDesktopSecretSlot,
	answerEmptyLegacyAuthStore,
} from "./desktop-secret-slots.ts";
import "../../src/index.css";

// Controlled IPC seam, not native Tauri proof. The production sizing hook and
// installed Tauri API still serialize, decode and apply every window operation.
export interface CompanionNativeProofPublisher {
	calls: { command: string; args: ProofJsonRecord }[];
	position: { x: number; y: number };
	refuseSize: boolean;
	scale: number;
	size: { width: number; height: number };
	unknown: string[];
}

const state: CompanionNativeProofPublisher = {
	scale: 2,
	size: { width: 400, height: 80 },
	position: { x: 96, y: 72 },
	calls: [],
	unknown: [],
	refuseSize:
		/* SAFETY: companion-page-proof.spec.ts adds this actual boolean from refuseSizing before navigation. The optional fixture read retains the original false fallback and native Window type; it is not an external payload validator. */ (
			window as Window & { __COMPANION_REFUSE_SIZE__?: boolean }
		).__COMPANION_REFUSE_SIZE__ ?? false,
};

const callbacks = new Map<
	number,
	NonNullable<
		Parameters<typeof import("@tauri-apps/api/core").transformCallback>[0]
	>
>();
let callbackId = 0;
const listeners = new Map<number, { event: string; handler: number }>();
let listenerId = 0;
const physical = (value: Record<string, number>) =>
	Object.fromEntries(
		Object.entries(value).map(([key, amount]) => [key, amount * state.scale])
	);
const unknown = (command: string): never => {
	state.unknown.push(command);
	throw new Error(`Unmapped Companion native contract: ${command}`);
};
Object.assign(window, {
	__COMPANION_NATIVE__: state,
	__TAURI_EVENT_PLUGIN_INTERNALS__: {
		unregisterListener: (event: string, id: number) => {
			if (listeners.get(id)?.event !== event) {
				unknown(`unregister ${event}`);
			}
			listeners.delete(id);
		},
	},
	__TAURI_INTERNALS__: {
		invoke: async (
			command: string,
			input: Parameters<typeof import("@tauri-apps/api/core").invoke>[1] = {}
		) => {
			// Real IPC uses the Tauri classes' toJSON logical tagged unions.
			const args = parseProofJsonRecord(JSON.stringify(input));
			state.calls.push({ command, args });
			if (
				command === "plugin:window|current_monitor" &&
				Object.keys(args).length === 0
			) {
				return {
					name: "Companion proof monitor",
					scaleFactor: state.scale,
					position: { x: 0, y: 0 },
					size: physical({ width: 1440, height: 900 }),
					workArea: {
						position: { x: 0, y: 0 },
						size: physical({ width: 1440, height: 900 }),
					},
				};
			}
			if (command.startsWith("plugin:window|") && args.label === "companion") {
				const expectedKeys =
					command === "plugin:window|set_size" ||
					command === "plugin:window|set_position"
						? "label,value"
						: "label";
				if (Object.keys(args).sort().join(",") !== expectedKeys) {
					return unknown(command);
				}
				switch (command) {
					case "plugin:window|scale_factor":
						return state.scale;
					case "plugin:window|outer_position":
						return physical(state.position);
					case "plugin:window|inner_size":
						return physical(state.size);
					case "plugin:window|set_size": {
						if (state.refuseSize) {
							throw new Error("Fixture resize permission refused");
						}
						const parsedSize = z
							.object({
								Logical: z.object({ width: z.number(), height: z.number() }),
							})
							.safeParse(args.value);
						const value = parsedSize.success
							? parsedSize.data.Logical
							: undefined;
						if (
							!(
								value &&
								Number.isFinite(value.width) &&
								Number.isFinite(value.height)
							) ||
							value.width <= 0 ||
							value.height <= 0
						) {
							return unknown(command);
						}
						state.size = value;
						await /* SAFETY: companion-page-proof.spec.ts installs this async viewport callback through the actual Playwright exposeFunction before navigation. The existing native Logical size checks admit width and height before forwarding this exact value. */ (
							window as Window & {
								companionProofResize: (value: {
									width: number;
									height: number;
								}) => Promise<void>;
							}
						).companionProofResize(value);
						return null;
					}
					case "plugin:window|set_position": {
						const parsedPosition = z
							.object({ Logical: z.object({ x: z.number(), y: z.number() }) })
							.safeParse(args.value);
						const value = parsedPosition.success
							? parsedPosition.data.Logical
							: undefined;
						if (
							!(value && Number.isFinite(value.x) && Number.isFinite(value.y))
						) {
							return unknown(command);
						}
						state.position = value;
						return null;
					}
					default:
						return unknown(command);
				}
			}
			if (
				command === "plugin:event|listen" &&
				args.event === "tauri://move" &&
				JSON.stringify(args.target) ===
					JSON.stringify({ kind: "Window", label: "companion" }) &&
				isNativeNumber(args.handler) &&
				callbacks.has(args.handler)
			) {
				const id = ++listenerId;
				listeners.set(id, { event: args.event, handler: args.handler });
				return id;
			}
			if (
				command === "plugin:event|unlisten" &&
				args.event === "tauri://move" &&
				isNativeNumber(args.eventId)
			) {
				listeners.delete(args.eventId);
				return null;
			}
			// The auth client's sealed `auth-vault` slot (empty: a signed-out
			// device), its change subscription, and the empty legacy store it
			// probes to migrate.
			let slot: ReturnType<typeof answerDesktopSecretSlot>;
			try {
				slot = answerDesktopSecretSlot(sessionStorage, command, args);
			} catch {
				return unknown(command);
			}
			if (slot.handled) {
				return slot.value;
			}
			const legacy = answerEmptyLegacyAuthStore(command, args);
			if (legacy.handled) {
				return legacy.value;
			}
			return unknown(command);
		},
		transformCallback: (
			callback: NonNullable<
				Parameters<typeof import("@tauri-apps/api/core").transformCallback>[0]
			>
		) => {
			const id = ++callbackId;
			callbacks.set(id, callback);
			return id;
		},
		unregisterCallback: (id: number) => callbacks.delete(id),
		metadata: { currentWindow: { label: "companion" } },
	},
});
const { default: App } = await import("../../src/App.tsx");
const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing Companion root");
}
createRoot(root).render(<App hostSurface="desktop" />);
