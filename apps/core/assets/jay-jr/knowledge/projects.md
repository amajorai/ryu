# Jay's projects

Source: https://jiaweing.com/projects

## Backstage (2026)

Desktop suite of tools for creators Status: Active. Stack: rust, open source. Url: http://youtube.pub

More details to be announced.

## Ryu (2026)

Your fully private intelligent personal assistant Status: Active. Stack: tauri, rust, nextjs, react. Url: https://ryuhq.com

A privacy-first on-device AI copilot for everyday work. Ryu is a desktop AI assistant that runs entirely on your device. It observes your context-screen, audio, and files-to anticipate your needs without ever sending your sensitive data to the cloud.

### AI vs. Privacy

Everyone wants the productivity of AI, but no one wants the security nightmare of sending sensitive data; financial records, proprietary code, private messages to an external black box. Most "agents" today are just chatbots that wait for commands and live in the cloud, watching your every move.

### Local-First Intelligence

Ryu solves this by processing everything locally.

- It sees what you see: Ryu understands your screen context to offer relevant help instantly.

- It hears what you hear: Real-time meeting transcription and summarization, processed on-device.

- It keeps your secrets: Your data never leaves your computer. Period.

## Lemon8 Travel Agent (2025)

AI agents that scrape Lemon8 and generate comprehensive travel guides Status: Open Source. Stack: open source. Github: https://github.com/jiaweing/lemon8-travel-research-agent

## Overview

AI-powered travel companion that turns authentic Lemon8 experiences into comprehensive guides. A team of agents scrapes and analyzes real user experiences from Lemon8 to create detailed, practical travel guides with local insights and genuine recommendations.

## Features

- Smart Content Analysis — Advanced filtering, relevance scoring, and cross-validation across multiple sources

- Comprehensive Coverage — Accommodations, food & dining, activities, transport, culture, and costs

- Rich Visual Content — 16:9 optimized location photos organized by category

- Local Expertise — Authentic recommendations, insider tips, seasonal considerations

- Travel Insights — Local warnings, peak/off-peak timing, cultural considerations, safety tips

## Architecture

Multi-agent system with specialized roles:

- Scraper Agent — Content discovery, screenshot capture, recommendation processing

- Relevance Agent — Real-time scoring, travel relevance check, queue management

- Analyzer Agent — Content categorization, information extraction

- Aggregator Agent — Content merging, cross-validation, guide structuring

## Tech Stack

- Python 3.11+ with Poetry

- crewAI — Agent orchestration

- crawl4ai — Web crawling

- langchain + langchain-openai — LLM integration

- beautifulsoup4 — HTML parsing

- Pillow — Image processing

## Usage

```
# Install
git clone https://github.com/jiaweing/lemon8-travel-research-agent.git
poetry install

# Configure
cp .env.example .env

# Run
python src/main.py

```

Choose content focus (Everything, Food, Activities, Accommodation, Transport, Culture) and coverage level (5-15+ sources) to generate comprehensive travel guides.

## Copilot Chat API (2025)

OpenAI-compatible HTTP API for GitHub Copilot with native auth Status: Open Source. Stack: open source. Github: https://github.com/jiaweing/copilot-chat-api

## Overview

Simple HTTP API to interface with GitHub Copilot, including native GitHub authentication. Provides OpenAI-compatible endpoints for chat completions and code completion. Forked from Copilot API to include chat endpoint.

## Features

- OpenAI Compatible — Drop-in replacement for OpenAI API

- Cline Support — Works with Cline by setting provider to OpenAI Compatible

- Native GitHub Auth — Uses GitHub authentication for Copilot access

- Streaming Support — Both streaming and non-streaming responses

- Multiple Models — Supports claude-3.5-sonnet and other Copilot-supported models

## Endpoints

### Chat Completions

POST /v1/chat/completions

```
{
"model": "claude-3.5-sonnet",
"messages": [{ "role": "user", "content": "Hello" }],
"temperature": 0.7,
"max_tokens": 1000,
"stream": true
}

```

### Code Completion

POST /v1/code/completions

```
{
"prompt": "# hello world function\n\n",
"language": "python"
}

```

## Usage

```
# Install dependencies
pip install -r requirements.txt

# Run server
python api.py [port]

# Or use scripts
./mac-linux.sh  # macOS/Linux
windows.bat     # Windows

```

For Cline integration, set API provider to "OpenAI Compatible" with Base URL pointing to this server. API key can be anything.

## Agoda Hotel Agent (2025)

AI agents that analyze Agoda listings to find ideal accommodations Status: Open Source. Stack: open source. Github: https://github.com/jiaweing/agoda-agent

## Overview

AI-powered hotel research assistant that analyzes Agoda listings to find your perfect stay. A team of specialized agents evaluates locations, amenities, reviews, and value propositions to create comprehensive accommodation guides.

## Features

- Smart Hotel Search — City-based discovery with flexible date ranges, room configuration, and advanced filters (star rating, price, amenities, traveler type)

- Comprehensive Analysis — Location, rooms, value, quality ratings, facilities, and guest type suitability

- Visual Content — Hotel property photos, room imagery, facility showcases

- Expert Insights — Location advantages, room selections, value analysis, booking strategies

- Travel Tips — Check-in optimization, extra charges, upgrade opportunities, loyalty benefits

## Architecture

Multi-agent system with specialized roles:

- Scraper Agent — Hotel listing discovery, property details extraction, photo collection

- Relevance Agent — Criteria matching, amenity verification, price validation

- Analyzer Agent — Detailed property analysis, review sentiment, value assessment

- Aggregator Agent — Guide organization, category sorting, comparative analysis

## Tech Stack

- Python 3.11+ with Poetry

- crewAI — Agent orchestration

- crawl4ai — Web crawling

- langchain + langchain-openai — LLM integration

- beautifulsoup4 — HTML parsing

- Pillow — Image processing

## Usage

```
# Install
git clone https://github.com/jiaweing/agoda-agent.git
poetry install

# Configure
cp .env.example .env

# Run
python src/main.py

```

