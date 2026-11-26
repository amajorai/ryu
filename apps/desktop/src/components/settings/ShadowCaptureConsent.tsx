import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "@ryu/ui/components/alert.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type ShadowCaptureConsent as ConsentState,
	getShadowCaptureConsent,
	type ShadowCaptureKind,
	setShadowCaptureConsent,
} from "@/src/lib/api/shadow-capture-consent.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** Where the section reads and saves the choices. Tests and stories pass a fake. */
export interface ShadowCaptureConsentApi {
	load: () => Promise<ConsentState>;
	set: (kind: ShadowCaptureKind, enabled: boolean) => Promise<ConsentState>;
}

const CORE_API: ShadowCaptureConsentApi = {
	load: getShadowCaptureConsent,
	set: setShadowCaptureConsent,
};

/** A failed request. `message` is what Core said, when it said anything. */
interface Failure {
	message: string | null;
}

function failureOf(error: unknown): Failure {
	return { message: error instanceof Error ? error.message : null };
}

/**
 * The capture consent step for Shadow: one switch per capture kind. Shadow
 * captures nothing until a kind is turned on here, a change takes effect at
 * once, and turning a kind off says where its recordings are and how to delete
 * them. It sits above the Shadow settings, which apply only to the kinds that
 * are on.
 */
