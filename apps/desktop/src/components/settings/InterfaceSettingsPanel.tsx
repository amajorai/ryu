// Settings → Appearance → Interfaces: one interface's own settings (the
// fields its renderer or Marketplace contribution declares), read from the
// same schema the protocol validates, saved as per-interface overrides, and
// applied live by the interface host. The shared "Hide work details" option
// sits here too, since it applies to every interface.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	type InterfaceDescriptor,
	type InterfaceSettingField,
	type InterfaceSettingValue,
	interfaceParamsWithOverrides,
	interfaceSettingsFor,
	interfaceTier,
	settingValueFits,
} from "@ryuhq/protocol/interfaces";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	useActiveInterfaceFromStore,
	useInterfaceStore,
} from "@/src/interfaces/interface-store.ts";
import { availableInterfaces } from "@/src/interfaces/registry.ts";
import { useInterfacePrefs } from "@/src/interfaces/use-interface-prefs.ts";
import { useInterfaceSettings } from "@/src/interfaces/use-interface-settings.ts";
import { useProductModeStore } from "@/src/lib/product-mode.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

const EMPTY_VALUES: Readonly<Record<string, InterfaceSettingValue>> = {};

/** The interfaces worth adjusting: the active one and every workspace one. */
function useAdjustableInterfaces(
	active: InterfaceDescriptor
): InterfaceDescriptor[] {
	const contributed = useInterfaceStore((state) => state.contributed);
	const workspaceInterfaces = useInterfaceStore(
		(state) => state.workspaceInterfaces
	);
	const osAccess = useProductModeStore((state) => state.osAccess);
	return useMemo(() => {
		const workspace = availableInterfaces({
			canSwitchToConsole: false,
			canSwitchToOs: osAccess,
			contributed,
			workspaceInterfaces,
		}).filter(
			(descriptor) => interfaceTier(descriptor.renderer) === "workspace"
		);
		return workspace.some((descriptor) => descriptor.id === active.id)
			? workspace
			: [active, ...workspace];
	}, [active, contributed, osAccess, workspaceInterfaces]);
}

/**
 * A number field keeps what is being typed as a draft, so a partial value
 * ("5" on the way to "50", "0." on the way to "0.75") is not rejected and reset
 * on every keystroke. The draft commits on blur and Enter, and at once for a
 * spinner or arrow-key step (no `inputType` on that input event); an
 * out-of-range draft reverts to the saved value.
 */
function NumberSettingControl({
	field,
	id,
	onChange,
	value,
}: {
	field: InterfaceSettingField;
	id: string;
	onChange: (value: InterfaceSettingValue) => void;
	value: InterfaceSettingValue;
}) {
	const saved = typeof value === "number" ? String(value) : "";
	const [draft, setDraft] = useState(saved);
	useEffect(() => {
		setDraft(saved);
	}, [saved]);

	const commit = (text: string) => {
		const parsed = text.trim() === "" ? Number.NaN : Number(text);
		if (settingValueFits(field, parsed)) {
			onChange(parsed);
			setDraft(String(parsed));
			return;
		}
		setDraft(saved);
	};

	return (
		<Input
			aria-label={field.label}
			className="w-28"
			id={id}
			max={field.max}
			min={field.min}
			onBlur={() => commit(draft)}
			onChange={(event) => {
				const text = event.currentTarget.value;
				setDraft(text);
				const inputType = (event.nativeEvent as InputEvent).inputType;
				if (inputType === undefined) {
					commit(text);
				}
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					commit(draft);
				}
			}}
			size="compact"
			step={field.step}
			type="number"
			value={draft}
		/>
	);
}

