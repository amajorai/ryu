import type { ProductProfile } from "./profile-types.ts";

/**
 * The Skills profile (unit builder-a), kept beside ./profiles-builder-a.ts so
 * that file stays small. The page leads with the SKILL.md file itself, then
 * the Core routes that browse, install, and edit skills.
 */

const DOCS = "apps/fumadocs/content/docs";
const SKILLS_INDEX = `${DOCS}/extend/skills/index.mdx`;
const SKILLS_AUTHORING = `${DOCS}/extend/skills/authoring.mdx`;
const SKILLS_PUBLISHING = `${DOCS}/extend/skills/publishing.mdx`;
const DESKTOP_SKILLS = `${DOCS}/surfaces/desktop/skills/index.mdx`;

const SKILL_FILE = `---
name: "Web Researcher"
description: "Enables web search; use when the task needs current facts."
allowed-tools:
  - "agentbrowser"
---
When the task depends on information you do not already have, search
the web with the browser tool, read the top sources, and cite what
you used. Do not search for things you already know.`;

const CATALOG_ROUTES = `GET /api/skills/catalog
GET /api/skills/catalog/detail?id=owner%2Frepo%2Fslug&source=<id>
POST /api/skills/catalog/install`;

const AUTHOR_ROUTES = `POST /api/skills          # create a new skill
PUT  /api/skills/:id      # update (autosaved)
GET  /api/skills/:id/source`;

export const SKILLS_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Format",
			value: "One SKILL.md, in the open Agent Skills standard",
			source: {
				path: SKILLS_INDEX,
				quote: "Ryu follows the open Agent Skills standard.",
			},
		},
		{
			label: "Installs to",
			value: "~/.claude/skills/<id>/SKILL.md",
			source: {
				path: SKILLS_INDEX,
				quote: "It reads the same `~/.claude/skills/<id>/SKILL.md` layout",
			},
		},
		{
			label: "Loading",
			value: "Name and description up front; the body on demand",
			source: {
				path: SKILLS_INDEX,
				quote: "Core injects only each skill's name and description up front.",
			},
		},
		{
			label: "Index",
			value: "Up to 20 on-demand skills, then search",
			source: {
				path: SKILLS_INDEX,
				quote:
					"The up-front index lists at most 20 on-demand skills, ordered by id.",
			},
		},
		{
			label: "Sources",
			value: "skills.sh, GitHub taps, browse.sh, ClawHub, LobeHub, Marketplace",
			source: {
				path: DESKTOP_SKILLS,
				quote:
					"The source picker includes `skills.sh`, the vendor/community GitHub taps, browse.sh, ClawHub,",
			},
		},
		{
			label: "Tool grants",
			value: "Still enforced by the Gateway",
			source: {
				path: SKILLS_PUBLISHING,
				quote:
					"A skill can declare tools through `allowed-tools`, but the Gateway still enforces every grant.",
			},
		},
	],
	code: [
		{
			id: "skills-skill-file",
			label: "SKILL.md",
			language: "yaml",
			filename: "SKILL.md",
			code: SKILL_FILE,
			source: {
				path: SKILLS_AUTHORING,
				quote:
					'description: "Enables web search; use when the task needs current facts."',
			},
		},
		{
			id: "skills-catalog-routes",
			label: "Browse and install",
			language: "http",
			code: CATALOG_ROUTES,
			source: {
				path: DESKTOP_SKILLS,
				quote:
					"GET /api/skills/catalog/detail?id=owner%2Frepo%2Fslug&source=<id>",
			},
		},
		{
			id: "skills-author-routes",
			label: "Write your own",
			language: "http",
			code: AUTHOR_ROUTES,
			source: {
				path: DESKTOP_SKILLS,
				quote: "PUT  /api/skills/:id      # update (autosaved)",
			},
		},
	],
	quickstart: [
		{
			title: "Open Skills",
			description:
				"Open the Skills page from the command palette or the sidebar.",
			source: {
				path: DESKTOP_SKILLS,
				quote: "Open it from the command palette or the sidebar.",
			},
		},
		{
			title: "Search every source at once",
			description:
				"One view covers skills.sh, vendor GitHub taps, browse.sh, ClawHub, LobeHub, and Ryu Marketplace.",
			source: {
				path: DESKTOP_SKILLS,
				quote: "The Skills catalog opens on one view across public",
			},
		},
		{
			title: "Check its Health",
			description:
				"Each skill's detail view scores source trust, published audits, maintenance, docs, and package integrity.",
			source: {
				path: DESKTOP_SKILLS,
				quote:
					"It uses skill-specific checks for source trust,\npublished audits, maintenance, documentation, and package integrity.",
			},
		},
		{
			title: "Install",
			description:
				"It lands in the shared skills folder and works right away, with no restart.",
			source: {
				path: DESKTOP_SKILLS,
				quote: "reloads the skill registry so the skill works with no restart",
			},
		},
	],
	docs: [
		{
			label: "Skills",
			path: "/docs/extend/skills",
			description: "The SKILL.md format and on-demand loading.",
		},
		{
			label: "Write a skill",
			path: "/docs/extend/skills/authoring",
			description: "Front-matter, the body, and when to stay always-on.",
		},
		{
			label: "Publishing and loading",
			path: "/docs/extend/skills/publishing",
			description: "Every folder Core reads, and installing from a source.",
		},
		{
			label: "Skills in the desktop app",
			path: "/docs/surfaces/desktop/skills",
			description: "Browse, check Health, install, and edit.",
		},
	],
	related: [
		{
			label: "Give an agent a new skill",
			href: "/docs/learn/cookbook/give-an-agent-a-skill",
			kind: "docs",
		},
		{
			label: "Set up Ryu from your coding agent",
			href: "/docs/extend/skills/setup-ryu",
			kind: "docs",
		},
		{ label: "Ryu recipes", href: "/guides/ryu-recipes", kind: "guide" },
	],
};
