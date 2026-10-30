import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { formatDistanceToNow } from "date-fns";
import { useEffect, useRef, useState } from "react";
import {
	clearPluginSecret,
	describeSecretFailure,
	getPluginSecretState,
	type PluginSecretState,
	secretKeyForField,
	secretUpdatedAtMillis,
	setPluginSecret,
} from "@/src/lib/api/plugin-secrets.ts";
import type { FieldControlProps } from "./PluginSettingsFields-save-field.ts";
import { SettingsItem } from "./shared/settings-items.tsx";

/**
 * "Set · 3 minutes ago", "Set", or "Not set" — plus the two ways a stored key can
 * be real yet never used.
 *
 * Both overrides come BEFORE the plain "Set", because in each case the honest
 * answer to "is my key working?" is no. Rendering a confident "Set" for a value
 * the resolver skips is how someone spends an afternoon re-issuing a perfectly
 * good API key.
 */
function secretStatusLabel(state: PluginSecretState | null): string {
	if (!state?.set) {
		return "Not set";
	}
	if (state.readable === false) {
		return "Stored, but this plugin is not allowed to read this name";
	}
	if (state.shadowed_by_env) {
		return "Overridden by an environment variable on this node";
	}
	if (!state.updated_at) {
		return "Set";
	}
	const writtenAt = new Date(secretUpdatedAtMillis(state.updated_at));
	return `Set · ${formatDistanceToNow(writtenAt, { addSuffix: true })}`;
}

/**
 * A write-only credential slot — the control that makes BYOK keys settable
 * without editing env vars and restarting Core.
 *
 * It is NOT preference-backed, and that is the point: a preference is a readable
 * plain string, so an API key stored there would be handed back to anything that
 * can read the KV store. Secrets live behind `/api/plugins/:id/secrets`, which
 * never returns a value. So there is nothing to render but *state* — set or not,
 * and when it was last written — and no reveal affordance, because there is
 * nothing to reveal. A new value overwrites; Clear removes.
 */
export function SecretField({ field, pluginId, target }: FieldControlProps) {
	const secretKey = secretKeyForField(field.prefKey);
	const [state, setState] = useState<PluginSecretState | null>(null);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const stateRevision = useRef(0);

	useEffect(() => {
		let cancelled = false;
		const revision = stateRevision.current;
		// Resolves to null rather than throwing on an unreachable node or a Core
		// too old to have the route — an unreadable store looks exactly like an
		// unset one here, and the panel must still render either way.
		getPluginSecretState(target, pluginId, secretKey).then((stored) => {
			// A user can save while this first read is in flight. Never let its older
			// snapshot overwrite the write-only status that the mutation just saved.
			if (!cancelled && revision === stateRevision.current) {
				setState(stored);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [target, pluginId, secretKey]);

	const isSet = state?.set === true;

	const save = async () => {
		const value = draft.trim();
		if (value === "") {
			return;
		}
		const previous = state;
		setBusy(true);
		try {
			await setPluginSecret(target, pluginId, secretKey, value);
			stateRevision.current += 1;
			const savedState = {
				...previous,
				key: secretKey,
				set: true,
				updated_at: Date.now(),
			};
			setState(savedState);
			// A replacement does not change whether this name is readable or
			// shadowed by the node environment. Refresh metadata, never the value.
			const refreshed = await getPluginSecretState(target, pluginId, secretKey);
			setState(refreshed?.set ? refreshed : savedState);
			// Blank ONLY on success. Clearing optimistically would destroy the one
			// copy of a secret the user just typed if the write turned out to fail.
			setDraft("");
		} catch (e) {
			setState(previous);
			toast.error({
				title: "Couldn't save this secret",
				// Core's refusals here are NOT transient — an unloadable at-rest key,
				// or a key name this plugin may not use. Telling someone to retry a
				// permanent failure sends them to fix the wrong thing.
				description: describeSecretFailure(
					e,
					"Check your connection and try again."
				),
			});
		} finally {
			setBusy(false);
		}
	};

	const clear = async () => {
		const previous = state;
		setBusy(true);
		try {
			await clearPluginSecret(target, pluginId, secretKey);
			stateRevision.current += 1;
			setState({ key: secretKey, set: false });
		} catch (e) {
			setState(previous);
			toast.error({
				title: "Couldn't clear this secret",
				description: describeSecretFailure(
					e,
					"Check your connection and try again."
				),
			});
		} finally {
			setBusy(false);
		}
	};

	return (
		<SettingsItem
			actions={
				<span className="text-muted-foreground text-xs">
					{secretStatusLabel(state)}
				</span>
			}
			title={field.label}
		>
			<div className="flex items-center gap-2">
				<Input
					aria-label={field.label}
					autoComplete="off"
					className="flex-1"
					onChange={(e) => setDraft(e.target.value)}
					placeholder={
						field.placeholder ??
						(isSet ? "Stored — enter a new value to replace" : "Paste a key…")
					}
					size="settings-search"
					type="password"
					value={draft}
				/>
				<Button
					disabled={busy || draft.trim() === ""}
					onClick={save}
					size="sm"
					type="button"
				>
					{busy ? "Saving…" : "Save"}
				</Button>
				{isSet ? (
					<Button
						disabled={busy}
						onClick={clear}
						size="sm"
						type="button"
						variant="ghost"
					>
						Clear
					</Button>
				) : null}
			</div>
		</SettingsItem>
	);
}