export function ShadowCaptureConsent({
	api = CORE_API,
}: {
	api?: ShadowCaptureConsentApi;
}) {
	const tl = useLiteralMessages();
	const [consent, setConsent] = useState<ConsentState | null>(null);
	const [loadFailure, setLoadFailure] = useState<Failure | null>(null);
	const [changeFailure, setChangeFailure] = useState<Failure | null>(null);
	const [busy, setBusy] = useState(false);
	const [turnedOff, setTurnedOff] = useState<ShadowCaptureKind | null>(null);
	const epoch = useRef(0);

	const load = useCallback(async () => {
		epoch.current += 1;
		const current = epoch.current;
		setLoadFailure(null);
		try {
			const next = await api.load();
			if (epoch.current === current) {
				setConsent(next);
			}
		} catch (error) {
			if (epoch.current === current) {
				setLoadFailure(failureOf(error));
			}
		}
	}, [api]);

	useEffect(() => {
		load().catch(() => undefined);
		return () => {
			epoch.current += 1;
		};
	}, [load]);

	const change = async (kind: ShadowCaptureKind, enabled: boolean) => {
		if (busy) {
			return;
		}
		setBusy(true);
		setChangeFailure(null);
		setTurnedOff(null);
		try {
			const next = await api.set(kind, enabled);
			setConsent(next);
			if (!enabled) {
				setTurnedOff(kind);
			}
		} catch (error) {
			setChangeFailure(failureOf(error));
		} finally {
			setBusy(false);
		}
	};

	if (!consent) {
		return loadFailure ? (
			<Alert
				data-testid="shadow-capture-consent-load-error"
				variant="destructive"
			>
				<AlertTitle>Could not load the capture choices</AlertTitle>
				<AlertDescription>
					<p>Nothing was changed. Shadow keeps the choices it started with.</p>
					{loadFailure.message ? <p>{loadFailure.message}</p> : null}
					<Button
						className="mt-2"
						onClick={() => {
							load().catch(() => undefined);
						}}
						size="sm"
						variant="outline"
					>
						Retry
					</Button>
				</AlertDescription>
			</Alert>
		) : (
			<div className="animate-skeleton text-muted-foreground text-xs">
				Loading the capture choices…
			</div>
		);
	}

	const toggle = (kind: ShadowCaptureKind, label: string) => (
		<Switch
			aria-label={label}
			checked={consent.kinds[kind].enabled}
			data-testid={`shadow-capture-consent-${kind}`}
			disabled={busy}
			onCheckedChange={(next) => {
				change(kind, next).catch(() => undefined);
			}}
		/>
	);
	const configuredOnly = (kind: ShadowCaptureKind) =>
		consent.kinds[kind].configured && !consent.kinds[kind].decided;
	const anyConfiguredOnly =
		configuredOnly("screen") ||
		configuredOnly("microphone") ||
		configuredOnly("input") ||
		configuredOnly("activity");

	return (
		<div className="space-y-3" data-testid="shadow-capture-consent">
			<SettingsSection
				caption={tl(
					"Shadow captures nothing until you turn a kind on here. You can turn each kind off again at any time, and the change applies at once. What Shadow captures is stored only on this device, in {folder}. The settings further down apply only to the kinds that are on.",
					{ folder: consent.storage.dataDir }
				)}
				title="What Shadow may capture"
			>
				<SettingsGroup>
					<SettingsItem
						actions={toggle("screen", tl("Capture the screen"))}
						description="Pictures and video of your screens, and the text read from them."
						title="Screen"
					/>
					<SettingsItem
						actions={toggle("microphone", tl("Capture the microphone"))}
						description="Sound from your microphone, saved in two-minute recordings."
						title="Microphone"
					/>
					<SettingsItem
						actions={toggle("input", tl("Capture keyboard and mouse activity"))}
						description="When a key is pressed, and where the mouse clicks and moves. Which key was pressed is never recorded."
						title="Keyboard and mouse"
					/>
					<SettingsItem
						actions={toggle("activity", tl("Capture app activity"))}
						description="The app and window in front, the text of its controls, and clipboard, file, git, terminal, notification and calendar events."
						title="App activity"
					/>
				</SettingsGroup>
			</SettingsSection>

			{anyConfiguredOnly ? (
				<p className="px-3 text-muted-foreground text-xs">
					A kind that is on without your choice was turned on by this device's
					configuration. Turn it off here and it stays off.
				</p>
			) : null}
			{consent.recordState === "unusable" ? (
				<Alert data-testid="shadow-capture-consent-unusable">
					<AlertTitle>The saved choices could not be read</AlertTitle>
					<AlertDescription>
						Every kind is off until you turn it on again.
					</AlertDescription>
				</Alert>
			) : null}
			{turnedOff ? (
				<Alert data-testid="shadow-capture-consent-turned-off">
					<AlertTitle>Capture of this kind is off</AlertTitle>
					<AlertDescription>
						{tl(
							"Shadow no longer captures it. What it recorded before is still on this device, in {folders}. Keep history, further down, deletes it after the number of days you set. To delete it now, quit Ryu and delete those folders. The events folder is shared by every kind.",
							{ folders: consent.storage[turnedOff].join(", ") }
						)}
					</AlertDescription>
				</Alert>
			) : null}
			{consent.applied === "not_running" && !turnedOff ? (
				<p
					className="px-3 text-muted-foreground text-xs"
					data-testid="shadow-capture-consent-not-running"
					role="status"
				>
					Saved. Shadow is not running, so nothing is captured until it starts.
				</p>
			) : null}
			{consent.applied === "stopped" ? (
				<Alert
					data-testid="shadow-capture-consent-stopped"
					variant="destructive"
				>
					<AlertTitle>Shadow was stopped</AlertTitle>
					<AlertDescription>
						Shadow could not restart with this change, so Ryu stopped it.
						Nothing is being captured. Restart Ryu to start Shadow again.
					</AlertDescription>
				</Alert>
			) : null}
			{consent.applied === "failed" ? (
				<Alert
					data-testid="shadow-capture-consent-failed"
					variant="destructive"
				>
					<AlertTitle>Shadow could not be restarted</AlertTitle>
					<AlertDescription>
						Your choice is saved, but Shadow may still be capturing with the
						earlier choices. Quit Ryu to stop it.
					</AlertDescription>
				</Alert>
			) : null}
			{changeFailure ? (
				<Alert
					data-testid="shadow-capture-consent-change-error"
					variant="destructive"
				>
					<AlertTitle>The capture choice was not saved</AlertTitle>
					<AlertDescription>
						<p>Nothing was changed.</p>
						{changeFailure.message ? <p>{changeFailure.message}</p> : null}
					</AlertDescription>
				</Alert>
			) : null}
		</div>
	);
}