Select city (Singapore, Bangkok, Tokyo, Seoul, Hong Kong), enter stay details and preferences to generate categorized hotel guides (Luxury, Upscale, Mid-range, Budget, Special picks).

## Color by Number (2025)

AI-powered color-by-number app using Google Gemini for image generation Status: Open Source. Stack: nextjs, react, open source. Github: https://github.com/jiaweing/color-by-number

A Next.js application that generates images using Google Gemini AI, converts them into color-by-number templates, and provides interactive coloring.

### Features

- Generate images using Google Gemini AI from text prompts

- Automatic conversion to color-by-number templates

- Interactive coloring with color palette

- Checkerboard pattern highlighting for selected colors

- Adjustable difficulty levels (number of colors)

- Export finished artwork

### How to Use

- Enter a prompt (e.g., "a cozy forest cabin")

- Click "Generate" to create an image

- Select a color from the palette

- Click numbered regions to color them

- Toggle template view, get hints, or reset

- Export finished artwork

### Tech Stack

- Framework: Next.js 15

- React: React 19

- AI: Google Gemini API

- Rendering: Canvas API

- Styling: Tailwind CSS

### Installation

```
git clone https://github.com/jiaweing/color-by-number.git
cd color-by-number
pnpm install

```

Create .env.local with your Gemini API key:

```
GEMINI_API_KEY=your_api_key_here

```

Run development server:

```
pnpm dev

```

### Links

- GitHub: jiaweing/color-by-number

## Portfolio Dex (2025)

Personal portfolio site with 3D tilted cards and wrapped yearly summaries Status: Open Source. Stack: nextjs, open source. Github: https://github.com/jiaweing/portfolio-dex

Personal portfolio website featuring unique visual experiences including 3D tilted cards, wrapped yearly summaries, and gallery views. MIT licensed.

### Features

- 3D tilted card animations for project showcases

- Wrapped yearly summary pages (Spotify Wrapped-style)

- Gallery view for projects with status sections

- Random gradient generation for empty covers

- OG image generation via screenshots

- Open source toast notification

- YouTube integration in wrapped summaries

- Bento grid layouts for wrapped content

### Tech Stack

- Framework: Next.js

- Runtime: Bun

- Styling: Tailwind CSS

- Linting: Biome (ultracite)

- License: MIT

### Installation

```
git clone https://github.com/jiaweing/portfolio-dex.git
cd portfolio-dex
bun install
bun dev

```

### Links

- GitHub: jiaweing/portfolio-dex

## Base 7 Landing (2025)

Company landing page for Base 7 with dark mode, blog, and project showcase Status: Open Source. Stack: nextjs, open source. Github: https://github.com/jiaweing/base7-landing

A Next.js landing page for Base 7, a company building companies. Features dark mode support, blog integration, project showcase, and seasonal animations.

### Features

- Dark mode support with theme toggle

- Blog and pages powered by Notion

- Project showcase with Notion integration

- OG image generation via screenshots

- PWA support

- Seasonal animations (snowflakes in December, confetti for New Year)

- Staggered animations and page transitions

- Header with scroll-based visibility

### Tech Stack

- Framework: Next.js 15

- Runtime: Bun

- Styling: Tailwind CSS

- Linting: Biome (ultracite)

- Deployment: Vercel

- CMS: Notion API

### Installation

```
git clone https://github.com/jiaweing/base7-landing.git
cd base7-landing
bun install
bun dev

```

### Links

- GitHub: jiaweing/base7-landing

- Live: base7.dev

## jiaweing/ui (2025)

Apple OS 26-inspired component library built on shadcn/ui Status: Open Source. Stack: react, open source. Url: http://ui.jiaweing.com/docs Github: https://github.com/jiaweing/ui

WebsiteGitHub

## Overview

A set of beautifully designed components inspired by iOS 26 on mobile and macOS 26 on desktop, built directly on top of shadcn/ui. Easy drop-in replacement.

> Disclaimer: This is not meant to be an exact copy of the Apple UI, but to create something that looks similar. This is a fork of shadcn/ui which will often sync with upstream commits.

## Features

- 🍎 Apple-inspired glassmorphism and blur effects

- 📱 iOS 26 aesthetics on mobile

- 💻 macOS 26 aesthetics on desktop

- 🔄 Easy drop-in replacement for shadcn/ui

- 🎨 Beautiful default styling out of the box

- 🔧 Fully customizable components

## Customizations

- Glass buttons with blur effects

- Blue focused inputs

- Mac notch support

- Progressive blur effects on mobile navigation

- Dock component for desktop

## Tech Stack

- TypeScript 89.6%, MDX 7.5%, CSS 2.8%

- Built on Next.js 16

- MIT License

## Documentation

Visit ui.jiaweing.com to view the full documentation and component examples.

## Singapore Bus Map (2025)

Real-time Singapore bus tracker using LTA DataMall Status: Open Source. Stack: nextjs, react, open source, remake in 2026. Url: https://github.com/jiaweing/bus-map Github: https://github.com/jiaweing/bus-map

WebsiteGitHub

## Overview

An interactive web application that displays real-time Singapore bus locations and bus stops around the user's current location. Provides live updates of bus arrivals and their statuses.

## Features

- 📍 Current Location — Shows the user's current location on the map

- 🚏 Nearby Bus Stops — Displays all bus stops within a configurable radius

- 🚌 Live Bus Locations — Shows real-time positions of buses on the map

- ⏱️ Arrival Times — Provides estimated arrival times for upcoming buses

- 📱 Responsive Design — Works on both mobile and desktop devices

- 🔄 Real-time Updates — Refreshes bus positions automatically every 15 seconds

## Usage

- Allow location access when prompted

- Adjust the radius to see more or fewer bus stops

- Click on bus stops or buses to see more information

- The map will automatically update with new bus positions

## APIs Used

- Bus Stops — Retrieves all bus stop locations

- Bus Arrivals — Gets real-time bus arrival information

- Bus Services — Provides information about bus service routes

## Tech Stack

