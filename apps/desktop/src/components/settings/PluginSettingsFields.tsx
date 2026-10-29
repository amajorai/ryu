import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// apps/desktop/src/components/settings/PluginSettingsFields.tsx
//
// Renders a plugin's declared settings fields as editable controls, each bound
// to Core's generic preference store (`GET/PUT /api/preferences/:key`). This is
// the missing bridge: a plugin declares `contributes.settings_tabs` in its
// manifest, Core serves them via `/api/plugins/contributions`, and this maps each
// field `type` → a control + persists edits under the field's `pref_key`.
//
// It reuses the shared iOS-style settings primitives (SettingsSection / Group /
// Item) so plugin settings look identical to the Gateway cards and the built-in
// settings tabs — nothing bespoke. Field values persist as bare strings
// (booleans as "true"/"false"), matching the conventions in lib/api/preferences.
//
// Used by two surfaces: inline on the Store's installed plugin card (the
// per-plugin "Settings" disclosure) and the App Settings "Plugins" section.

import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { formatDistanceToNow } from "date-fns";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AgentModelPickerField } from "@/components/agent-elements/input/agent-model-picker-field.tsx";
import { AgentSelectionField } from "@/components/agent-elements/input/agent-selection-field.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	clearPluginSecret,
	describeSecretFailure,
	getPluginSecretState,
	type PluginSecretState,
	secretKeyForField,
	secretUpdatedAtMillis,
	setPluginSecret,
} from "@/src/lib/api/plugin-secrets.ts";
import {
	type AgentSelection,
	EMPTY_AGENT_SELECTION,
	getAgentSelection,
	getPreference,
	setAgentSelection,
	setPreference,
} from "@/src/lib/api/preferences.ts";
import {
	type PluginSettingsField,
	type PluginSettingsTab,
	prefToBool,
} from "@/src/lib/pluginSettings.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

async function saveField(
	target: ApiTarget,
	prefKey: string,
	value: string
): Promise<boolean> {
	const showFailure = () => {
		// One options object, not (title, options): `toast.error` takes a single
		// argument (see @ryu/ui/components/sileo), so the two-argument spelling
		// type-errors and drops the description on the floor.
		toast.error({
			title: "Couldn't save this setting",
			description: "Check your connection and try again.",
		});
	};
	try {
		const ok = await setPreference(target, prefKey, value);
		if (!ok) {
			showFailure();
		}
		return ok;
	} catch {
		showFailure();
		return false;
	}
}

// ── Per-type field controls ─────────────────────────────────────────────────

interface FieldControlProps {
	/**
	 * Render this field outside the group's card. Read off THIS element by the
	 * enclosing SettingsGroup — same opt-in as `description` — which is why the
	 * caller passes it rather than the leaf control setting it internally:
	 * `Children.toArray` only sees the wrapper's props, not the `SettingsItem`
	 * buried inside it.
	 */
	bare?: boolean;
	/**
	 * iOS-style footer caption for this field's card. The wrapper never renders
	 * it — the enclosing SettingsGroup reads it off this element and renders it
	 * below the card (see settings-items).
	 */
	description?: ReactNode;
	field: PluginSettingsField;
	/**
	 * The manifest id of the plugin that declared this field. Preference-backed
	 * controls don't need it (a `pref_key` is already node-global), but a `secret`
	 * field does: secrets are scoped per plugin at
	 * `/api/plugins/:id/secrets/:key`. Every tab carries one — `parseSettingsTabs`
	 * drops any entry without a plugin id — so this is always populated.
	 */
	pluginId: string;
	storedPreference?: string | null;
	target: ApiTarget;
}

function ToggleField({ field, target, storedPreference }: FieldControlProps) {
	const defaultOn = field.default === true;
	const [checked, setChecked] = useState(
		prefToBool(storedPreference ?? null, defaultOn)
	);

	return (
		<SettingsItem
			actions={
				<Switch
					aria-label={field.label}
					checked={checked}
					onCheckedChange={async (next) => {
						setChecked(next);
						const ok = await saveField(target, field.prefKey, String(next));
						if (!ok) {
							setChecked(!next);
						}
					}}
				/>
			}
			title={field.label}
		/>
	);
}

