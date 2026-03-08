# CityHello

## Overview
CityHello is an Express.js web app that serves as a Miami city guide. Users sign up, go through an onboarding chatbot (Emiri), and get a personalized dashboard based on their interests and neighborhood.

## Tech Stack
- **Runtime:** Node.js with Express.js
- **Auth:** express-session (cookie-based, 30-day expiry)
- **Passwords:** bcryptjs
- **TTS:** Kokoro TTS (kokoro-js) — `af_heart` voice, server-side WAV generation. "Emiri" is phonetically replaced with "Emiry" before TTS so it pronounces as "eh-MIH-ree".
- **NLP:** Claude API (Haiku 4.5) for interest extraction, conversational follow-ups, and venue recommendations
- **Storage:** JSON file (`data/users.json`)
- **Font:** Inter (Google Fonts)
- **Container:** Docker (node:22-slim), docker-compose support

## Project Structure
```
├── server.js              # Express server, API routes, Kokoro TTS, Claude integration
├── users.js               # User CRUD, bcrypt hashing, JSON file store
├── .env                   # ANTHROPIC_API_KEY (not committed)
├── Dockerfile             # node:22-slim based container
├── docker-compose.yml     # Single-service compose config
├── .dockerignore          # Excludes node_modules, .env, data, audio
├── views/
│   ├── index.html         # Login/signup page
│   ├── onboarding.html    # Emiri chatbot onboarding + dashboard (serves both routes)
│   ├── terms.html         # Terms & privacy policy
│   └── 404.html           # 404 page
├── public/
│   ├── css/
│   │   ├── style.css      # Global styles
│   │   └── dashboard.css  # Onboarding/dashboard/typing indicator styles
│   └── audio/             # Generated TTS files (auto-cleaned)
└── data/
    └── users.json         # User database (auto-created)
```

## Key Design Decisions
- **All state is server-side.** Onboarding step, collected interests, and user profile are managed in the session and persisted to `data/users.json`. The client is a thin layer that sends messages and plays responses.
- **Interests are persisted incrementally.** Each confirmed interest is saved to `users.json` immediately, not just when 3 are collected. This ensures interests survive if the user leaves mid-onboarding.
- **Interest extraction uses Claude Haiku 4.5** to interpret natural language (e.g., "I like chilling by the water" → "beach activities"). Emiri pushes back with natural language follow-ups until she has at least 3 interests.
- **Venue recommendations are location-aware.** `findMiamiVenues(interest, neighborhood)` tells Claude to resolve the user's neighborhood/zip code and prioritize venues within a 10-mile radius (nearest first). Only if fewer than 3 results exist within 10 miles does it include further venues.
- **TTS is fully open source** via Kokoro (Apache 2.0). Audio is generated server-side and served as WAV files. Old files are auto-cleaned every 60 seconds.
- **No JWT** — cookie sessions are simpler for this server-rendered architecture.
- **Unauthenticated users** are redirected to `/` (login/signup) for all routes except `/terms`.
- **Separate routes for onboarding vs dashboard.** `/onboarding` and `/dashboard` serve the same HTML file but redirect between each other based on `onboardingComplete`. Login redirects to the appropriate route.

## API Routes
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/signup | No | Create account |
| POST | /api/login | No | Log in (returns `onboardingComplete` flag) |
| POST | /api/logout | Yes | Log out |
| GET | /api/me | Yes | Get current user info + onboardingData |
| GET | /api/onboarding/start | Yes | Get Emiri's initial message + audio |
| POST | /api/onboarding/chat | Yes | Send message, get Emiri's reply + audio |
| GET | /api/interests/venues | Yes | Get venue cards for a single interest (query param: `interest`) |

## Page Routes
| Path | Description |
|------|-------------|
| / | Login/signup page (redirects to /dashboard or /onboarding if already logged in) |
| /onboarding | Emiri chatbot onboarding (redirects to /dashboard if complete) |
| /dashboard | Dashboard with interest cards + "Ask Emiri!" button (redirects to /onboarding if incomplete) |
| /terms | Terms & privacy policy (no auth required) |

## Onboarding Flow
1. **Living situation** — "Do you live alone, with a partner, family, etc.?"
2. **Neighborhood** — "What part of town do you live in?"
3. **Interests** — Free-text, Claude extracts interests. Emiri keeps asking (with natural language follow-ups) until she has at least 3. Each interest shows venue cards with a confirm/deny flow.
4. **Completion** — Redirects to `/dashboard`

A typing indicator ("Emiri is typing...") appears in the chat while waiting for server responses.

## Dashboard (post-onboarding)
- Shows "Welcome, [name]!" heading
- "Ask Emiri!" button
- Interest sections: each saved interest as a heading with 3 venue cards underneath (fetched from `/api/interests/venues`)
- Venue cards show name, photo (Foursquare), category, tags, address, hours, description, and a "More Info" link

## Login/Signup
- Login button activates (styled) when both email and password have content
- Login redirects to `/dashboard` if onboarding is complete, `/onboarding` if not
- Signup validation: valid email, 10-digit phone with country code, password 10+ chars with 1 uppercase + 1 special symbol, confirm match
- Create Account button only activates when all fields are valid

## Running
```bash
npm install
# Add your Anthropic API key to .env
npm start
```

Or with Docker:
```bash
docker compose up --build
```

First start downloads the Kokoro voice model (~100MB, cached after that).
Port defaults to 3456 (configurable via `PORT` env var).
