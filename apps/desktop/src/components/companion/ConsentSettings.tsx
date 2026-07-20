// apps/desktop/src/components/companion/ConsentSettings.tsx
//
// Companion consent settings panel — lets the user independently opt-in to
// each companion capability (context read, proactive, do-it), manage a per-app
// allowlist, and toggle pause/incognito mode.
//
// Settings are persisted locally via tauri-plugin-store (companion.bin) so they
// survive restarts. On every change the pause/allowlist is immediately pushed to
// Shadow via POST /capture/control.
//
// No telemetry; purely local storage. Disabled by default per CLAUDE.md.

import { useCallback, useEffect, useState } from "react";
import type { CaptureControl } from "@/src/lib/api/shadow.ts";
import { setCaptureControl } from "@/src/lib/api/shadow.ts";

// ── Capability flags ────────────────────────────────────────────────────────

export interface CompanionConsent {
	/** Allow reading the active window + selected text (context pill). */
	contextRead: boolean;
	/** Allow Ghost computer-use actions. */
	doIt: boolean;
	/** Allow proactive suggestions from Shadow. */
	proactive: boolean;
}

const CONSENT_DEFAULTS: CompanionConsent = {
	contextRead: false,
	proactive: false,
	doIt: false,
};

const STORE_KEY_CONSENT = "companion_consent";
const STORE_KEY_ALLOWLIST = "companion_app_allowlist";
const STORE_KEY_PAUSED = "companion_paused";

// ── Tauri store helpers ─────────────────────────────────────────────────────

let storePromise: Promise<import("@tauri-apps/plugin-store").Store> | null =
	null;

function getCompanionStore(): Promise<
	import("@tauri-apps/plugin-store").Store
> {
	if (!storePromise) {
		storePromise = import("@tauri-apps/plugin-store").then(({ load }) =>
			load("companion.bin")
		);
	}
	return storePromise;
}

async function readConsent(): Promise<CompanionConsent> {
	try {
		const store = await getCompanionStore();
		const saved = await store.get<CompanionConsent>(STORE_KEY_CONSENT);
		return saved ?? CONSENT_DEFAULTS;
	} catch {
		return CONSENT_DEFAULTS;
	}
}

async function saveConsent(consent: CompanionConsent): Promise<void> {
	try {
		const store = await getCompanionStore();
		await store.set(STORE_KEY_CONSENT, consent);
		await store.save();
	} catch {
		// Non-fatal: settings are best-effort.
	}
}

async function readAllowlist(): Promise<string[]> {
	try {
		const store = await getCompanionStore();
		return (await store.get<string[]>(STORE_KEY_ALLOWLIST)) ?? [];
	} catch {
		return [];
	}
}

async function saveAllowlist(list: string[]): Promise<void> {
	try {
		const store = await getCompanionStore();
		await store.set(STORE_KEY_ALLOWLIST, list);
		await store.save();
	} catch {
		// Non-fatal.
	}
}

async function readPaused(): Promise<boolean> {
	try {
		const store = await getCompanionStore();
		return (await store.get<boolean>(STORE_KEY_PAUSED)) ?? false;
	} catch {
		return false;
	}
}

async function savePaused(paused: boolean): Promise<void> {
	try {
		const store = await getCompanionStore();
		await store.set(STORE_KEY_PAUSED, paused);
		await store.save();
	} catch {
		// Non-fatal.
	}
}

// ── ConsentSettings component ───────────────────────────────────────────────

interface ConsentSettingsProps {
	/** Called whenever the consent flags change so CompanionPage can re-gate sections. */
	onConsentChange?: (consent: CompanionConsent) => void;
	/** Called whenever pause state changes so CompanionPage can update the indicator. */
	onPausedChange?: (paused: boolean) => void;
}

