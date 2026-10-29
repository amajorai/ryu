import { createRoot } from "react-dom/client";
import { TelegramLaunchGate } from "../../../webapp/src/telegram/TelegramLaunchGate.tsx";
import type { TelegramWebApp } from "../../../webapp/src/telegram/telegram-web-app.ts";
import "./telegram-session-proof.css";

document.documentElement.dataset.activeAccount = "current-account";
localStorage.removeItem("ryu_telegram_user_id");
const webApp: TelegramWebApp = {
	BackButton: {
		hide: () => undefined,
		show: () => undefined,
		isVisible: false,
		onClick: () => undefined,
		offClick: () => undefined,
	},
	colorScheme: "light",
	expand: () => undefined,
	onEvent: () => undefined,
	offEvent: () => undefined,
	platform: "web",
	initData: "signed-test-launch",
	initDataUnsafe: {
		user: { id: 42, first_name: "Telegram", username: "telegram_example" },
	},
	ready: () => undefined,
	openLink: () => undefined,
};
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<TelegramLaunchGate webApp={webApp}>
			<main className="flex h-full items-center justify-center bg-background p-8 text-foreground">
				<h1 className="font-semibold text-lg">
					Your selected Ryu account is active
				</h1>
			</main>
		</TelegramLaunchGate>
	);
}
