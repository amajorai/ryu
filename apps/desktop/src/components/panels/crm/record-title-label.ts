// A record with nothing to name it by is stored with the backend's English
// placeholder "Untitled <object singular, lowercased>" (`record_title` in
// crm/backend/src/store/validation.rs), so a ja or ar viewer saw "Untitled
// company". The placeholder is translated here when shown: one whole sentence
// per seed object, and a template that inserts the user's own object name for a
// custom object. A title the user typed is never rewritten.

import { type MessageValuesInput, translate } from "@ryu/i18n/core";
import type { ValueBag } from "@/src/lib/api/crm.ts";

type Translate = (source: string, values?: MessageValuesInput) => string;

const SEED_UNTITLED: Readonly<Record<string, (tl: Translate) => string>> = {
	"Untitled company": (tl) => tl("Untitled company"),
	"Untitled deal": (tl) => tl("Untitled deal"),
	"Untitled note": (tl) => tl("Untitled note"),
	"Untitled person": (tl) => tl("Untitled person"),
	"Untitled task": (tl) => tl("Untitled task"),
};

const UNTITLED_OBJECT = /^Untitled (\S.*)$/u;

/** The record title as the viewer reads it. */
export function localizedRecordTitle(
	title: string,
	values: ValueBag | undefined,
	tl: Translate = translate
): string {
	// The backend takes the title from a text field when one has a value, so a
	// title equal to a stored value is the user's own text, whatever it says.
	if (values && Object.values(values).includes(title)) {
		return title;
	}
	const seed = SEED_UNTITLED[title];
	if (seed) {
		return seed(tl);
	}
	const match = UNTITLED_OBJECT.exec(title);
	if (!match) {
		return title;
	}
	return tl("Untitled {object}", { object: match[1] });
}
