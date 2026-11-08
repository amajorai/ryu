// Settings → Appearance → Interfaces: display labels that replace a field's
// protocol label when the bare word would translate in the wrong sense. The
// protocol schema (`@ryuhq/protocol/interfaces`) keeps its stored keys and
// labels; only what the panel shows changes.
//
// The passport renderer's `cover` setting picks the booklet's cover colour,
// but the catalog's "Cover" is the image-fit sense (de "Füllen", zh-CN
// "填充"), so the panel shows its own whole message, "Cover color".
import type { LiteralMessage } from "@ryu/i18n/react";
import type {
	InterfaceDescriptor,
	InterfaceSettingField,
} from "@ryuhq/protocol/interfaces";

type SettingsOwner = Pick<InterfaceDescriptor, "renderer" | "settings">;

/** The label the panel shows for one interface's settings field. */
export function interfaceSettingLabel(
	owner: SettingsOwner,
	field: Pick<InterfaceSettingField, "key" | "label">,
	tl: LiteralMessage
): string {
	// A Marketplace interface that declares its own settings owns its labels.
	const builtIn = owner.settings === undefined;
	if (builtIn && owner.renderer === "passport" && field.key === "cover") {
		return tl("Cover color");
	}
	return field.label;
}

/** The field with its display label, for the controls that read `label`. */
export function withDisplayLabel<Field extends InterfaceSettingField>(
	owner: SettingsOwner,
	field: Field,
	tl: LiteralMessage
): Field {
	const label = interfaceSettingLabel(owner, field, tl);
	return label === field.label ? field : { ...field, label };
}
