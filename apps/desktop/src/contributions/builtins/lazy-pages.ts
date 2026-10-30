// Long-tail built-in pages, code-split behind `lazyRoute` so they stay out of the
// entry chunk. `RouteOutlet` owns the shared loading boundary; `.preload` lets a
// hovered sidebar/palette link fetch the chunk before the click.

import { lazyRoute } from "../lazy-route.ts";

export const AgentEditPage = lazyRoute(
	() => import("@/src/pages/AgentEditPage.tsx")
);
export const ArtifactViewPage = lazyRoute(
	() => import("@/src/pages/ArtifactViewPage.tsx")
);
export const ChannelsPage = lazyRoute(
	() => import("@/src/pages/ChannelsPage.tsx")
);
export const ComputePage = lazyRoute(
	() => import("@/src/pages/ComputePage.tsx")
);
export const DownloadsPage = lazyRoute(
	() => import("@/src/pages/DownloadsPage.tsx")
);
export const FileEditorPage = lazyRoute(
	() => import("@/src/pages/FileEditorPage.tsx")
);
export const IdentitiesPage = lazyRoute(
	() => import("@/src/pages/IdentitiesPage.tsx")
);
export const KnowledgeGraphPage = lazyRoute(
	() => import("@/src/pages/KnowledgeGraphPage.tsx")
);
export const PaneChooserPage = lazyRoute(() =>
	import("@/src/pages/PaneChooserPage.tsx").then((module) => ({
		default: module.PaneChooserPage,
	}))
);
export const ProjectDiffPage = lazyRoute(
	() => import("@/src/pages/ProjectDiffPage.tsx")
);
export const ProjectFilesPage = lazyRoute(
	() => import("@/src/pages/ProjectFilesPage.tsx")
);
export const ProjectGitGraphPage = lazyRoute(
	() => import("@/src/pages/ProjectGitGraphPage.tsx")
);
export const ReviewPage = lazyRoute(() => import("@/src/pages/ReviewPage.tsx"));
export const SettingsPage = lazyRoute(
	() => import("@/src/pages/SettingsPage.tsx")
);
export const SharePage = lazyRoute(() => import("@/src/pages/SharePage.tsx"));
export const SpaceAppDocPage = lazyRoute(
	() => import("@/src/pages/SpaceAppDocPage.tsx")
);
export const SpaceDatabaseEditorPage = lazyRoute(
	() => import("@/src/pages/SpaceDatabaseEditorPage.tsx")
);
export const SpaceDatabaseRowPage = lazyRoute(
	() => import("@/src/pages/SpaceDatabaseRowPage.tsx")
);
export const SpaceDocEditorPage = lazyRoute(
	() => import("@/src/pages/SpaceDocEditorPage.tsx")
);
export const SpaceFileViewerPage = lazyRoute(
	() => import("@/src/pages/SpaceFileViewerPage.tsx")
);
export const SpacesPage = lazyRoute(() => import("@/src/pages/SpacesPage.tsx"));
export const VaultPage = lazyRoute(() => import("@/src/pages/VaultPage.tsx"));
export const WorkflowsPage = lazyRoute(
	() => import("@/src/pages/WorkflowsPage.tsx")
);
