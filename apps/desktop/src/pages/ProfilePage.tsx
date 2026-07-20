import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs";
import { useState } from "react";
import { ProfileTab } from "@/src/components/settings/ProfileTab.tsx";
import { StatsTab } from "@/src/components/settings/StatsTab.tsx";

type ProfileSection = "profile" | "stats";

export default function ProfilePage() {
	const [section, setSection] = useState<ProfileSection>("profile");

	return (
		<div className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-hidden px-8 py-6">
			<div className="mb-6 flex shrink-0 items-center justify-between gap-4">
				<div>
					<h1 className="font-semibold text-xl">Profile</h1>
				</div>
				<Tabs
					onValueChange={(value: string) => setSection(value as ProfileSection)}
					value={section}
				>
					<TabsList variant="pills">
						<TabsTrigger value="profile">Profile</TabsTrigger>
						<TabsTrigger value="stats">Stats</TabsTrigger>
					</TabsList>
				</Tabs>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto pr-2">
				{section === "profile" ? <ProfileTab /> : <StatsTab />}
			</div>
		</div>
	);
}
