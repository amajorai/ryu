import type { ReactNode } from "react";
import { useCallback } from "react";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { visaStatus } from "./passport-interface-pages.tsx";
import type {
	Passport,
	PassportCountry,
	upcomingTravel,
} from "./passport-model.ts";
import type { PassportNavigation } from "./passport-navigation.ts";
import {
	BlankFace,
	CoverFace,
	IdentityFace,
	NotesFace,
	VisaFace,
} from "./passport-page-face.tsx";
import {
	BlankPage,
	CoverPage,
	IdentityPage,
	NotesPage,
	VisaPage,
} from "./passport-pages.tsx";
import type { ActsView } from "./use-acts.ts";

type RendererProps = InterfaceRendererProps<unknown>;

/** Shared inputs of the booklet's pages and the desk's page faces. */
interface PassportPagesInput {
	activeThreadId: RendererProps["activeThreadId"];
	countryById: ReadonlyMap<string, PassportCountry>;
	openStamp: (threadId: string) => void;
	passport: Passport;
	recordOpen: boolean;
	snapshot: RendererProps["snapshot"];
	upcoming: ReturnType<typeof upcomingTravel>;
}

/** The booklet's page renderer (the sheet's booklet). */
export function usePassportRenderPage({
	activeThreadId,
	apply,
	countryById,
	goToPage,
	openStamp,
	passport,
	recordOpen,
	snapshot,
	upcoming,
}: PassportPagesInput & {
	apply: (agentId: string) => void;
	goToPage: PassportNavigation["goToPage"];
}) {
	return useCallback(
		(index: number, side: "left" | "right" | "single"): ReactNode => {
			const item = passport.pages[index];
			if (!item) {
				return null;
			}
			switch (item.kind) {
				case "cover":
					return <CoverPage onOpen={() => goToPage(1)} />;
				case "notes":
					return (
						<NotesPage
							agents={snapshot.agents}
							number={item.number}
							side={side}
							upcoming={upcoming}
						/>
					);
				case "identity":
					return (
						<IdentityPage
							number={item.number}
							passport={passport}
							side={side}
						/>
					);
				case "visa":
					return (
						<VisaPage
							activeThreadId={recordOpen ? activeThreadId : null}
							countries={passport.countries}
							onApply={apply}
							onOpen={openStamp}
							page={item}
							side={side}
							totalStamps={
								item.countryId
									? (countryById.get(item.countryId)?.stamps.length ?? 0)
									: passport.unassigned.length
							}
						/>
					);
				default:
					return (
						<BlankPage
							empty={passport.countries.length === 0}
							number={item.number}
							side={side}
						/>
					);
			}
		},
		[
			activeThreadId,
			apply,
			countryById,
			goToPage,
			openStamp,
			passport,
			recordOpen,
			snapshot.agents,
			upcoming,
		]
	);
}

/** The desk's page faces: what each open page shows on the 3D desk. */
export function passportFaceRenderer({
	acts,
	actsOn,
	activeThreadId,
	countryById,
	openStamp,
	passport,
	recordOpen,
	snapshot,
	summary,
	upcoming,
}: PassportPagesInput & {
	acts: ActsView["acts"];
	actsOn: boolean;
	summary: string;
}) {
	return (index: number | null | undefined): ReactNode => {
		const item =
			index === null || index === undefined ? null : passport.pages[index];
		if (!item) {
			return null;
		}
		switch (item.kind) {
			case "cover":
				return <CoverFace stamps={passport.totals.stamps} />;
			case "notes":
				return (
					<NotesFace
						agents={snapshot.agents}
						number={item.number}
						upcoming={upcoming}
					/>
				);
			case "identity":
				return (
					<IdentityFace
						number={item.number}
						passport={passport}
						summary={summary}
					/>
				);
			case "visa": {
				const country = item.countryId
					? (countryById.get(item.countryId) ?? null)
					: null;
				return (
					<VisaFace
						activeThreadId={recordOpen ? activeThreadId : null}
						country={country}
						onOpen={openStamp}
						page={item}
						status={visaStatus(
							country,
							actsOn && country ? acts.get(country.agent.id) : undefined
						)}
					/>
				);
			}
			default:
				return (
					<BlankFace
						empty={passport.countries.length === 0}
						number={item.number}
					/>
				);
		}
	};
}