function SettingControl({
	field,
	onChange,
	value,
}: {
	field: InterfaceSettingField;
	onChange: (value: InterfaceSettingValue) => void;
	value: InterfaceSettingValue;
}) {
	const id = `interface-setting-${field.key}`;
	switch (field.type) {
		case "boolean":
			return (
				<Switch
					aria-label={field.label}
					checked={value === true}
					id={id}
					onCheckedChange={(checked) => onChange(checked === true)}
				/>
			);
		case "select": {
			const options = field.options ?? [];
			return (
				<Select
					items={options}
					onValueChange={(next) => {
						if (settingValueFits(field, next)) {
							onChange(next);
						}
					}}
					value={String(value)}
				>
					<SelectTrigger aria-label={field.label} className="h-8 w-56" id={id}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{options.map((option) => (
							<SelectItem key={String(option.value)} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			);
		}
		case "number":
			return (
				<NumberSettingControl
					field={field}
					id={id}
					onChange={onChange}
					value={value}
				/>
			);
		default:
			return (
				<Input
					aria-label={field.label}
					className="w-56"
					id={id}
					maxLength={128}
					onChange={(event) => onChange(event.currentTarget.value)}
					size="compact"
					value={typeof value === "string" ? value : ""}
				/>
			);
	}
}

/** The current value of each field: the user's override, else the default. */
function currentValue(
	field: InterfaceSettingField,
	params: Readonly<Record<string, unknown>>
): InterfaceSettingValue {
	const value = params[field.key];
	return settingValueFits(field, value) ? value : field.default;
}

export function InterfaceSettingsPanel() {
	const tl = useLiteralMessages();
	const active = useActiveInterfaceFromStore();
	const interfaces = useAdjustableInterfaces(active);
	const focusedId = useInterfaceSettings((state) => state.focusedId);
	const focusInterface = useInterfaceSettings((state) => state.focusInterface);
	// The switcher sets the focus before it opens Settings, so the handoff still
	// works. Clear it when the panel unmounts (the dialog closes or the user leaves
	// the sub-page) so a later visit shows the active interface, not a stale pick.
	// React StrictMode's simulated unmount in development runs the cleanup and then
	// the setup again; the ref hands the pick back so that pass keeps the handoff.
	const pickAtCleanup = useRef<string | null>(null);
	useEffect(() => {
		if (pickAtCleanup.current !== null) {
			focusInterface(pickAtCleanup.current);
			pickAtCleanup.current = null;
		}
		return () => {
			pickAtCleanup.current = useInterfaceSettings.getState().focusedId;
			focusInterface(null);
		};
	}, [focusInterface]);
	const selected =
		interfaces.find((descriptor) => descriptor.id === focusedId) ?? active;
	const overrides =
		useInterfaceSettings((state) => state.overrides[selected.id]) ??
		EMPTY_VALUES;
	const setSettings = useInterfaceSettings((state) => state.setSettings);
	const resetSettings = useInterfaceSettings((state) => state.resetSettings);
	const hideWorkDetails = useInterfacePrefs((state) => state.hideWorkDetails);
	const setHideWorkDetails = useInterfacePrefs(
		(state) => state.setHideWorkDetails
	);

	const fields = interfaceSettingsFor(selected);
	const params = interfaceParamsWithOverrides(selected, overrides);
	const pickerItems = interfaces.map((descriptor) => ({
		label: descriptor.label,
		value: descriptor.id,
	}));

	return (
		<>
			<SettingsSection title="Interfaces">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Select
								items={pickerItems}
								onValueChange={(next) =>
									focusInterface(typeof next === "string" ? next : null)
								}
								value={selected.id}
							>
								<SelectTrigger
									aria-label="Interface"
									className="h-8 w-56"
									data-testid="interface-settings-picker"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{pickerItems.map((item) => (
										<SelectItem key={item.value} value={item.value}>
											{item.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description={
							selected.id === active.id
								? "The interface you're using now."
								: "Changes apply the next time you open it, or right away if it's open."
						}
						title="Interface"
					/>
				</SettingsGroup>
			</SettingsSection>
			<SettingsSection
				title={tl("{label} settings", { label: selected.label })}
			>
				{fields.length > 0 ? (
					<SettingsGroup>
						{fields.map((field) => (
							<SettingsItem
								actions={
									<SettingControl
										field={field}
										onChange={(value) =>
											setSettings(selected.id, { [field.key]: value })
										}
										value={currentValue(field, params)}
									/>
								}
								description={field.description}
								key={field.key}
								title={field.label}
							/>
						))}
						<SettingsItem
							actions={
								<Button
									data-testid="interface-settings-reset"
									disabled={Object.keys(overrides).length === 0}
									onClick={() => resetSettings(selected.id)}
									size="sm"
									variant="outline"
								>
									Reset
								</Button>
							}
							description="Put this interface's settings back to how it ships."
							title="Reset to defaults"
						/>
					</SettingsGroup>
				) : (
					<p
						className="px-1 text-muted-foreground text-sm"
						data-testid="interface-settings-empty"
					>
						This interface has no settings of its own.
					</p>
				)}
			</SettingsSection>
			<SettingsSection title="Every interface">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Hide work details"
								checked={hideWorkDetails}
								data-testid="interface-settings-hide-work-details"
								onCheckedChange={(checked) =>
									setHideWorkDetails(checked === true)
								}
							/>
						}
						description="Show kinds and counts but no thread titles or message text, for a shared screen."
						title="Hide work details"
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);
}
