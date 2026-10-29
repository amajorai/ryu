import { LoginView } from "@ryu/blocks/desktop/login.tsx";
import { I18nProvider, useI18n } from "@ryu/i18n/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

function LoginProofSurface() {
	const { selectPack } = useI18n();
	const [waiting, setWaiting] = useState(false);

	return (
		<main className="min-h-dvh bg-background p-8 text-foreground">
			<div className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-xl flex-col gap-4">
				<button
					className="self-end text-sm underline underline-offset-4"
					data-testid="switch-arabic"
					onClick={() => selectPack("official/ar")}
					type="button"
				>
					Switch to Arabic
				</button>
				<div className="min-h-0 flex-1 overflow-hidden rounded-3xl border bg-card">
					<LoginView
						hasVerificationUri={waiting}
						onCancel={() => setWaiting(false)}
						onContinueAsGuest={() => undefined}
						onSignIn={() => setWaiting(true)}
						userCode={waiting ? "ABCD1234" : null}
						waiting={waiting}
					/>
				</div>
			</div>
		</main>
	);
}

function App() {
	return (
		<I18nProvider initialPackId="official/es">
			<LoginProofSurface />
		</I18nProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<App />);
}