function SelectField({ field, target, storedPreference }: FieldControlProps) {
	const fallback = isNativeText(field.default) ? field.default : "";
	const [value, setValue] = useState(storedPreference ?? fallback);

	return (
		<SettingsItem title={field.label}>
			<Select
				items={field.options}
				onValueChange={async (raw) => {
					// Base UI's Select emits `null` when the selection is cleared;
					// preferences store bare strings, so that reads as "unset".
					const next = raw ?? "";
					const previous = value;
					setValue(next);
					const ok = await saveField(target, field.prefKey, next);
					if (!ok) {
						setValue(previous);
					}
				}}
				value={value}
			>
				<SelectTrigger aria-label={field.label} className="h-8 w-full">
					<SelectValue placeholder="Select…" />
				</SelectTrigger>
				<SelectContent>
					{field.options.map((opt) => (
						<SelectItem key={opt.value} value={opt.value}>
							{opt.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</SettingsItem>
	);
}

function TextField({
	bare,
	description,
	field,
	target,
	storedPreference,
}: FieldControlProps) {
	const fallback =
		field.default === undefined || field.default === null
			? ""
			: String(field.default);
	const [value, setValue] = useState(storedPreference ?? fallback);
	const isTextarea = field.type === "textarea";

	const save = () => {
		saveField(target, field.prefKey, value.trim()).catch(() => {
			// saveField already surfaces failures via toast.
		});
	};

	return (
		// A `textarea` field is a tall bordered box; inside the group's card fill it
		// reads as a box in a box, so those rows go `bare` while the single-line
		// `text` fields stay ordinary rows. Driven by the declared field type at the
		// call site, so every plugin that declares a textarea gets the same
		// treatment without touching this file again.
		// `description` is forwarded, not dropped: the group only renders a caption
		// for a CARDED row, so a bare one has to render its own.
		<SettingsItem bare={bare} description={description} title={field.label}>
			{isTextarea ? (
				<Textarea
					aria-label={field.label}
					className="min-h-24"
					onBlur={save}
					onChange={(e) => setValue(e.target.value)}
					placeholder={field.placeholder}
					typography="small"
					value={value}
				/>
			) : (
				<Input
					aria-label={field.label}
					onBlur={save}
					onChange={(e) => setValue(e.target.value)}
					placeholder={field.placeholder}
					size="settings-search"
					type="text"
					value={value}
				/>
			)}
		</SettingsItem>
	);
}

/**
 * Check a `number` field's raw input against the bounds it declared, returning
 * either the string to persist or the reason it was rejected.
 *
 * Two things this deliberately does NOT do. It does not persist `Number(raw)` —
 * preferences are bare strings and the trimmed input already IS the canonical
 * form, so round-tripping through a float would rewrite `1.50` as `1.5` behind
 * the user's back. And it treats an emptied box as "unset", not as zero:
 * `Number("")` is `0`, so a naive parse would silently write a real `0` the user
 * never typed.
 */
function validateNumberInput(
	raw: string,
	field: PluginSettingsField
): { error: string } | { value: string } {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return { value: "" };
	}
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed)) {
		return { error: "Enter a number." };
	}
	if (field.min !== undefined && parsed < field.min) {
		return { error: `Must be ${field.min} or more.` };
	}
	if (field.max !== undefined && parsed > field.max) {
		return { error: `Must be ${field.max} or less.` };
	}
	return { value: trimmed };
}

function NumberField({ field, target, storedPreference }: FieldControlProps) {
	const fallback =
		field.default === undefined || field.default === null
			? ""
			: String(field.default);
	const [value, setValue] = useState(storedPreference ?? fallback);
	// The last value we actually persisted, so a rejected edit has somewhere to
	// snap back to instead of leaving invalid text sitting in a saved-looking box.
	const [committed, setCommitted] = useState(storedPreference ?? fallback);

	// Validate on commit, never mid-keystroke: a bounded field would otherwise
	// fight anyone typing "10" into a min-of-5 box the moment they press "1".
	const save = async (input: HTMLInputElement) => {
		// `badInput` is load-bearing. A `type="number"` input runs the DOM's value
		// sanitization algorithm, so unparseable text ("abc", "1.2.3") never
		// reaches React — `e.target.value` arrives as `""`, indistinguishable from
		// the user clearing the box, and would quietly persist as "unset".
		// `validity.badInput` is the only thing that tells the two apart. The
		// element is reset directly because React's `value` may already equal
		// `committed`, in which case a setState alone re-renders nothing and the
		// rejected text stays on screen.
		if (input.validity.badInput) {
			input.value = committed;
			setValue(committed);
			toast.error(`${field.label} — Enter a number.`);
			return;
		}
		// `step` only constrains the stepper buttons; a TYPED value off the grid
		// (3 where step is 5) is a `stepMismatch`, not `badInput`, and would
		// otherwise persist despite the field declaring a granularity.
		if (field.step !== undefined && input.validity.stepMismatch) {
			setValue(committed);
			// Same suppression the bounds branch below uses: a stored value that
			// violates a granularity the plugin tightened LATER would otherwise toast
			// on every blur, nagging about a value the user never touched.
			if (value !== committed) {
				toast.error(`${field.label} — Must be a multiple of ${field.step}.`);
			}
			return;
		}
		const result = validateNumberInput(value, field);
		if ("error" in result) {
			// Don't nag when the text never changed — a stored value that violates
			// bounds the plugin tightened later would otherwise toast on every blur.
			if (value !== committed) {
				toast.error(`${field.label} — ${result.error}`);
			}
			setValue(committed);
			return;
		}
		if (result.value === committed) {
			setValue(result.value);
			return;
		}
		const previous = committed;
		setValue(result.value);
		setCommitted(result.value);
		try {
			const ok = await saveField(target, field.prefKey, result.value);
			if (!ok) {
				setValue(previous);
				setCommitted(previous);
			}
		} catch {
			// A throwing transport (no node URL configured) still has to roll back —
			// saveField only toasts on a clean non-ok response.
			setValue(previous);
			setCommitted(previous);
		}
	};

	return (
		<SettingsItem title={field.label}>
			<Input
				aria-label={field.label}
				max={field.max}
				min={field.min}
				onBlur={async (e) => {
					await save(e.currentTarget);
				}}
				onChange={(e) => setValue(e.target.value)}
				placeholder={field.placeholder}
				size="settings-search"
				step={field.step}
				type="number"
				value={value}
			/>
		</SettingsItem>
	);
}

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
function SecretField({ field, pluginId, target }: FieldControlProps) {
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

function ModelPickerField({
	field,
	target,
	storedPreference,
}: FieldControlProps) {
	const [value, setValue] = useState(storedPreference ?? "");

	const commit = (next: string) => {
		const previous = value;
		setValue(next);
		void saveField(target, field.prefKey, next.trim()).then((ok) => {
			if (!ok) {
				setValue(previous);
			}
		});
	};

	// The SAME provider/model picker the chat composer uses (brand logos +
	// per-provider model lists), controlled — replaces the old free-text box so a
	// plugin's "which model runs this" is a precise catalog pick, not a typo-prone
	// string.
	return (
		<SettingsItem title={field.label}>
			<div className="flex items-center gap-2">
				<div className="min-w-0 flex-1">
					<AgentModelPickerField
						ariaLabel={field.label}
						mode="model"
						onChange={commit}
						placeholder={field.placeholder ?? "Use default model"}
						target={target}
						value={value}
					/>
				</div>
				{value ? (
					<Button
						aria-label={`Use default for ${field.label}`}
						onClick={() => commit("")}
						size="sm"
						type="button"
						variant="ghost"
					>
						Use default
					</Button>
				) : null}
			</div>
		</SettingsItem>
	);
}

function AgentPickerField({ field, target }: FieldControlProps) {
	const [value, setValue] = useState<AgentSelection>(EMPTY_AGENT_SELECTION);

	useEffect(() => {
		let cancelled = false;
		getAgentSelection(target, field.prefKey).then((stored) => {
			if (!cancelled) {
				setValue(stored);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [target, field.prefKey]);

	// The FULL composer target — agent, provider, model, thinking, effort, access
	// mode — persisted as one selection. A plugin that can be served by an agent
	// (not only a raw model call) declares this instead of `model_picker`; left
	// unset, it inherits the node-wide default from the Gateway dialog.
	const commit = (next: AgentSelection) => {
		const previous = value;
		setValue(next);
		setAgentSelection(target, field.prefKey, next)
			.then((ok) => {
				if (!ok) {
					setValue(previous);
					toast.error({
						title: "Couldn't save this setting",
						description: "Check your connection and try again.",
					});
				}
			})
			.catch(() => {
				setValue(previous);
				toast.error({
					title: "Couldn't save this setting",
					description: "Check your connection and try again.",
				});
			});
	};

	return (
		<SettingsItem title={field.label}>
			<AgentSelectionField
				ariaLabel={field.label}
				onChange={commit}
				placeholder={field.placeholder ?? "Use the default"}
				target={target}
				value={value}
			/>
		</SettingsItem>
	);
}

function LoadedFieldControl(props: FieldControlProps) {
	switch (props.field.type) {
		case "toggle":
			return <ToggleField {...props} />;
		case "select":
			return props.field.options.length > 0 ? (
				<SelectField {...props} />
			) : (
				<TextField {...props} />
			);
		case "number":
			return <NumberField {...props} />;
		case "secret":
			return <SecretField {...props} />;
		case "model_picker":
			return <ModelPickerField {...props} />;
		case "agent_picker":
			return <AgentPickerField {...props} />;
		default:
			// text, textarea, and any unrecognized type render as text.
			return <TextField {...props} />;
	}
}

function FieldControl(props: FieldControlProps) {
	const { field, target } = props;
	const targetUrl = target.url;
	const targetToken = target.token;
	const targetUserJwt = target.userJwt ?? null;
	const preferenceBacked =
		field.type !== "secret" && field.type !== "agent_picker";
	const [loading, setLoading] = useState(preferenceBacked);
	const [failed, setFailed] = useState(false);
	const [storedPreference, setStoredPreference] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (!preferenceBacked) {
			return;
		}
		let cancelled = false;
		setLoading(true);
		setFailed(false);
		getPreference(
			{ url: targetUrl, token: targetToken, userJwt: targetUserJwt },
			field.prefKey
		)
			.then((stored) => {
				if (!cancelled) {
					setStoredPreference(stored);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setFailed(true);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [
		targetUrl,
		targetToken,
		targetUserJwt,
		field.prefKey,
		preferenceBacked,
		attempt,
	]);

	if (preferenceBacked && (loading || failed)) {
		return (
			<SettingsItem title={field.label}>
				{failed ? (
					<div className="flex items-center gap-2">
						<span role="alert">Couldn't load this setting.</span>
						<Button
							onClick={() => setAttempt((value) => value + 1)}
							size="sm"
							variant="ghost"
						>
							Retry
						</Button>
					</div>
				) : (
					<span role="status">Loading…</span>
				)}
			</SettingsItem>
		);
	}
	return <LoadedFieldControl {...props} storedPreference={storedPreference} />;
}

// ── Tab + panel ─────────────────────────────────────────────────────────────

interface PluginSettingsFieldsProps {
	/** Hide each tab's title header (used inline where the plugin name is already shown). */
	hideTabTitles?: boolean;
	tabs: PluginSettingsTab[];
	target: ApiTarget;
}

/**
 * Footer caption for a picker field the plugin didn't describe itself. Both
 * picker types say the same load-bearing thing — blank inherits the node-wide
 * default set in the Gateway dialog, so "blank" is a real choice, not an
 * oversight.
 */
function defaultFieldDescription(type: string): string | undefined {
	if (type === "model_picker") {
		return "Any model the Gateway can route. Leave blank to use the node's default.";
	}
	if (type === "agent_picker") {
		return "An agent, or a provider and model. Leave blank to use the node's default.";
	}
	if (type === "secret") {
		return "Stored on this node and never shown again. Enter a new value to replace it.";
	}
	return undefined;
}

/**
 * Render one plugin's settings tabs. Each tab becomes a {@link SettingsSection}
 * with a grouped card of its fields.
 */
export function PluginSettingsFields({
	hideTabTitles,
	tabs,
	target,
}: PluginSettingsFieldsProps) {
	const targetUrl = target.url;
	const targetToken = target.token;
	const targetUserJwt = target.userJwt ?? null;
	// Callers may reconstruct ApiTarget during unrelated parent renders. Keep
	// reads and write-only metadata tied to its identity, not its object reference.
	const stableTarget = useMemo(
		() => ({ url: targetUrl, token: targetToken, userJwt: targetUserJwt }),
		[targetUrl, targetToken, targetUserJwt]
	);
	return (
		<div className="space-y-4">
			{tabs.map((tab) => (
				<SettingsSection
					key={tab.id}
					title={hideTabTitles ? undefined : tab.title}
				>
					<SettingsGroup>
						{tab.fields.map((field) => (
							<FieldControl
								bare={field.type === "textarea"}
								description={
									field.description ?? defaultFieldDescription(field.type)
								}
								field={field}
								key={`${target.url}:${tab.plugin}:${field.prefKey}`}
								pluginId={tab.plugin}
								target={stableTarget}
							/>
						))}
					</SettingsGroup>
				</SettingsSection>
			))}
		</div>
	);
}
