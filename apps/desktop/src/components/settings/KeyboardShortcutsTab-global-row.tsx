import { chordFromElectron, toElectronAccelerator } from "@ryu/hotkeys/chord";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useEffect, useRef, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { ChordRecorder } from "./KeyboardShortcutsTab-chord-recorder.tsx";
import { SettingsItem } from "./shared/settings-items.tsx";

interface GlobalRowProps {
	beginWrite: () => boolean;
	defaultAccelerator: string;
	description: string;
	endWrite: () => void;
	label: string;
	load: (target: ApiTarget) => Promise<string>;
	pendingElsewhere: boolean;
	readVersion: number;
	save: (target: ApiTarget, accelerator: string) => Promise<boolean>;
	target: ApiTarget;
}

/** A system-wide shortcut row, editing the real island/voice preference. */
export function GlobalRow({
	label,
	description,
	defaultAccelerator,
	target,
	pendingElsewhere,
	readVersion,
	beginWrite,
	endWrite,
	load,
	save,
}: GlobalRowProps) {
	const tl = useLiteralMessages();
	const [accelerator, setAccelerator] = useState(defaultAccelerator);
	const [loading, setLoading] = useState(true);
	const [readError, setReadError] = useState(false);
	const [reloadIndex, setReloadIndex] = useState(0);
	const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
	const [pending, setPending] = useState(false);
	const callbacks = useRef({ load, save });
	callbacks.current = { load, save };
	// The effect reads the latest translator without re-running on each render.
	const tlRef = useRef(tl);
	tlRef.current = tl;
	const alive = useRef(false);
	const pendingWrite = useRef(false);

	useEffect(() => {
		let current = true;
		alive.current = true;
		setLoading(true);
		setReadError(false);
		void callbacks.current
			.load(target)
			.then((value) => {
				if (current) {
					setAccelerator(value);
					setLoadedVersion(readVersion);
				}
			})
			.catch(() => {
				if (current) {
					setReadError(true);
					toast.error({
						title: tlRef.current("Couldn't load {label}", { label }),
					});
				}
			})
			.finally(() => {
				if (current) {
					setLoading(false);
				}
			});
		return () => {
			current = false;
			alive.current = false;
		};
	}, [
		target.url,
		target.token,
		target.userJwt,
		label,
		reloadIndex,
		readVersion,
	]);

	const persist = async (next: string) => {
		if (
			!alive.current ||
			loading ||
			loadedVersion !== readVersion ||
			readError ||
			pendingWrite.current ||
			!beginWrite()
		) {
			return;
		}
		pendingWrite.current = true;
		setPending(true);
		const previous = accelerator;
		setAccelerator(next);
		try {
			const ok = await callbacks.current.save(target, next);
			if (!ok) {
				throw new Error("Shortcut preference write was refused");
			}
		} catch {
			if (alive.current) {
				setAccelerator(previous);
				toast.error({ title: tl("Couldn't update {label}", { label }) });
			}
		} finally {
			pendingWrite.current = false;
			endWrite();
			if (alive.current) {
				setPending(false);
			}
		}
	};

	return (
		<SettingsItem
			actions={
				<div className="flex items-center gap-1.5">
					<ChordRecorder
						disabled={
							loading ||
							loadedVersion !== readVersion ||
							readError ||
							pending ||
							pendingElsewhere
						}
						onChange={(chord) => persist(toElectronAccelerator(chord))}
						testId={`global-shortcut-recorder-${label.toLowerCase().replaceAll(" ", "-")}`}
						value={chordFromElectron(accelerator)}
					/>
					<Button
						data-testid={`global-shortcut-reset-${label.toLowerCase().replaceAll(" ", "-")}`}
						disabled={
							loading ||
							loadedVersion !== readVersion ||
							readError ||
							pending ||
							pendingElsewhere ||
							accelerator === defaultAccelerator
						}
						onClick={() => persist(defaultAccelerator)}
						size="sm"
						variant="ghost"
					>
						Reset
					</Button>
					{readError ? (
						<Button
							disabled={loading}
							onClick={() => setReloadIndex((index) => index + 1)}
							size="sm"
							variant="ghost"
						>
							{tl("Retry {label}", { label })}
						</Button>
					) : null}
				</div>
			}
			title={
				<span className="flex flex-col gap-0.5">
					<span>{label}</span>
					<span className="text-muted-foreground text-xs">{description}</span>
				</span>
			}
		/>
	);
}
