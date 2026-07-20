import { OAuthApplication } from "@ryu/db/models/auth.model";

export const DESKTOP_CLIENT_ID = "ryu-desktop";
export const EXTENSION_CLIENT_ID = "ryu-extension";
const LEGACY_CLI_CLIENT_ID = "ryu-cli";

export async function seedOAuthClients(): Promise<void> {
	const clients = [
		{
			clientId: DESKTOP_CLIENT_ID,
			name: "Ryu Desktop",
			redirectUrls:
				"http://127.0.0.1:7396,http://127.0.0.1:7397,http://127.0.0.1:7398",
			skipConsent: true,
		},
		{
			clientId: EXTENSION_CLIENT_ID,
			name: "Ryu Browser Extension",
			redirectUrls:
				"chrome-extension://eahmgoelihpjlbejliklmfcohjhpgeml/dashboard.html",
			skipConsent: true,
		},
	];

	for (const client of clients) {
		try {
			await OAuthApplication.updateOne(
				{ clientId: client.clientId },
				{
					$set: {
						type: "public",
						skipConsent: client.skipConsent,
						redirectUrls: client.redirectUrls,
						updatedAt: new Date(),
					},
					$setOnInsert: {
						_id: client.clientId,
						name: client.name,
						clientId: client.clientId,
						clientSecret: null,
						disabled: false,
						userId: null,
						createdAt: new Date(),
					},
				},
				{ upsert: true }
			);
		} catch (error) {
			console.error(
				`[auth] Failed to seed ${client.name} OAuth client:`,
				error
			);
		}
	}

	try {
		await OAuthApplication.deleteOne({ clientId: LEGACY_CLI_CLIENT_ID });
	} catch (error) {
		console.error("[auth] Failed to remove legacy CLI OAuth client:", error);
	}
}
