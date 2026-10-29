import { LoginView } from "@ryu/blocks/desktop/login.tsx";
import DeviceActivate from "@ryu/blocks/web/device-activate.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const verificationUri = "https://example.test/device?user_code=ABCD1234";

function DesktopSignInProof() {
	return (
		<main className="h-screen bg-background text-foreground">
			<LoginView
				hasVerificationUri
				onOpenVerification={() => {
					document.documentElement.dataset.openedVerification = "true";
				}}
				polling
				userCode="ABCD1234"
				verificationUri={verificationUri}
				waiting
			/>
		</main>
	);
}

function BrowserDeviceProof({ length = 8 }: { length?: number }) {
	const [userCode, setUserCode] = useState("");
	const [completedCode, setCompletedCode] = useState("");

	return (
		<main className="min-h-screen bg-background text-foreground">
			<span className="sr-only" data-testid="completed-code">
				{completedCode}
			</span>
			<DeviceActivate
				length={length}
				onCodeComplete={setCompletedCode}
				onSubmit={(event) => event.preventDefault()}
				onUserCodeChange={setUserCode}
				userCode={userCode}
			/>
		</main>
	);
}

function App() {
	const surface = new URLSearchParams(window.location.search).get("surface");
	if (surface === "web-short") {
		return <BrowserDeviceProof length={6} />;
	}
	return surface === "web" ? <BrowserDeviceProof /> : <DesktopSignInProof />;
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("The sign-in proof page is missing its root element.");
}
createRoot(root).render(<App />);
