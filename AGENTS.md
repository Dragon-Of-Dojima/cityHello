# CityHello

## Overview
CityHello is an Express.js web app that serves as a Miami city guide. Users sign up, go through an onboarding chatbot (Emiri), and get a personalized experience based on their interests.

## Tech Stack
- **Runtime:** Node.js with Express.js
- **Auth:** express-session (cookie-based, 30-day expiry)
- **Passwords:** bcryptjs
- **TTS:** Kokoro TTS (kokoro-js) — `af_heart` voice, server-side WAV generation
- **NLP:** Claude API (Haiku 4.5) for interest extraction and conversational follow-ups
- **Storage:** JSON file (`data/users.json`)
- **Font:** Inter (Google Fonts)

## Project Structure
```
├── server.js              # Express server, API routes, Kokoro TTS, Claude integration
├── users.js               # User CRUD, bcrypt hashing, JSON file store
├── .env                   # ANTHROPIC_API_KEY (not committed)
├── views/
│   ├── index.html         # Login/signup page
│   ├── onboarding.html    # Emiri chatbot onboarding
│   ├── terms.html         # Terms & privacy policy
│   └── 404.html           # 404 page
├── public/
│   ├── css/
│   │   ├── style.css      # Global styles
│   │   └── dashboard.css  # Onboarding/dashboard styles
│   └── audio/             # Generated TTS files (auto-cleaned)
└── data/
    └── users.json         # User database (auto-created)
```

## Key Design Decisions
- **All state is server-side.** Onboarding step, collected interests, and user profile are managed in the session and persisted to `data/users.json`. The client is a thin layer that sends messages and plays responses.
- **Interest extraction uses Claude Haiku 4.5** to interpret natural language (e.g., "I like chilling by the water" → "beach activities"). Emiri pushes back with natural language follow-ups until she has at least 3 interests.
- **TTS is fully open source** via Kokoro (Apache 2.0). Audio is generated server-side and served as WAV files. Old files are auto-cleaned every 60 seconds.
- **No JWT** — cookie sessions are simpler for this server-rendered architecture.
- **Unauthenticated users** are redirected to `/` (login/signup) for all routes except `/terms`.

## API Routes
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/signup | No | Create account |
| POST | /api/login | No | Log in |
| POST | /api/logout | Yes | Log out |
| GET | /api/me | Yes | Get current user info |
| GET | /api/onboarding/start | Yes | Get Emiri's initial message + audio |
| POST | /api/onboarding/chat | Yes | Send message, get Emiri's reply + audio |

## Onboarding Flow
1. **Living situation** — "Do you live alone, with a partner, family, etc.?"
2. **Neighborhood** — "What part of town do you live in?"
3. **Interests** — Free-text, Claude extracts interests. Emiri keeps asking (with natural language follow-ups) until she has at least 3.

## Signup Validation
- Email: valid format
- Phone: 10 digits with country code selector (default +1)
- Password: 10+ characters, 1 uppercase, 1 special symbol
- Confirm password must match
- Create Account button only activates when all fields are valid

## Running
```bash
npm install
# Add your Anthropic API key to .env
npm start
```

First start downloads the Kokoro voice model (~100MB, cached after that).