- Next.js 15, React 19, TypeScript

- Leaflet for interactive maps

- LTA DataMall APIs

- Tailwind CSS, SWR for data fetching

## DropDrawer (2025)

Responsive dropdown/drawer component for shadcn/ui Status: Open Source. Stack: react, open source. Url: https://dropdrawer.jiaweing.com/ Github: https://github.com/jiaweing/DropDrawer

WebsiteGitHub

## Overview

A responsive component that automatically switches between a dropdown menu on desktop and a drawer on mobile devices for shadcn/ui. A drop-in replacement for shadcn/ui's DropdownMenu component.

## Why DropDrawer?

Traditional dropdown menus don't feel native on mobile devices — they can be difficult to interact with on small screens. DropDrawer solves this by:

- Automatically switching between dropdown menus on desktop

- Using a native-feeling drawer interface on mobile devices

- Providing consistent interaction patterns across all screen sizes

- Using a responsive breakpoint of 768px (configurable)

## Installation

```
pnpm dlx shadcn@latest add https://dropdrawer.jiaweing.com/r/dropdrawer.json

```

## Component Mapping

DropdownMenuDropDrawer

DropdownMenuDropDrawer

DropdownMenuTriggerDropDrawerTrigger

DropdownMenuContentDropDrawerContent

DropdownMenuItemDropDrawerItem

DropdownMenuSubDropDrawerSub

## Credits

- shadcn/ui by shadcn

- Vaul by emilkowalski

- Radix UI by Workos

- Credenza by redpangilinan for inspiration

## Local LLM API (2025)

OpenAI-compatible API server for local GGUF models Status: Open Source. Stack: open source, remake in 2026. Url: https://github.com/jiaweing/localLLM-api Github: https://github.com/jiaweing/localLLM-api

WebsiteGitHub

## Overview

An API server that provides OpenAI-compatible endpoints for running GGUF models locally. Designed for easy integration with any system that supports OpenAI's API format.

## Supported Operations

- Chat Completions (like GPT-3.5/4)

- Embeddings Generation

- Document Reranking

## Features

- ✨ OpenAI-compatible API endpoints

- 🚀 Drop-in replacement for OpenAI's client libraries

- 🔒 Run models locally for privacy and cost savings

- 🔄 Auto-loading and unloading of models for memory efficiency

- 📁 Organized model management by type (chat/embedding/reranking)

## API Endpoints

- POST /v1/chat/completions — Chat completions

- POST /v1/embeddings — Generate embeddings

- POST /v1/rerank — Rerank documents

- POST /v1/models/load — Pre-load a model

- POST /v1/models/unload — Unload a model

- GET /v1/models — List available models

## Tech Stack

- TypeScript + Node.js

- pnpm, runs on port 23673

- Models auto-unload after 30 minutes of inactivity

## verify.supply.tf (2025)

Blockchain product verification with NFC for SUPPLY: THE FUTURE Status: Open Source. Stack: nextjs, open source. Url: https://verify.supply.tf Github: https://github.com/jiaweing/verify.supply.tf

WebsiteGitHub

## Overview

A blockchain-based physical asset verification and ownership tracking system built for SUPPLY: THE FUTURE apparel. Creates an immutable digital record for each item, enabling secure ownership transfers and authenticity verification through NFC integration.

## Features

FeatureDescription

🔒 Blockchain VerificationImmutable history tracking using custom blockchain

👤 Ownership ManagementSecure transfer system with email verification

🏷️ NFC IntegrationPhysical-digital product linkage through NFC tags

📱 Mobile-First DesignResponsive interface optimized for mobile verification

🔍 Audit TrailComplete historical record of ownership transfers

🛡️ Tamper ProtectionCryptographic verification of product authenticity

## Technical Architecture

- Merkle tree implementation for efficient transaction verification

- Chain verification with hash validation

- Nonce verification prevents replay attacks

- Millisecond precision timestamps for reliable hashing

## Tech Stack

- Next.js, PostgreSQL 15+, pnpm

- AGPLv3 License

## Gemini Telegram Bot (2025)

Telegram bot with Gemini 2.0 Flash for chat and image generation Status: Open Source. Stack: open source. Url: https://github.com/jiaweing/GeminiTelegramBot Github: https://github.com/jiaweing/GeminiTelegramBot

WebsiteGitHub

## Overview

A powerful Telegram bot powered by Google's Gemini 2.0 Flash for natural conversations and stunning AI image generation with multimodal capabilities.

## Features

- Advanced Image Generation — Create images using Gemini 2.0 Flash's native capabilities

- Natural Conversation — Fluid, context-aware conversations with Gemini AI

- Image Analysis — Send any image for AI-powered analysis and insights

- Smart History — Maintains chat history for contextual responses

- True Multi-Modal — Seamlessly process text and images in the same conversation

## Image Generation Capabilities

- Storytelling with consistent character illustrations

- Iterative image creation through natural dialogue

- Knowledge-informed generation for accurate visuals

- Superior text rendering in generated images

## Commands

- /start — Initialize or reset the bot

- /help — View usage instructions

- /clear — Clear conversation history

## Tech Stack

- Telegraf for Telegram Bot API

- @google/genai for Gemini integration

- TypeScript + Node.js

## Update Night Agent (2025)

AI newsletter generator using Discord links and crewAI agents Status: Open Source. Stack: discord, open source. Url: https://github.com/jiaweing/updatenight-agent Github: https://github.com/jiaweing/updatenight-agent

WebsiteGitHub

## Overview

An automated system for generating the Update Night newsletter using AI agents. Uses crewAI to orchestrate multiple agents that collect links from Discord, scrape content, and generate newsletter content in the Update Night style.

## Features

- Automated Discord link collection with categorization

- AI-powered link categorization using Gemini 2.5 Flash

- Web scraping with screenshots using crawl4ai

- AI-powered content summarization with writing style matching

- Markdown output with properly formatted sections and images

## Link Categories

- The Big Picture — Major announcements, launches, breaking news

- Under the Radar — Experimental features, insights, analyses

