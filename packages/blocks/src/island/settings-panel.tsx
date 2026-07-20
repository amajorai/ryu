"use client";

// Settings panel for the expanded island: consent toggles, service endpoints
// (Core/Shadow URLs + optional token), and proactive-engine cadence/cooldown.
//
// Presentational view: the live island wraps this and supplies the persisted
// consent + settings + auto-update state, plus the change handlers. Standalone it
// renders sensible defaults so the surface is explorable without the bridge.
//
// Primitives come from `@ryu/ui` (Switch/Input/Button) for shared a11y and
// behaviour; `className` overrides keep the compact, near-black glass look the
// overlay is tuned for.

import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Switch } from "@ryu/ui/components/switch";

// A compact island text/number field built on the shared Input.
const FIELD_CLASS =
	"h-7 rounded-lg bg-black/30 px-2 py-1 text-neutral-100 text-xs md:text-xs";

export type IslandConsentCapability = "chat" | "contextRead" | "proactive";

const TOGGLE_COPY: Record<IslandConsentCapability, string> = {
	chat: "Chat with Core",
	contextRead: "Read screen context",
	proactive: "Proactive suggestions",
};

const CAPABILITIES: IslandConsentCapability[] = [
	"chat",
	"contextRead",
	"proactive",
];

function ConsentToggle({
	capability,
	value,
	onChange,
}: {
	capability: IslandConsentCapability;
	onChange: (next: boolean) => void;
	value: boolean | null;
}) {
	const id = `island-consent-${capability}`;
	return (
		<label
			className="flex items-center justify-between gap-3 text-neutral-200 text-xs"
			htmlFor={id}
		>
			<span>{TOGGLE_COPY[capability]}</span>
			<Switch
				checked={value === true}
				id={id}
				onCheckedChange={onChange}
				size="sm"
			/>
		</label>
	);
}

export interface IslandSettingsView {
	cooldownSeconds: number;
	coreToken: string | null;
	coreUrl: string;
	pollIntervalSeconds: number;
	shadowUrl: string;
}

export interface SettingsPanelViewProps {
	autoUpdate?: boolean | null;
	consent?: Partial<Record<IslandConsentCapability, boolean | null>>;
	onChangeCooldown?: (value: string) => void;
	onChangeCoreToken?: (value: string) => void;
	onChangeCoreUrl?: (value: string) => void;
	onChangePoll?: (value: string) => void;
	onQuitAndInstall?: () => void;
	onSaveEndpoints?: () => void;
	onSaveEngine?: () => void;
	onSetAutoUpdate?: (next: boolean) => void;
	onSetConsent?: (capability: IslandConsentCapability, next: boolean) => void;
	settings?: IslandSettingsView;
	/** A downloaded update awaiting a restart-to-install. */
	updateReady?: { version?: string | null } | null;
	version?: string | null;
}

const DEFAULT_CONSENT: Record<IslandConsentCapability, boolean | null> = {
	chat: true,
	contextRead: true,
	proactive: false,
};

const DEFAULT_SETTINGS: IslandSettingsView = {
	coreUrl: "http://localhost:7980",
	coreToken: null,
	shadowUrl: "http://localhost:3030",
	pollIntervalSeconds: 45,
	cooldownSeconds: 120,
};

const noop = (): void => {
	// Static-render default; the live island injects the real persisted setters.
};