export default function ConsentSettings({
	onConsentChange,
	onPausedChange,
}: ConsentSettingsProps) {
	const [consent, setConsent] = useState<CompanionConsent>(CONSENT_DEFAULTS);
	const [paused, setPaused] = useState(false);
	const [allowlistRaw, setAllowlistRaw] = useState("");
	const [allowlist, setAllowlist] = useState<string[]>([]);
	const [shadowControl, setShadowControl] = useState<CaptureControl | null>(
		null
	);
	const [ready, setReady] = useState(false);

	// Load persisted settings on mount and push them to Shadow so enforcement
	// survives a Shadow restart.
	useEffect(() => {
		let cancelled = false;
		Promise.all([readConsent(), readAllowlist(), readPaused()]).then(
			async ([savedConsent, savedList, savedPaused]) => {
				if (cancelled) {
					return;
				}
				setConsent(savedConsent);
				setAllowlist(savedList);
				setAllowlistRaw(savedList.join(", "));
				setPaused(savedPaused);
				onConsentChange?.(savedConsent);
				onPausedChange?.(savedPaused);

				// Push persisted state to Shadow (may be restarted since last session).
				const ctrl = await setCaptureControl({
					paused: savedPaused,
					app_allowlist: savedList,
				});
				if (!cancelled) {
					setShadowControl(ctrl);
				}
				setReady(true);
			}
		);
		return () => {
			cancelled = true;
		};
	}, [onConsentChange, onPausedChange]);

	const handleConsentToggle = useCallback(
		async (key: keyof CompanionConsent) => {
			const next = { ...consent, [key]: !consent[key] };
			setConsent(next);
			await saveConsent(next);
			onConsentChange?.(next);
		},
		[consent, onConsentChange]
	);

	const handlePauseToggle = useCallback(async () => {
		const next = !paused;
		setPaused(next);
		await savePaused(next);
		onPausedChange?.(next);
		const ctrl = await setCaptureControl({ paused: next });
		setShadowControl(ctrl);
	}, [paused, onPausedChange]);

	const handleAllowlistCommit = useCallback(async () => {
		const parsed = allowlistRaw
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		setAllowlist(parsed);
		await saveAllowlist(parsed);
		const ctrl = await setCaptureControl({ app_allowlist: parsed });
		setShadowControl(ctrl);
	}, [allowlistRaw]);

	if (!ready) {
		return (
			<div className="animate-pulse px-4 py-3 text-muted-foreground text-xs">
				Loading consent settings…
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4 p-4">
			<h2 className="font-semibold text-sm">Companion Consent</h2>
			<p className="text-muted-foreground text-xs">
				All capabilities are off by default. Enable only what you need. Settings
				are stored locally — no telemetry.
			</p>

			{/* ── Capability toggles ─────────────────────────────────────────── */}
			<fieldset className="flex flex-col gap-3">
				<legend className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
					Capabilities
				</legend>

				<CapabilityToggle
					checked={consent.contextRead}
					description="Reads the active window name and selected text for context-aware suggestions."
					label="Context read"
					onChange={() =>
						handleConsentToggle("contextRead").catch(() => undefined)
					}
				/>
				<CapabilityToggle
					checked={consent.proactive}
					description="Allows Shadow to surface proactive suggestions based on screen activity."
					label="Proactive suggestions"
					onChange={() =>
						handleConsentToggle("proactive").catch(() => undefined)
					}
				/>
				<CapabilityToggle
					checked={consent.doIt}
					description="Enables Ghost computer-use actions (Focus App, Click Element, Screenshot)."
					label="Do it (Ghost actions)"
					onChange={() => handleConsentToggle("doIt").catch(() => undefined)}
				/>
			</fieldset>

			{/* ── Per-app allowlist ──────────────────────────────────────────── */}
			<fieldset className="flex flex-col gap-2">
				<legend className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
					App allowlist
				</legend>
				<p className="text-muted-foreground text-xs">
					Comma-separated list of app names. Leave empty to allow all apps.
					{allowlist.length > 0 && (
						<span className="ml-1 font-medium text-foreground">
							Active ({allowlist.length} app
							{allowlist.length === 1 ? "" : "s"}).
						</span>
					)}
				</p>
				<div className="flex gap-2">
					<input
						aria-label="App allowlist — comma-separated app names"
						className="flex-1 rounded-md bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
						onBlur={() => handleAllowlistCommit().catch(() => undefined)}
						onChange={(e) => setAllowlistRaw(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								handleAllowlistCommit().catch(() => undefined);
							}
						}}
						placeholder="e.g. VSCode, Terminal, Chrome"
						type="text"
						value={allowlistRaw}
					/>
					<button
						className="rounded-md bg-background px-3 py-1.5 text-sm transition-colors hover:bg-accent"
						onClick={() => handleAllowlistCommit().catch(() => undefined)}
						type="button"
					>
						Apply
					</button>
				</div>
			</fieldset>

			{/* ── Pause / incognito ──────────────────────────────────────────── */}
			<div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2">
				<div className="flex flex-col gap-0.5">
					<span className="font-medium text-sm">
						{paused ? "Paused (incognito)" : "Capture active"}
					</span>
					<span className="text-muted-foreground text-xs">
						{paused
							? "Shadow is not recording. /context/current returns empty."
							: "Shadow is capturing context normally."}
					</span>
				</div>
				<button
					className={`rounded-md border px-3 py-1.5 font-medium text-sm transition-colors ${
						paused
							? "border-warning/50 bg-warning/10 text-warning hover:bg-warning/20 dark:text-warning"
							: "hover:bg-accent hover:text-accent-foreground"
					}`}
					onClick={() => handlePauseToggle().catch(() => undefined)}
					type="button"
				>
					{paused ? "Resume" : "Pause"}
				</button>
			</div>

			{/* Shadow control status — show when Shadow is unreachable */}
			{shadowControl === null && (
				<p className="text-muted-foreground text-xs">
					Shadow is not running — consent settings will take effect when it
					starts.
				</p>
			)}
		</div>
	);
}

// ── CapabilityToggle sub-component ─────────────────────────────────────────

interface CapabilityToggleProps {
	checked: boolean;
	description: string;
	label: string;
	onChange: () => void;
}

function CapabilityToggle({
	checked,
	description,
	label,
	onChange,
}: CapabilityToggleProps) {
	return (
		<label className="flex cursor-pointer items-start gap-3">
			<input
				checked={checked}
				className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
				onChange={onChange}
				type="checkbox"
			/>
			<div className="flex flex-col gap-0.5">
				<span className="font-medium text-sm">{label}</span>
				<span className="text-muted-foreground text-xs">{description}</span>
			</div>
		</label>
	);
}
