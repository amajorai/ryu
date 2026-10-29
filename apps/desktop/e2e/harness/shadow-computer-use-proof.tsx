import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ShadowSettings } from "../../src/components/settings/ShadowSettings.tsx";
import { answerDesktopSecretSlot } from "./desktop-secret-slots.ts";
import "../../src/index.css";

// Finite Tauri store contract for this page: useShadowCapture's saved capture
// preferences (`companion.bin`, seeded by the spec through sessionStorage) and
// the desktop account vault read by lib/auth-client.ts (the sealed `auth-vault`
// slot, and the legacy `auth.bin` it migrates from, both empty: a signed-out
// device). Unknown commands, paths, handles and keys are recorded and refused,
// never answered.
const OWNED_STORES: Record<string, { keys: string[]; rid: number }> = {
	"companion.bin": {
		rid: 4101,
		keys: [
			"companion_app_allowlist",
			"companion_frames",
			"companion_paused",
			"shadow_history_retention_days",
		],
	},
	"auth.bin": { rid: 4102, keys: ["accounts", "activeUserId", "token"] },
};
const seedKey = (storePath: string) => `shadow-proof-store:${storePath}`;
interface ShadowProofNativeLedger {
	calls: string[];
	refused: string[];
}
const nativeLedger: ShadowProofNativeLedger = { calls: [], refused: [] };
const storeValues = new Map<number, Record<string, unknown>>(
	Object.entries(OWNED_STORES).map(([storePath, { rid }]) => [
		rid,
		JSON.parse(sessionStorage.getItem(seedKey(storePath)) ?? "{}"),
	])
);
function refuse(command: string, reason: string): never {
	nativeLedger.refused.push(`${command}: ${reason}`);
	throw new Error(`Refused native command ${command}: ${reason}`);
}
function ownedStore(command: string, args: Record<string, unknown>) {
	const entry = Object.entries(OWNED_STORES).find(
		([, owned]) => owned.rid === args.rid
	);
	if (!entry) {
		return refuse(command, "unknown store handle");
	}
	const [storePath, owned] = entry;
	return { storePath, owned, values: storeValues.get(owned.rid) ?? {} };
}
function ownedKey(command: string, args: Record<string, unknown>) {
	const store = ownedStore(command, args);
	if (typeof args.key !== "string" || !store.owned.keys.includes(args.key)) {
		return refuse(command, `unowned key ${String(args.key)}`);
	}
	return { ...store, key: args.key };
}
function invokeStore(command: string, args: Record<string, unknown>): unknown {
	let slot: ReturnType<typeof answerDesktopSecretSlot>;
	try {
		slot = answerDesktopSecretSlot(sessionStorage, command, args);
	} catch (error) {
		return refuse(command, String(error));
	}
	if (slot.handled) {
		return slot.value;
	}
	if (command === "plugin:store|load") {
		const owned =
			typeof args.path === "string" ? OWNED_STORES[args.path] : undefined;
		if (!owned) {
			return refuse(command, `unowned path ${String(args.path)}`);
		}
		return owned.rid;
	}
	if (command === "plugin:store|get") {
		const { values, key } = ownedKey(command, args);
		return [values[key] ?? null, Object.hasOwn(values, key)];
	}
	if (command === "plugin:store|set") {
		const { values, key } = ownedKey(command, args);
		values[key] = args.value;
		return null;
	}
	if (command === "plugin:store|delete") {
		const { values, key } = ownedKey(command, args);
		const existed = Object.hasOwn(values, key);
		delete values[key];
		return existed;
	}
	if (command === "plugin:store|save") {
		const { storePath, values } = ownedStore(command, args);
		sessionStorage.setItem(seedKey(storePath), JSON.stringify(values));
		return null;
	}
	return refuse(command, "not part of the Shadow settings contract");
}
let nextCallback = 0;
Object.assign(window, {
	__shadowProofNative: nativeLedger,
	__TAURI_INTERNALS__: {
		invoke: (command: string, args: Record<string, unknown> = {}) => {
			nativeLedger.calls.push(command);
			try {
				return Promise.resolve(invokeStore(command, args));
			} catch (error) {
				return Promise.reject(error);
			}
		},
		// A callback id is taken before every `plugin:event|listen`; only the
		// sealed-slot change subscription is answered, any other is refused there.
		transformCallback: () => {
			nextCallback += 1;
			return nextCallback;
		},
	},
});

const root = document.getElementById("root");
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
if (!root) {
	throw new Error("Missing Shadow settings proof root");
}

createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<main className="min-h-screen bg-background p-6 text-foreground">
			<div className="mx-auto w-full max-w-5xl space-y-5">
				<header className="space-y-1 border-b pb-4">
					<p className="text-muted-foreground text-xs uppercase tracking-wide">
						Plugin settings
					</p>
					<h1 className="font-heading font-semibold text-2xl">Shadow</h1>
				</header>
				<ShadowSettings />
			</div>
			<Toaster position="bottom-right" theme="system" />
		</main>
	</QueryClientProvider>
);