/** The expanded-island settings panel. */
export function SettingsPanelView({
	consent = DEFAULT_CONSENT,
	settings = DEFAULT_SETTINGS,
	version = "0.4.2",
	autoUpdate = true,
	updateReady = null,
	onSetConsent = noop,
	onSetAutoUpdate = noop,
	onChangeCoreUrl = noop,
	onChangeCoreToken = noop,
	onChangePoll = noop,
	onChangeCooldown = noop,
	onSaveEndpoints = noop,
	onSaveEngine = noop,
	onQuitAndInstall = noop,
}: SettingsPanelViewProps) {
	return (
		<div className="flex flex-col gap-4">
			<section className="flex flex-col gap-2 rounded-2xl bg-white/5 p-3">
				<h3 className="font-semibold text-neutral-100 text-xs">Permissions</h3>
				{CAPABILITIES.map((capability) => (
					<ConsentToggle
						capability={capability}
						key={capability}
						onChange={(next) => onSetConsent(capability, next)}
						value={consent[capability] ?? null}
					/>
				))}
			</section>

			<section className="flex flex-col gap-2 rounded-2xl bg-white/5 p-3">
				<h3 className="font-semibold text-neutral-100 text-xs">Connections</h3>
				<label
					className="flex flex-col gap-1 text-[11px] text-neutral-400"
					htmlFor="island-core-url"
				>
					Core URL
					<Input
						className={FIELD_CLASS}
						defaultValue={settings.coreUrl}
						id="island-core-url"
						onBlur={onSaveEndpoints}
						onChange={(event) => onChangeCoreUrl(event.target.value)}
						type="text"
					/>
				</label>
				<div className="flex flex-col gap-1 text-[11px] text-neutral-400">
					<span>Shadow URL</span>
					<span className={`${FIELD_CLASS} text-neutral-500`}>
						{settings.shadowUrl}
					</span>
					<span className="text-[10px] text-neutral-600">
						Local only — Shadow captures this device and can't be repointed at
						another node.
					</span>
				</div>
				<label
					className="flex flex-col gap-1 text-[11px] text-neutral-400"
					htmlFor="island-core-token"
				>
					Core token (optional)
					<Input
						className={FIELD_CLASS}
						defaultValue={settings.coreToken ?? ""}
						id="island-core-token"
						onBlur={onSaveEndpoints}
						onChange={(event) => onChangeCoreToken(event.target.value)}
						placeholder="RYU_TOKEN"
						type="password"
					/>
				</label>
			</section>

			<section className="flex flex-col gap-2 rounded-2xl bg-white/5 p-3">
				<h3 className="font-semibold text-neutral-100 text-xs">
					Suggestion engine
				</h3>
				<label
					className="flex items-center justify-between gap-2 text-[11px] text-neutral-400"
					htmlFor="island-poll"
				>
					Poll interval (s)
					<Input
						className={`w-20 ${FIELD_CLASS}`}
						defaultValue={String(settings.pollIntervalSeconds)}
						id="island-poll"
						min={1}
						onBlur={onSaveEngine}
						onChange={(event) => onChangePoll(event.target.value)}
						type="number"
					/>
				</label>
				<label
					className="flex items-center justify-between gap-2 text-[11px] text-neutral-400"
					htmlFor="island-cooldown"
				>
					Cooldown (s)
					<Input
						className={`w-20 ${FIELD_CLASS}`}
						defaultValue={String(settings.cooldownSeconds)}
						id="island-cooldown"
						min={1}
						onBlur={onSaveEngine}
						onChange={(event) => onChangeCooldown(event.target.value)}
						type="number"
					/>
				</label>
			</section>

			<section className="flex flex-col gap-2 rounded-2xl bg-white/5 p-3">
				<h3 className="font-semibold text-neutral-100 text-xs">Updates</h3>
				<p className="text-[11px] text-neutral-400">Version {version ?? "…"}</p>
				<label
					className="flex items-center justify-between gap-3 text-neutral-200 text-xs"
					htmlFor="island-auto-update"
				>
					<span>Automatic updates</span>
					<Switch
						checked={autoUpdate === true}
						id="island-auto-update"
						onCheckedChange={(next) => onSetAutoUpdate(next)}
						size="sm"
					/>
				</label>
				{updateReady ? (
					<Button
						className="h-7 self-start"
						onClick={onQuitAndInstall}
						size="xs"
					>
						Restart to update
						{updateReady.version ? ` (${updateReady.version})` : ""}
					</Button>
				) : null}
			</section>
		</div>
	);
}
