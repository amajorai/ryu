// The composer toolbar's app-contributed controls: the `chip`, `action` and
// bar-placed `select` entries of `contributes.composer_controls[]`.
//
// This is the renderer for the half of the vocabulary that does NOT belong in a
// menu — a live pill, a one-shot button, an inline mode picker. It exists so an
// app can put a real control in the composer declaratively instead of the shell
// hand-writing one per app (the thing `dock_panels` did for the workspace docks).
//
// It plugs into the composer through the EXISTING `rightActions` slot, so it
// reaches every surface that mounts the one InputBar (chat, launchpad, the
// Ask-Ryu dock) without forking a per-surface composer.
//
// Two host rules are load-bearing here:
//   - a `chip` polls its declared `source` through the host's authenticated Core
//     seam (`/api/…` only, exactly like a declarative view) — the manifest never
//     names a host, and no plugin code runs;
//   - an `action` dispatches through `POST /api/plugins/:id/host`, which is
//     grant-gated Core-side, so a capability the owning app was not granted is
//     refused there. The shell never runs plugin code to fire one.

import {
	contributionSourceRequest,
	sourceItemsFromResponse,
} from "@ryu/app-host/views";
import { Button } from "@ryu/ui/components/button.tsx";
import { Icon } from "@ryu/ui/components/icon.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import {
	composerSelectOptions,
	composerSelectValue,
	type KnownComposerControl,
} from "@/src/components/composer/plugin-composer-controls.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { apiUrl, requestHeaders, toTarget } from "@/src/lib/api/client.ts";
import { pluginHostInvoke } from "@/src/lib/api/plugins.ts";

/** How often a `chip` re-reads its source. Slow enough to be free, fast enough
 *  that a pill tracking a recording/selection reads as live. */
const CHIP_POLL_MS = 15_000;

export interface PluginComposerBarControlsProps {
	/** The bar-placed controls, already validated + ordered by
	 *  `partitionComposerControls`. */
	controls: KnownComposerControl[];
	/** An `action` fired: the host marks its `flag` so the turn hook sees it. */
	onActionFired: (flag: string) => void;
	/** A `select` picked, or a `chip`'s live value appearing/clearing. `null`
	 *  clears the flag's value. */
	onValueChange: (flag: string, value: string | null) => void;
	/** The current string value per flag (selects + chips). */
	values: Record<string, string>;
}

/**
 * Render every bar-placed contributed control. Returns nothing when an app
 * contributes none, so the composer toolbar is untouched in the common case.
 */
export function PluginComposerBarControls({
	controls,
	values,
	onValueChange,
	onActionFired,
}: PluginComposerBarControlsProps) {
	if (controls.length === 0) {
		return null;
	}
	return (
		<>
			{controls.map((control) => (
				<PluginComposerBarControl
					control={control}
					key={`${control.plugin}:${control.id}`}
					onActionFired={onActionFired}
					onValueChange={onValueChange}
					values={values}
				/>
			))}
		</>
	);
}

function PluginComposerBarControl({
	control,
	values,
	onValueChange,
	onActionFired,
}: {
	control: KnownComposerControl;
	onActionFired: (flag: string) => void;
	onValueChange: (flag: string, value: string | null) => void;
	values: Record<string, string>;
}) {
	if (control.type === "chip") {
		return <PluginComposerChip control={control} onValue={onValueChange} />;
	}
	if (control.type === "action") {
		return <PluginComposerAction control={control} onFired={onActionFired} />;
	}
	// The remaining bar-placed type is `select` (a bar-placed `toggle` is routed
	// to the "+" menu upstream, since that is the only seam offering toggle rows).
	if (control.type === "select") {
		return (
			<PluginComposerSelect
				control={control}
				onValue={onValueChange}
				values={values}
			/>
		);
	}
	return null;
}

/** The leading glyph of a contributed control, resolved by icon id (Iconify /
 *  Hugeicons / a URL). Absent icon = no glyph, never a broken box. */
function ControlIcon({ icon }: { icon?: string }) {
	if (!icon) {
		return null;
	}
	return <Icon className="shrink-0" icon={icon} size={13} />;
}