- TrAIn of Thought — AI/ML developments, models, research

- The Grid — Design systems, UI/UX, component libraries

- The Spotlight — Open source projects, tools, resources

## AI Model Support

- OpenAI — GPT-4o-mini (default)

- Gemini — gemini-2.5-flash-preview

## Tech Stack

- Python 3.11+, crewAI

- Discord bot integration

- crawl4ai for web scraping

## Alt+Q QR Reader (2025)

Offline QR code reader browser extension for Firefox and Chromium Status: Open Source. Stack: open source, remake in 2026, browser extension. Url: https://github.com/jiaweing/altq-qr-reader-extension Github: https://github.com/jiaweing/altq-qr-reader-extension

WebsiteGitHub

## Overview

A powerful browser extension that allows you to read QR codes directly from web pages without requiring an internet connection. Supports both Firefox and Chromium-based browsers (Chrome, Edge, Brave).

## Features

- 🔍 Region Selection — Click and drag to select any area containing a QR code

- 🌐 Offline Functionality — Works completely offline using local QR code processing

- ⌨️ Keyboard Shortcuts — Quick activation using Alt+Q

- 📋 Clipboard Integration — Automatically copies decoded content to clipboard

- 🔔 Visual Feedback — Toast notifications for all operations

- 🛡️ Privacy-Focused — No data transmission, all processing happens locally

## Usage

- Navigate to any webpage containing a QR code

- Press Alt+Q or activate the extension from the toolbar

- Click and drag to select the area containing the QR code

- The content will be decoded and copied to your clipboard

## Technologies

- jsQR.js for QR code detection

- Browser WebExtensions API

- Pure JavaScript with no external dependencies

## Local RAG API (2025)

Local RAG API with semantic search and reranking Status: Open Source. Stack: open source, remake in 2026. Url: https://github.com/jiaweing/localRAG-api Github: https://github.com/jiaweing/localRAG-api

WebsiteGitHub

## Overview

A lightweight & fully customizable API server for Contextual Retrieval-Augmented Generation (RAG) operations, supporting document chunking with context generation, multi-embedding semantic search, and reranking.

## Modes

- Stateless RAG — Provide documents and chunks in the request

- Database RAG — Complete contextual RAG pipeline using PostgreSQL (PgVector)

## Features

- 🔍 Text chunking with configurable size and overlap

- 🧠 Optional context generation using OpenAI or local models

- 📈 Flexible embedding model selection

- 🎯 Hybrid semantic search with configurable weights (60/40 content/context)

- 🔄 Cross-encoder reranking for better relevance

## Search Pipeline

- Initial Retrieval — Generates query embedding, calculates cosine similarity, applies threshold

- Reranking — Cross-encoder model for more accurate relevance scoring

## API Endpoints

- POST /v1/chunk — Process document chunks

- POST /v1/query — Search across chunks

- POST /v1/store — Store document in database

- POST /v1/retrieve — Hybrid semantic search

- POST /v1/delete — Delete chunks by file_id

## Tech Stack

- Node.js 18+, PostgreSQL 15+ with pgvector

- Docker support included

## Update Night (2025)

We cover tech news before they appear on the headlines Status: Active. Url: updatenight.com

## About

A newsletter delivering unique business and tech insights that rarely make headlines (1k+ views). Founder, Podcast Host & News Writer. Visit updatenight.com

## Update Night Podcast (2025)

Podcast based on Update Night Status: Active. Stack: spotify.

## About

Podcast arm of Update Night. Listen here

## Best Before (2025)

A free local food expiry date tracking app Status: Open Source. Stack: react native, open source. Url: https://github.com/jiaweing/best-before Github: https://github.com/jiaweing/best-before

WebsiteGitHub

## About

Web application to track food expiry dates and reduce waste. Open source project. View on GitHub

## Dojo Q (2025)

A free open-source local quiz app using Gemini Status: Open Source. Stack: electron.

## About

Status: Paused / Draft. Project in the queue.

## Vephius (2025)

Productivity app built on the hawthorn effect Status: Paused. Stack: .net. Url: vephius.com

## Concept

A digital time capsule and bucket list platform.

- Send a time capsule to yourself in the future.

- Wishlists and 'Secret Santa' mechanics.

- 'Law of 100' challenges.

- Post predictions about the future that are unveiled later.

## supply.tf (2025)

Limited streetwear brand creating stories on chasing your dreams and inspiring people Status: Active. Stack: nextjs. Url: https://supply.tf

## About

Limited-edition streetwear brand focusing on story-driven series and scarcity. Built on the philosophy to 'Supply the Future'.

## Mission

To stand out, help others do the same, and prove that with belief and strategy, you can win against all odds.

## Base 7 (2025)

A company building apps as companies Status: Past. Url: base07.com

## About

Base 7 is a product studio building the privacy-first AI ecosystem. We combine software engineering, AI research, consumer applications, and community building.

## Philosophy

- Local first & Privacy first: Prioritizing on-device processing and user data ownership.

- Design-driven: Soft minimalism, "ghost" motifs, and Apple-like UX.

## Ventures

Home to Ryu, Supply.tf, and Division Null.

## Dotnet 8 JWT API Boilerplate (2024)

Barebones .NET 8 API with JWT auth, MySQL, Swagger, and Serilog Status: Open Source. Stack: open source, .net, c#. Github: https://github.com/jiaweing/dotnet8-jwt-api-boilerplate

## Overview

A simple barebones API boilerplate with JWT authentication and MySQL database setup. No framework lock-ins, zero abstractions, full control over all the code — only dotnet.

## Features

- MySQL Database with Entity Framework Core

- JWT Authentication with refresh tokens

- Role-based Authorization (Admin and User roles)

- Rate Limiting for API protection

- Anti-spam Registration protection

- Swagger UI for API documentation

- Serilog for structured logging

## Getting Started

### Initial Setup

```
dotnet ef database update

```

### Run the Project

```
dotnet run

```

### Migrations

