/**
 * Backfill: give existing users who have NO organization membership a personal
 * organization, so they reach parity with users created after auto-provisioning
 * landed (see `databaseHooks.user.create.after` in src/index.ts).
 *
 * Scope: a "user without an org" = a user with zero rows in the `member`
 * collection. A user who is only a member of someone else's org is NOT a target.
 *
 * Safe by default:
 *   bun run scripts/backfill-personal-orgs.ts            # DRY RUN, no writes
 *   bun run scripts/backfill-personal-orgs.ts --apply    # actually create orgs
 *   bun run scripts/backfill-personal-orgs.ts --apply --limit=1   # cap count
 *
 * Re-runnable: `ensurePersonalOrganization` re-checks membership per user, so a
 * partial failure can be retried without creating duplicate orgs.
 */

import { User } from "@ryu/db/models/auth.model";
import { Member } from "@ryu/db/models/control-plane.model";
import mongoose from "mongoose";
import { auth } from "../src/index.ts";
import {
	ensurePersonalOrganization,
	type OrganizationApi,
} from "../src/lib/organizations.ts";

const orgApi = auth.api as unknown as OrganizationApi;

const apply = process.argv.includes("--apply");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg
	? Number.parseInt(limitArg.split("=")[1] ?? "", 10)
	: Number.POSITIVE_INFINITY;

async function main(): Promise<void> {
	const memberUserIds = await Member.distinct("userId");
	const withOrg = new Set(memberUserIds.map((id) => String(id)));

	const users = await User.find({}, { _id: 1, email: 1 }).lean();
	const allTargets = users.filter((user) => !withOrg.has(String(user._id)));
	const targets = Number.isFinite(limit)
		? allTargets.slice(0, limit)
		: allTargets;

	console.log(
		`Users: ${users.length} total, ${allTargets.length} without an org, processing ${targets.length}.`
	);

	if (!apply) {
		console.log("\nDRY RUN — no writes. Pass --apply to create organizations.");
		for (const user of targets) {
			console.log(
				`  would create personal org for ${user.email} (${user._id})`
			);
		}
		return;
	}

	let created = 0;
	let skipped = 0;
	let failed = 0;

	for (const user of targets) {
		try {
			const result = await ensurePersonalOrganization(String(user._id), orgApi);
			if (result.created) {
				created += 1;
				console.log(`  ✓ ${user.email}`);
			} else {
				skipped += 1;
			}
		} catch (error) {
			failed += 1;
			console.error(`  ✗ ${user.email}:`, error);
		}
	}

	console.log(`\nDone. created=${created} skipped=${skipped} failed=${failed}`);
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await mongoose.disconnect();
	});
