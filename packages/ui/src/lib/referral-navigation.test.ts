import { expect, test } from "bun:test";
import {
	INVITE_FRIEND_NAV_ITEM,
	JOIN_DISCORD_NAV_ITEM,
} from "./referral-navigation.ts";

test("points Invite a friend to the signed-in referral page", () => {
	expect(INVITE_FRIEND_NAV_ITEM).toEqual({
		label: "Invite a friend",
		path: "/referrals",
	});
});

test("points Join Discord to the personal invite page", () => {
	expect(JOIN_DISCORD_NAV_ITEM).toEqual({
		label: "Join Discord",
		path: "/discord",
	});
});