```
# Create new migration
dotnet ef migrations add MigrationName

# Apply migrations
dotnet ef database update

# Remove last migration
dotnet ef migrations remove

```

## Tech Stack

- .NET 8

- Entity Framework Core

- MySQL

- JWT Bearer Authentication

- Swagger/OpenAPI

- Serilog

## License

MIT License

## Division Null (2024)

A tech community with 80+ members sharing useful resources Status: Past. Stack: discord. Url: https://discord.com/invite/KTCGWC7bZn

## About

A tech builder community with 80+ members. Functions as an early alpha testing base for Ryu and other Base 7 projects. Join Discord

## Casigned (2024)

Custom NFC business card service Status: Past. Stack: physical goods. Url: https://tally.so/r/m6QO4O

## About

NFC-enabled digital business cards for seamless contact sharing. Status: Active. Challenge: Finding initial customers.

## Dense (2024)

Local-first AI meeting assistant Status: Cancelled. Stack: electron.

## About

A local-first AI meeting application. Dense was the predecessor to Ryu. It explored the philosophy that for AI to be truly personal and secure, it must live with the user on their device, not in the cloud.

## Paoverse (2024)

Original universe of hand drawn characters and merch Status: Past. Stack: physical goods. Url: paoverse.com

## About

A universe of original characters and merchandise. Co-founded project with 400+ followers. Visit paoverse.com

## Been (2024)

Your places, your world Status: Past. Stack: .net, nextjs. Url: https://been.place

been.place is a simple way to track the places you've been - and the places you want to go.

## Decosmic (2024)

Deploy your own AI in seconds Status: Past. Stack: .net, nextjs. Url: https://decosmic.com

Deploy your own AI in seconds

Decosmic (Feb 2024) is a platform designed to build AI agents that actually understand the world they operate in. Instead of relying on generic training data or prompt engineering, Decosmic grounds agents in your real knowledge - your documents, your definitions, your processes.

### The Mission

Modern AI is powerful but unpredictable. It's great at generating ideas, but terrible at following strict rules or referencing accurate internal information. Decosmic fixes this by turning your knowledge base into a structured intelligence layer. It transforms Notion pages, SOPs, and project files into a queryable brain that agents can use to provide precise, context-aware answers.

### Features

- Grounded in Your Data: Connect Notion or your preferred knowledge source. Decosmic turns it into a structured, queryable intelligence layer.

- No ML Headache: No training pipelines or GPUs. Just define what your agent should know and how it should behave.

- Real-Time Sync: Your agents stay up-to-date with every edit. No stale knowledge.

- Context-Aware: Responses are based on your real documents, not hallucinations.

- Deploy Anywhere: Embed agents in your internal tools, support systems, or workflows.

### Legacy

Decosmic pioneered the local-first, data-grounded approach to AI agents. The technology and lessons from Decosmic now power the core architecture of Ryu, bringing grounded intelligence to the desktop.

## YouTube Playlist Delete (2021)

Stylus CSS style for double-click video removal from YouTube playlists Status: Open Source. Stack: open source, browser extension. Github: https://github.com/jiaweing/YouTube-Playlist-Delete-Video

## Overview

YouTube removed the Trash icon from playlists and replaced it with a dropdown menu. The new behavior requires users to press twice to remove a video, which is tedious when managing large playlists. This Stylus CSS style repositions the dropdown menu slightly upwards, allowing you to double-click to remove a video from a playlist in one smooth action.

## Features

- Double-click removal — No more clicking twice on different elements

- Lightweight — Pure CSS solution, no JavaScript

- Stylus-based — Easy to install and toggle on/off

## Installation

- Install the Stylus browser extension

- Create a new style for `youtube.com`

- Paste the CSS from stylus.css

- Save and enable

## Tech Stack

- Stylus (CSS user styles)

- Browser extension ecosystem

## Spotify Auto Playlist (2021)

VBA script to auto-play Spotify playlists on boot Status: Open Source. Stack: spotify, open source. Url: https://github.com/jiaweing/Spotify-Auto-Playlist Github: https://github.com/jiaweing/Spotify-Auto-Playlist

WebsiteGitHub

## Overview

A VBA script that launches Spotify and plays a specified playlist. Used to automatically play a playlist on boot, especially for a smart home automated setup.

## Features

- Automatically launches Spotify on system startup

- Plays a specified playlist

- Supports time-based playlist selection:

- Morning playlist — Before 10 AM

- After morning playlist — After 10 AM

## Usage

- Customize the script with your playlist URIs

- Add the script to your Windows startup folder

- Spotify will launch and play your playlist on boot

## Use Case

Perfect for smart home setups where you want music to start playing automatically when you wake up or when your computer starts.

## Deathrun Freerun (2020)

SourceMod plugin for Death to activate freerun in Deathrun Status: Open Source. Stack: sourcemod, source engine, open source. Github: https://github.com/jiaweing/Deathrun-Freerun

## Overview

SourceMod plugin for TF2 Deathrun servers that allows the Death player to activate a freerun, giving runners a chance to complete the map without traps being activated.

## Features

- Freerun Activation — Death can trigger freerun mode for the current round

- HUD Display — Freerun status shown at bottom center of screen

- Deathrun Integration — Works seamlessly with existing Deathrun plugins

## Installation

- Download the compiled plugin (freerun.smx)

- Place in addons/sourcemod/plugins/

- Restart server or load plugin with sm plugins load freerun

## Tech Stack

- SourceMod/SourcePawn

- TF2 Deathrun gamemode

## TF2 No Refunds (2020)

SourceMod plugin to disable upgrade refunds in Mann vs Machine Status: Open Source. Stack: sourcemod, source engine, open source. Github: https://github.com/jiaweing/TF2-NoRefunds

## Overview

SourceMod plugin that disables the ability for players to refund their upgrades in Mann vs Machine mode, adding an extra layer of strategy and commitment to upgrade decisions.

## Features

- Refund Blocking — Prevents players from refunding purchased upgrades

- MvM Integration — Works with standard Mann vs Machine gameplay

- Lightweight — Minimal performance impact

