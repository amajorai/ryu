import { useI18n } from "@ryu/i18n/react";
import { useEffect, useState } from "react";
import { useSession } from "@/lib/auth-client.ts";
import { LANGUAGE_MODE_CHANGED_EVENT } from "@/src/hooks/useLanguageMode.ts";

/**
 * Saves the language the person picks in Desktop on their cloud account so
 * email uses it. Only explicit choices count: Language settings and the
 * Marketplace "use this language" flow both call `setLanguageMode`, whose
 * event arms the sync; the locale they then select is saved. Startup pack
 * restoration and OS auto-detection alone never write, so launching Desktop
 * cannot overwrite a language chosen on the website. Render it inside
 * `LanguagePackBridge`; `save` is debounced (`src/lib/account-locale.ts`).
 * A choice made while signed out is saved once a person signs in: the
 * signed-in user id re-runs `save.flushPending`.
 */
export function AccountLocaleSync({
	save,
}: {
	save: ((locale: string) => void) & { flushPending?: () => Promise<void> };
}) {
	const { locale } = useI18n();
	const { data: session } = useSession();
	const userId =
		session?.user && !session.user.isAnonymous ? session.user.id : null;
	useEffect(() => {
		if (userId) {
			save.flushPending?.().catch(() => undefined);
		}
	}, [save, userId]);
	const [choices, setChoices] = useState(0);
	useEffect(() => {
		const onChoice = () => setChoices((count) => count + 1);
		window.addEventListener(LANGUAGE_MODE_CHANGED_EVENT, onChoice);
		return () =>
			window.removeEventListener(LANGUAGE_MODE_CHANGED_EVENT, onChoice);
	}, []);
	useEffect(() => {
		if (choices > 0) {
			save(locale);
		}
	}, [choices, locale, save]);
	return null;
}