/** An inline mode picker: the chosen option's `value` is the control's value. */
function PluginComposerSelect({
	control,
	values,
	onValue,
}: {
	control: KnownComposerControl;
	onValue: (flag: string, value: string | null) => void;
	values: Record<string, string>;
}) {
	const [open, setOpen] = useState(false);
	const options = composerSelectOptions(control);
	const value = composerSelectValue(control, values);
	// Nothing pickable (an options-less or malformed `select`) — render nothing
	// rather than a dead trigger.
	if (options.length === 0) {
		return null;
	}
	const active = options.find((o) => o.value === value);
	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				render={
					<Button
						appearance="composer-settings"
						aria-label={control.label}
						size="sm"
						title={control.description ?? control.label}
						type="button"
						variant="ghost"
					/>
				}
			>
				<ControlIcon icon={control.icon} />
				<span className="truncate">{active?.label ?? control.label}</span>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="max-h-80 w-auto min-w-[200px] max-w-[280px] overflow-y-auto"
				side="top"
				sideOffset={6}
			>
				{options.map((option) => (
					<Button
						appearance={
							option.value === value ? "composer-mode-active" : "composer-mode"
						}
						key={option.value}
						onClick={() => {
							onValue(control.flag, option.value);
							setOpen(false);
						}}
						size="sm"
						type="button"
						variant="ghost"
					>
						<ControlIcon icon={option.icon} />
						<span className="truncate">{option.label}</span>
					</Button>
				))}
			</PopoverContent>
		</Popover>
	);
}

/**
 * A live pill. The declared `source` is polled through the host's authenticated
 * Core seam and the FIRST row is the current value: its title is displayed, its
 * id is exposed through `flag`. An empty result (or a failing source) clears the
 * flag and the pill falls back to the control's own label — so a chip whose app
 * has nothing to report reads as idle instead of stale.
 */
function PluginComposerChip({
	control,
	onValue,
}: {
	control: KnownComposerControl;
	onValue: (flag: string, value: string | null) => void;
}) {
	const node = useActiveNode();
	const target = toTarget(node);
	const source = control.source;
	const sourceRequest = contributionSourceRequest(control, source);
	const fetchable = sourceRequest !== null;

	const { data } = useQuery({
		queryKey: [
			"plugin-composer-chip",
			target.url,
			target.token,
			control.plugin,
			control.id,
			sourceRequest?.path ?? "",
		],
		queryFn: async () => {
			if (!(source && sourceRequest)) {
				return null;
			}
			const resp = await fetch(apiUrl(target, sourceRequest.path), {
				method: sourceRequest.method,
				headers: await requestHeaders(target),
			});
			if (!resp.ok) {
				return null;
			}
			return sourceItemsFromResponse(source, await resp.json());
		},
		enabled: fetchable,
		refetchInterval: CHIP_POLL_MS,
		staleTime: CHIP_POLL_MS,
		retry: false,
	});

	const first = data?.[0]?.item;
	const liveId = first?.id ?? null;
	const flag = control.flag;
	// Mirror the polled value into the composer's control values. `onValue` is a
	// stable, idempotent setter (a repeat of the same value is a no-op), so this
	// settles after one pass instead of looping.
	useEffect(() => {
		onValue(flag, liveId);
	}, [flag, liveId, onValue]);

	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-md px-1.5 text-xs leading-4",
				first ? "text-foreground" : "text-muted-foreground"
			)}
			title={control.description ?? control.label}
		>
			<ControlIcon icon={control.icon} />
			<span className="max-w-[160px] truncate">
				{first?.title ?? control.label}
			</span>
		</span>
	);
}

/**
 * A one-shot button. Dispatches the declared `capability` (+ `args`) through the
 * plugin host bridge — grant-gated in Core — and marks its `flag` on success so
 * the turn hook can see that it fired.
 */
function PluginComposerAction({
	control,
	onFired,
}: {
	control: KnownComposerControl;
	onFired: (flag: string) => void;
}) {
	const node = useActiveNode();
	const [busy, setBusy] = useState(false);
	const capability = control.capability;
	const flag = control.flag;

	const fire = useCallback(async () => {
		if (!capability) {
			return;
		}
		setBusy(true);
		try {
			await pluginHostInvoke(
				toTarget(node),
				control.plugin,
				capability,
				control.args ?? {}
			);
			onFired(flag);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Action failed");
		} finally {
			setBusy(false);
		}
	}, [capability, control.args, control.plugin, flag, node, onFired]);

	// An `action` with no capability has nothing to dispatch — skip it rather
	// than render a button that cannot do anything.
	if (!capability) {
		return null;
	}

	return (
		<Button
			appearance="composer-settings"
			aria-label={control.label}
			disabled={busy}
			onClick={() => {
				void fire();
			}}
			size="sm"
			title={control.description ?? control.label}
			type="button"
			variant="ghost"
		>
			<ControlIcon icon={control.icon} />
			<span className="truncate">{control.label}</span>
		</Button>
	);
}