## Installation

- Download the compiled plugin (mvm_norefunds.smx)

- Place in addons/sourcemod/plugins/

- Restart server or load plugin with sm plugins load mvm_norefunds

## Tech Stack

- SourceMod/SourcePawn

- TF2 Mann vs Machine gamemode

## TF2 Borderlands (2020)

SourceMod plugin that adds Borderlands-style black outlines to everything Status: Open Source. Stack: open source, sourcemod, source engine. Github: https://github.com/jiaweing/TF2-Borderlands

## Overview

A SourceMod plugin that adds a Borderlands-style black outline effect to all entities in Team Fortress 2, giving the game a cel-shaded comic book aesthetic.

## Features

- Borderlands Effect — Adds black outlines to players, props, and world geometry

- Lightweight — Simple SourceMod plugin with minimal performance impact

- Drop-in Ready — Just install and enable

## Installation

- Download borderlands.smx

- Place in tf/addons/sourcemod/plugins/

- Restart server or load plugin with sm plugins load borderlands

## Tech Stack

- SourceMod

- SourcePawn

## TF2 Navmeshes (2020)

Navmeshes for all stock TF2 maps with overhauled versions Status: Open Source. Stack: open source, source engine. Github: https://github.com/jiaweing/TF2-Navs

## Overview

A complete collection of navigation meshes (navmeshes) for all stock Team Fortress 2 maps. These navmeshes enable bots to navigate and play on maps that may not have proper nav files or have broken navigation.

## Features

- Full Coverage — Navmeshes for all official TF2 maps

- Multiple Game Modes — CP, CTF, KOTH, Payload, MvM, Arena, and more

- Overhauled Versions — Improved navmeshes in the overhauled/ folder

- Drop-in Ready — Just copy to your TF2 maps folder

## Included Map Types

PrefixGame Mode

cp_Control Point

ctf_Capture the Flag

koth_King of the Hill

pl_Payload

plr_Payload Race

mvm_Mann vs Machine

arena_Arena

pd_Player Destruction

pass_PASS Time

sd_Special Delivery

tc_Territorial Control

rd_Robot Destruction

## Installation

- Download the .nav files

- Copy to Steam/steamapps/common/Team Fortress 2/tf/maps/

- Launch TF2 and add bots with tf_bot_add

## Tech Stack

- Source Engine

- TF2 Navigation Mesh System

## Auto Swiper (2020)

Browser console scripts for auto-swiping on dating apps Status: Open Source. Stack: open source. Url: https://github.com/jiaweing/Tinder-OkCupid-Bumble-Auto-Swipe Github: https://github.com/jiaweing/Tinder-OkCupid-Bumble-Auto-Swipe

WebsiteGitHub

## Overview

JavaScript scripts for auto-swiping on Tinder, OkCupid, and Bumble via browser developer console.

## Usage

- Go to the website and press F12

- Copy and paste the corresponding script below into your browser developer console

- Press ENTER

## Scripts

### Tinder

```
setInterval(function() {
var likeBtn = document.querySelector('[class="button Lts($ls-s)..."]');
likeBtn.click()
}, 100)

```

### OkCupid

```
setInterval(function() {
var likeBtn = document.querySelector('.dt-action-buttons-button');
likeBtn.click()
}, 100)

```

### Bumble

> ⚠️ Scripts may break when websites update their UI. Class selectors need to be updated accordingly.

## Attack on Teufort (2020)

Custom Team Fortress 2 game mode bringing PvE mechanics to PvP maps Status: Past. Stack: sourcemod, cpp.

## About

A custom game mode for Team Fortress 2 bringing 'Versus AI' mechanics into Player vs Player maps. Operated from Jun 2020 - Present.

## Teleport on Kill (2019)

Teleport to your victim's position when you kill them Status: Open Source. Stack: open source, sourcemod, source engine. Github: https://github.com/titantf/Teleport-on-Kill

## Overview

A SourceMod plugin that teleports you to your victim's position when you kill them. Great for fast-paced combat and aggressive playstyles.

## Features

- Instant Teleport — Move to victim's location on kill

- Stay Aggressive — Keep the momentum going

- Lightweight — No configuration required

## Tech Stack

- SourceMod

- SourcePawn

## Infection (2019)

Spread your class to everyone you kill like a virus Status: Open Source. Stack: open source, sourcemod, source engine. Github: https://github.com/titantf/Infection

## Overview

A SourceMod plugin where killing players converts them to your class. Spawn as any class and spread it like a virus across the server.

## Features

- Class Infection — Victims become your class on death

- Viral Spread — Your class spreads through the server

- Any Class — Choose your starting class freely

## Tech Stack

- SourceMod

- SourcePawn

## ClassWarfare MvM (2019)

Class Warfare mode for Mann vs Machine Status: Open Source. Stack: open source, sourcemod, source engine. Github: https://github.com/titantf/ClassWarfare-MvM

## Overview

Class Warfare adapted for Mann vs Machine. Forces all players to play as the same randomly selected class during each wave.

## Functionality

A new class is selected at random when:

- The map starts

- A wave is completed

## Features

- Per-Wave Classes — New class after each wave

- MvM Compatible — Designed specifically for MvM

- Team Coordination — Everyone works with the same class

## Tech Stack

- SourceMod

- SourcePawn

## 1 vs All Respawn (2019)

Respawn feature for boss gamemodes like Deathrun, VSH, and Freak Fortress Status: Open Source. Stack: open source, sourcemod, source engine. Github: https://github.com/titantf/1-vs-All-Respawn

## Overview

Adds a respawn feature to 1-vs-all boss gamemodes like Deathrun, VSH (Versus Saxton Hale), and Freak Fortress. Gives players a second chance after dying.

## Features

- Scaled Respawn Timer — Base time + additional time per player

- HUD Display — Shows respawn countdown and next respawns leaderboard

- Customizable — Fully configurable via ConVars

- Compatible — Works with Deathrun, VSH, Freak Fortress

## Key ConVars

ConVarDescriptionDefault

