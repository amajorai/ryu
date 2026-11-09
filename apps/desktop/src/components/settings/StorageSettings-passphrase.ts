import type { LiteralMessage } from "@ryu/i18n/react";
import { MIN_BACKUP_PASSPHRASE_CHARS } from "./StorageSettings-model.ts";

/** Why the export passphrase pair cannot be used yet, in the reader's
 *  language, or `null` when it is long enough and confirmed. */
export function exportPassphraseErrorText(
	passphrase: string,
	confirm: string,
	tl: LiteralMessage
): string | null {
	if ([...passphrase].length < MIN_BACKUP_PASSPHRASE_CHARS) {
		return tl("Use at least {count} characters.", {
			count: MIN_BACKUP_PASSPHRASE_CHARS,
		});
	}
	if (passphrase !== confirm) {
		return tl("The passphrases do not match.");
	}
	return null;
}
