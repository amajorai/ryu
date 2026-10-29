import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { OAuthAccessToken, OAuthConsent } from "@ryu/db/models/auth.model";
import { startMcpOAuthFlow } from "./lib/mcp-oauth-flow.fixture.ts";

// The Mongoose mirrors of `oauthAccessToken` and `oauthConsent` declare `userId`
// as a String, and their source comment says to confirm the stored type against
// a populated database before changing it. This populates both collections the
// way production does, through the shipping Better Auth MCP provider against a
// real Mongo replica set (see ./lib/mcp-oauth-flow.fixture.ts), then reads the
// rows back with the raw driver and with the Mongoose models.

const database = new URL(
	process.env.DATABASE_URL ??
		"mongodb://127.0.0.1:27019/ryu-api-tests?replicaSet=ryu-api-tests"
);
database.pathname = `/ryu_oauth_user_id_${randomUUID().replaceAll("-", "")}`;
const flow = await startMcpOAuthFlow({ databaseUrl: database.href });

afterAll(async () => {
	await flow.close();
});

test("the provider's consent and token rows store their id and user id as ObjectIds, and the models find them by the id strings", async () => {
	const email = `ola-${randomUUID()}@oauth-user-id.example.test`;
	const user = await flow.signUpAndVerify(email);
	const clientId = await flow.registerMcpClient();
	const issued = await flow.issueAccessToken(clientId);
	expect(issued.status).toBe(200);
	expect(issued.consentShown).toBe(true);

	const consents = await flow.client
		.collection("oauthConsent")
		.find({ clientId })
		.toArray();
	const tokens = await flow.client
		.collection("oauthAccessToken")
		.find({ clientId })
		.toArray();
	expect(consents).toHaveLength(1);
	expect(tokens).toHaveLength(1);

	// What is on disk, by BSON type: the measurement the declarations were
	// waiting for. The id and the user reference are written by the same raw
	// adapter path as every other Better Auth row.
	const bsonTypes = async (collection: string, field: "_id" | "userId") =>
		Object.fromEntries(
			await Promise.all(
				["objectId", "string"].map(
					async (type) =>
						[
							type,
							await flow.client.collection(collection).countDocuments({
								clientId,
								[field]: { $type: type },
							}),
						] as const
				)
			)
		);
	for (const collection of ["oauthConsent", "oauthAccessToken"]) {
		expect(await bsonTypes(collection, "userId")).toEqual({
			objectId: 1,
			string: 0,
		});
		expect(await bsonTypes(collection, "_id")).toEqual({
			objectId: 1,
			string: 0,
		});
	}

	// The models read them back by the user's id string and by their own id
	// string, as every other Mongoose-backed lookup does.
	expect(await OAuthConsent.countDocuments({ userId: user.id, clientId })).toBe(
		1
	);
	expect(
		await OAuthAccessToken.countDocuments({ userId: user.id, clientId })
	).toBe(1);
	expect(await OAuthConsent.findById(String(consents[0]?._id))).not.toBeNull();
	expect(
		await OAuthAccessToken.findById(String(tokens[0]?._id))
	).not.toBeNull();
}, 120_000);