sm_1vA_respawntimeBase respawn time (seconds)20

sm_1vA_respawnperplayertimeAdditional time per player15

sm_1vA_leaderboardsShow next respawns1

sm_1vA_preparetime"Prepare to Respawn" warning10

## Requirements

- MoreColors (for recompile only)

## Tech Stack

- SourceMod

- SourcePawn

## Resize Projectiles (2019)

Change the size of all projectiles in TF2 Status: Open Source. Stack: open source, sourcemod, source engine. Github: https://github.com/titantf/Resize-Projectiles

## Overview

A SourceMod plugin that changes the visual size of all projectiles in TF2. Great for fun servers or custom gamemodes with giant rockets and pills.

## Usage

```
sm_resizeprojectile_size <0.1 - 100.0>

```

## Features

- All Projectiles — Affects rockets, pills, arrows, etc.

- Adjustable Range — Scale from 0.1x to 100x size

- Visual Only — Changes model size, not hitboxes

## Tech Stack

- SourceMod

- SourcePawn

## Resize Mod (2019)

Admin command to change the model size of any entity Status: Open Source. Stack: open source, sourcemod, source engine. Github: https://github.com/titantf/Resize-Mod

## Overview

An admin tool for SourceMod that lets you change the model size of any entity you're looking at. Useful for custom gamemodes, events, or just fun.

## Usage

```
sm_scale <0.1 - 100.0>

```

Point at any entity and run the command to resize it.

## Features

- Any Entity — Works on players, props, NPCs

- Aim-Based — Targets whatever you're looking at

- Admin Only — Requires admin privileges

## Tech Stack

- SourceMod

- SourcePawn

## Change Class on Kill (2019)

Change to your victim's class when you kill them Status: Open Source. Stack: open source, sourcemod, source engine. Github: https://github.com/titantf/Change-Class-on-Kill

## Overview

A SourceMod plugin that automatically changes your class to match your victim's class when you kill them. Creates a unique "class stealing" gameplay mechanic.

## Features

- Instant Class Switch — Change class immediately on kill

- Keep Momentum — Stay in the fight with your new class

- Chaotic Fun — Great for custom servers and events

## Tech Stack

- SourceMod

- SourcePawn

## Any Headshot (2019)

Deal critical damage headshots with any weapon in TF2 Status: Open Source. Stack: open source, sourcemod, source engine. Github: https://github.com/titantf/Any-Headshot

## Overview

A SourceMod plugin that allows any weapon in TF2 to deal critical damage headshots, not just sniper rifles. Great for custom gamemodes or fun servers.

## Features

- Universal Headshots — Any weapon can headshot

- Critical Damage — Headshots deal critical damage

- Simple — No configuration required

## Tech Stack

- SourceMod

- SourcePawn

## Free-For-All (2019)

Friendly fire fix plugin extracted from Slender Fortress 2 code Status: Open Source. Stack: open source, sourcemod, source engine. Github: https://github.com/titantf/Free-For-All

## Overview

A SourceMod plugin that properly enables friendly fire in TF2. The code was extracted from Slender Fortress 2 to work as a standalone plugin for any free-for-all or deathmatch gamemode.

## Features

- Proper Friendly Fire — Fixes TF2's broken friendly fire mechanics

- Standalone — Works independently without SF2

- Lightweight — Simple drop-in plugin

## Tech Stack

- SourceMod

- SourcePawn

## Server Refresh (2019)

All-inclusive server restart features plugin for Source servers Status: Open Source. Stack: open source, sourcemod, source engine. Github: https://github.com/titantf/Server-Refresh

## Overview

All-inclusive server restart features in one SourceMod plugin. Ensures your Source game server is always refreshed and prepared for the next load. Originally developed for Titan.TF.

## Features

- Scheduled Restarts — Hourly, daily, and weekly restart options

- Empty Server Detection — Auto-restart when server empties

- Custom Messages — Configurable restart notifications

- Flexible Timing — Set exact times for scheduled restarts

- Player Awareness — Optional wait time before restarting

## Restart Types

TypeDescription

EmptyRestart when no players are connected

HourlyRestart at a specific minute each hour

DailyRestart at a specific time each day

WeeklyRestart on a specific day and time

## Key ConVars

ConVarDescriptionDefault

sm_restart_emptyEnable restart when empty1

sm_restart_hourlyEnable hourly restart1

sm_restart_dailyEnable daily restart1

sm_restart_daily_timeDaily restart time (HHMM)"0500"

sm_restart_weeklyEnable weekly restart0

## Installation

- Download server_refresh.smx

- Place in tf/addons/sourcemod/plugins/

- Configure ConVars in cfg/sourcemod/

- Restart server

## Tech Stack

- SourceMod

- SourcePawn

## Unsplash Multiple Download (2019)

JavaScript script for bulk downloading Unsplash images Status: Open Source. Stack: open source. Url: https://github.com/jiaweing/Unsplash-Multiple-Download Github: https://github.com/jiaweing/Unsplash-Multiple-Download

WebsiteGitHub

## Overview

A JavaScript script that instantly downloads all images on a page on the Unsplash platform.

## Usage

- Navigate to a page on Unsplash where you want to download all the images

- Open your browser console by pressing F12 (Chrome) or CTRL + SHIFT + J (Firefox)

- Copy the script and paste into the console

- Press ENTER

## Example: Download All Liked Images

