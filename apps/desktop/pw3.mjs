import { chromium } from "@playwright/test";

try {
	const b = await chromium.launch({
		headless: true,
		timeout: 60_000,
		args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
	});
	console.log("LAUNCH_OK", b.version());
	await b.close();
} catch (e) {
	console.log("LAUNCH_FAIL", e.message.split("\n")[0]);
}
