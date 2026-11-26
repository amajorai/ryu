import type { MessageId } from "./en-messages.ts";

type LoginMessageId = Extract<MessageId, `login.${string}`>;

/** Polish sign-in screen messages, the `pl` row of `login-locales.ts`. */
export const POLISH_LOGIN_MESSAGES: Record<LoginMessageId, string> = {
	"login.title": "Cześć, jestem Ryu",
	"login.subtitle": "Twój przyjazny duszek, który mieszka na Twoim pulpicie",
	"login.get-started": "Rozpocznij",
	"login.try-without-account": "Wypróbuj Ryu bez konta",
	"login.starting-guest-session": "Uruchamianie sesji gościa…",
	"login.activate-device": "Aktywuj urządzenie",
	"login.enter-code": "Wpisz poniższy kod na stronie weryfikacji",
	"login.hang-tight": "Poczekaj chwilę, przygotowujemy wszystko",
	"login.waiting-approval": "Czekamy na Twoje zatwierdzenie w przeglądarce…",
	"login.getting-signin-code": "Pobieranie kodu logowania…",
	"login.copy-device-code": "Kopiuj kod urządzenia",
	"login.open": "Otwórz",
	"login.core-downloading-title": "Pobieranie Ryu Core",
	"login.core-setup-title": "Skonfiguruj Ryu Core",
	"login.core-error-title": "Pobieranie Core wymaga pomocy",
	"login.core-build-description":
		"Ryu pobiera wersję Core odpowiednią dla tego komputera.",
	"login.core-start-description":
		"Otwórz pobrany plik, aby uruchomić Core, i zostaw to okno otwarte. Ryu połączy się, gdy tylko Core będzie gotowy.",
	"login.core-downloading": "Pobieranie Ryu Core…",
	"login.core-download-started": "Rozpoczęto pobieranie: {fileName}",
	"login.core-waiting": "Oczekiwanie na Ryu Core…",
	"login.use-cloud": "Użyj zamiast tego Ryu Cloud",
	"login.download-again": "Pobierz ponownie",
	"login.open-core-downloads": "Otwórz pobieranie Core",
	"login.copied": "Skopiowano do schowka",
	"login.device-sign-in-code": "Kod logowania urządzenia",
	"login.copy-sign-in-link": "Kopiuj link logowania",
	"login.sign-in-link-copied": "Skopiowano link logowania",
	"login.copy-sign-in-link-failed": "Nie udało się skopiować linku logowania",
};