- Head to [unsplash.com/@[username]/likes](http://unsplash.com/@[username]/likes)

- Keep scrolling to the bottom until all liked images are loaded

- Run the script to download all liked images

## How It Works

When the script is run, all download links on the page will be opened in a new tab.

> ⚠️ Disclaimer: This script was not made with the intent to flood Unsplash with malicious traffic, but as a utility to make it easier to download multiple images at once from the platform.

## winner.tf (2019)

Team Fortress 2 community servers with minimal clutter. Status: Past. Stack: sourcemod. Url: http://winner.tf

## Status

Legacy project (2019). Community project for Team Fortress 2. Outcome: Discontinued due to platform risk and lack of traction ("Nobody Cared").

## Sudden Death (2018)

First team to capture wins, made for KOTH maps Status: Open Source. Stack: open source, sourcemod, source engine. Github: https://github.com/titantf/Sudden-Death

## Overview

A SourceMod plugin that makes the first team to capture the point win instantly. Designed for King of the Hill maps to create fast, intense rounds.

## Features

- Instant Win — First capture wins the round

- KOTH Optimized — Made specifically for King of the Hill

- Fast Rounds — No waiting for timers

## Tech Stack

- SourceMod

- SourcePawn

## ClassWarfare Arena (2018)

Class Warfare for Arena gamemodes like Deathrun, VSH, and Freak Fortress Status: Open Source. Stack: open source, sourcemod, source engine. Github: https://github.com/titantf/ClassWarfare-Arena

## Overview

Class Warfare adapted for Arena-style gamemodes. Forces all players to play as the same randomly selected class each round. Built for Deathrun, Versus Saxton Hale, Freak Fortress, and Prop Hunt.

## Features

- Random Class Selection — New class chosen each round

- Arena Compatible — Works with VSH, FF, Deathrun, Prop Hunt

- Fair Play — Everyone plays the same class

## Tech Stack

- SourceMod

- SourcePawn

## Total Mayhem (2018)

Increases move speed, reload/fire rate, and clip size for chaos Status: Open Source. Stack: open source, sourcemod, source engine. Github: https://github.com/titantf/Total-Mayhem

## Overview

A SourceMod plugin that cranks up the action by boosting player stats. Increases movement speed, reload rate, fire rate, and clip sizes for chaotic gameplay.

## Features

- Faster Movement — Increased move speed

- Rapid Fire — Boosted fire and reload rates

- Bigger Clips — Increased clip sizes

- Pure Chaos — Maximum action gameplay

## Tech Stack

- SourceMod

- SourcePawn

## TF2 Bowling (2018)

Bowling gamemode for TF2 using Loose Cannon, made for Titan.TF Status: Open Source. Stack: open source, sourcemod, source engine. Github: https://github.com/titantf/Bowling

## Overview

A complete bowling gamemode for Team Fortress 2, originally made for Titan.TF. Players use the Loose Cannon to knock down pins in a skill-based bowling experience. Watch Release Trailer

## Features

- Skill-Based — Uses Loose Cannon mechanics for realistic bowling physics

- 2 Lanes — Support for up to 12 players (6 per lane)

- Live Scoreboard — Real-time score tracking with strikes, spares, and baggers

- AFK Detection — Auto-kicks inactive players after 3 frames

- Custom Map Support — Easy configuration for any bowling map

## Bowling Terms

TermDescription

StrikeAll 10 pins knocked down with one ball

SpareAll 10 pins knocked down with 2 balls

Double2 strikes in a row

Turkey3 strikes in a row

x Baggerx strikes in a row

## Commands

CommandDescription

sm_bowlOpen lane selection menu

sm_readyReady up in a lane

sm_leaveLeave current lane

## Requirements

- TF2 Items Give Weapon

- SteamTools (optional, for game description)

## Credits

- Developed by myst

- Map rc1 by Sretzo

- Older map versions by Brad

## Novus (2018)

Team Fortress 2 competitive Mann vs Machine server network Status: Past. Stack: sourcemod.

## Status

Legacy project (2018). Startup attempt that faced challenges with monetization and audience growth. Outcome: Failed (Hard to Monetize, No Audience).

## TF2 TooMaNyBiNds (2014)

TF2 config script to toggle between two sets of keypad binds Status: Open Source. Stack: open source, source engine. Url: https://gamebanana.com/scripts/8471

### Overview

This script allows you to toggle a whole new set of keyboard binds with a press of a button. Each keypad key can have 2 different binds — the main binds (default) and the alt set of binds. Covers every keypad key except Num Lock.

### How It Works

- Main binds — Active when TooMaNyBiNds is off

- Alt binds — Active when TooMaNyBiNds is on

- Toggle between sets with a single key press

### Installation

- Place the script into autoexec.cfg

- Edit the "Binds" section to customize your commands

- Replace "KEY" with your desired toggle key

### Updates

- vFinal — Added missing keypad 0 keybind

- v1 — First release

### Links

- GameBanana Page

- Download (MediaFire)

## TF2 Toggle Chat (2013)

TF2 config script to toggle text and voice chat on/off Status: Open Source. Stack: open source, source engine. Url: https://gamebanana.com/scripts/8449

### Overview

A script to toggle text chat and voice chat on/off in TF2. Useful when server chat gets spammy and you need to focus.

### How It Works (v3)

The script cycles through three states with a single key:

- First press → Turns OFF text chat

- Second press → Turns OFF voice chat

- Third press → Turns ON both text and voice chat

You can still use chat normally by pressing your default chat key (Y or U).

### Installation

- Add the script to your autoexec.cfg

- Replace KEY with your desired toggle key

### Version History

- v3 — Added voice chat toggle with 3-state cycle

- v2 — Consolidated to single toggle key

- v1 — Two separate keys for on/off

### Links

- GameBanana Page

## loot.tf (2013)

Team Fortress 2 item raffle platform Status: Past. Stack: c#. Url: http://loot.tf

## Status

Legacy project (2013). TF2 item trading platform. Outcome: Discontinued ("Nobody Cared").

## insanity.tf (2013)

Early Team Fortress 2 community project Status: Past. Stack: sourcemod. Url: http://insanity.tf

## Status

Legacy project (2013). Early community project. Outcome: Pivoted to titan.tf.

## titan.tf (2013)

A Team Fortress 2 community serving 450k+ players with custom game servers Status: Past. Stack: sourcemod, php. Url: http://titan.tf

## About

A Team Fortress 2 community project founded in 2015.

## Stats

- Reach: Over 450k unique players.

- Engagement: Average of 9k monthly players, peak of 300 concurrent players.

- Infrastructure: 50+ game servers worldwide.

- Community: 20k+ Steam group members.
