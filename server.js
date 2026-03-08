require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { findByEmail, createUser, verifyPassword, updateUser, getUser } = require('./users');

const anthropic = new Anthropic();

const app = express();
const PORT = process.env.PORT || 3456;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'hellocity-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 days
}));

app.use(express.static(path.join(__dirname, 'public')));

// Ensure audio output directory exists
const AUDIO_DIR = path.join(__dirname, 'public', 'audio');
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
} else {
  for (const file of fs.readdirSync(AUDIO_DIR)) {
    if (file.startsWith('emiri-')) fs.unlinkSync(path.join(AUDIO_DIR, file));
  }
}

// --- Kokoro TTS setup ---
let tts = null;

async function initTTS() {
  const { KokoroTTS } = await import('kokoro-js');
  tts = await KokoroTTS.from_pretrained(
    'onnx-community/Kokoro-82M-v1.0-ONNX',
    { dtype: 'q8', device: 'cpu' }
  );
  console.log('Kokoro TTS loaded');
  // Pre-warm the model so the first real request is fast
  await tts.generate('Hello', { voice: 'af_heart' });
  console.log('Kokoro TTS warmed up');
}

initTTS().catch(err => {
  console.error('Failed to load Kokoro TTS:', err.message);
  console.log('Server will run without TTS');
});

// Generate TTS audio and return a URL
async function generateTTSAudio(text) {
  if (!tts) return null;
  try {
    const audio = await tts.generate(text, { voice: 'af_heart' });
    const filename = 'emiri-' + Date.now() + '.wav';
    const filepath = path.join(AUDIO_DIR, filename);
    await audio.save(filepath);
    return '/audio/' + filename;
  } catch (err) {
    console.error('TTS generation error:', err.message);
    return null;
  }
}

// Clean up old audio files (older than 5 minutes)
setInterval(() => {
  if (!fs.existsSync(AUDIO_DIR)) return;
  const now = Date.now();
  for (const file of fs.readdirSync(AUDIO_DIR)) {
    if (!file.startsWith('emiri-')) continue;
    const filepath = path.join(AUDIO_DIR, file);
    const stat = fs.statSync(filepath);
    if (now - stat.mtimeMs > 5 * 60 * 1000) {
      fs.unlinkSync(filepath);
    }
  }
}, 60 * 1000);

// Clean up all audio files on shutdown
function cleanupAudio() {
  if (!fs.existsSync(AUDIO_DIR)) return;
  for (const file of fs.readdirSync(AUDIO_DIR)) {
    if (file.startsWith('emiri-')) fs.unlinkSync(path.join(AUDIO_DIR, file));
  }
}
process.on('SIGINT', () => { cleanupAudio(); process.exit(); });
process.on('SIGTERM', () => { cleanupAudio(); process.exit(); });

// --- Claude helpers ---

function parseJsonResponse(text) {
  let raw = text.trim();
  // Strip markdown fences in any format
  raw = raw.replace(/^```[\s\S]*?\n/, '').replace(/\n?```\s*$/, '');
  return JSON.parse(raw.trim());
}

async function extractInterests(text) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      system: `You extract lifestyle interests from natural language text. The user lives in Miami.

Return a JSON array of short interest labels (2-4 words each) that describe what the user enjoys.

Examples of good labels: "Mexican restaurants", "live jazz", "rooftop bars", "art galleries", "farmers markets", "beach activities", "hiking", "yoga", "coffee shops", "comedy shows", "surfing", "cooking classes", "wine tasting", "dog parks", "nightclubs", "photography", "board games", "fitness", "brunch spots"

Rules:
- Only extract interests the user explicitly mentioned or clearly implied — do NOT infer, generalize, or add related interests
- Be specific and faithful to what was said (e.g., "fashion shows" stays as "fashion shows", not "shopping" or "events")
- Each label should be a concise category, not a full sentence
- Return ONLY a valid JSON array of strings, nothing else`,
      messages: [{ role: 'user', content: text }],
    });

    const content = response.content[0];
    if (content.type === 'text') return parseJsonResponse(content.text);
    return [];
  } catch (err) {
    console.error('Claude extract error:', err.message);
    return [];
  }
}

async function generateInterestsPrompt(userName) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 150,
      system: `You are Emiri, a friendly young female onboarding assistant for CityHello, a Miami city guide app. You're chatting with ${userName}.

Write a short, casual message (1-2 sentences) asking what they like to do in their free time. Mention 3-4 example activities to spark ideas, but vary them each time — pick from things like restaurants, nightlife, outdoor activities, fitness, arts, markets, music, sports, wellness, shopping, etc.

Do NOT greet them by name or say hi/hey — you're already mid-conversation. Just transition naturally into the question.
Keep it warm and conversational. No emojis. Reply with ONLY your message text.`,
      messages: [{ role: 'user', content: 'Generate the message.' }],
    });
    const content = response.content[0];
    if (content.type === 'text') return content.text;
  } catch (err) {
    console.error('Claude interests prompt error:', err.message);
  }
  return `So ${userName}, what do you like to do for fun around town?`;
}

async function fetchFoursquarePhoto(venueName) {
  const key = process.env.FOURSQUARE_API_KEY;
  if (!key) { console.log('FSQ: no API key'); return ''; }
  try {
    const params = new URLSearchParams({ query: venueName, near: 'Miami, FL', limit: '1' });
    const res = await fetch('https://api.foursquare.com/v3/places/search?' + params, {
      headers: { Authorization: key, Accept: 'application/json' },
    });
    if (!res.ok) { console.log('FSQ search failed:', res.status, await res.text()); return ''; }
    const data = await res.json();
    const place = data.results && data.results[0];
    if (!place) { console.log('FSQ: no place found for', venueName); return ''; }
    console.log('FSQ: found place', place.name, place.fsq_id);

    const photoRes = await fetch(`https://api.foursquare.com/v3/places/${place.fsq_id}/photos?limit=1`, {
      headers: { Authorization: key, Accept: 'application/json' },
    });
    if (!photoRes.ok) { console.log('FSQ photo failed:', photoRes.status); return ''; }
    const photos = await photoRes.json();
    console.log('FSQ photos:', photos.length, photos.length > 0 ? photos[0].prefix + '300x200' + photos[0].suffix : 'none');
    if (photos.length > 0) return photos[0].prefix + '300x200' + photos[0].suffix;
    return '';
  } catch (err) {
    console.log('FSQ error:', err.message);
    return '';
  }
}

async function findMiamiVenues(interest) {
  // Claude generates real Miami venues
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
      system: `You are a Miami city guide database. Given a user interest, return exactly 3 real, existing venues, events, or experiences in Miami-Dade County related to that interest.

Return a JSON array with exactly 3 objects, each having:
- name: string (real venue/event name that actually exists)
- recommendation: string (1-2 sentence warm, personalized recommendation)
- description: string (1 sentence factual description)
- category: string (e.g. "Restaurant", "Bar", "Park", "Gallery", "Gym", "Cafe", "Club", "Beach", "Venue")
- tags: array of 2-3 lowercase short tags
- address: string (real street address)
- hours: string (typical hours, e.g. "Daily 8am-10pm" or "Varies by event")

CRITICAL: Every venue must be a REAL place that exists in Miami. Do not invent fictional places.
Return ONLY valid JSON, nothing else.`,
      messages: [{ role: 'user', content: interest }],
    });

    let venues = [];
    const content = response.content[0];
    if (content.type === 'text') venues = parseJsonResponse(content.text);

    // Fetch Foursquare photos in parallel
    const withPhotos = await Promise.all(venues.map(async (v) => {
      const image = await fetchFoursquarePhoto(v.name);
      return { ...v, image };
    }));

    return withPhotos;
  } catch (err) {
    console.error('Venue search error:', err.message);
    return [];
  }
}

async function generateFollowup(userName, collectedInterests, userMessage) {
  const have = collectedInterests.length;
  const need = 3 - have;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 150,
      system: `You are Emiri, a friendly young female onboarding assistant for CityHello, a Miami city guide app. You're chatting with ${userName}. Keep your tone warm, casual, and encouraging — like a friend who just moved to Miami and is excited to learn what they're into.

Your goal: get the user to share their interests and hobbies so you can personalize their experience. You need at least 3 interests total.

${have > 0 ? `So far you've picked up on: ${collectedInterests.join(', ')}.` : "You haven't picked up on any specific interests yet."}
You still need ${need} more.

The user just said: "${userMessage}"

Write a short, natural follow-up (1-2 sentences) that:
- Acknowledges what they said
- Gently asks for more details about what they enjoy
- Feels conversational, not like a form
- Does NOT list out categories or give examples in a robotic way

Reply with ONLY your message text, nothing else.`,
      messages: [{ role: 'user', content: 'Generate the follow-up message.' }],
    });

    const content = response.content[0];
    if (content.type === 'text') return content.text;
    return "That's cool! Tell me more — what else do you like doing around town?";
  } catch (err) {
    console.error('Claude followup error:', err.message);
    return "That's cool! Tell me more — what else do you like doing around town?";
  }
}

// --- API routes ---

app.post('/api/signup', async (req, res) => {
  const { firstName, lastName, phone, countryCode, email, password } = req.body;

  if (!firstName || !lastName || !phone || !email || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  if (findByEmail(email)) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const user = await createUser({ firstName, lastName, phone, countryCode: countryCode || '+1', email, password });
  req.session.user = { id: user.id, firstName: user.firstName, onboardingComplete: user.onboardingComplete };
  // Initialize onboarding state in session
  req.session.onboarding = { step: 'livingSituation', collectedInterests: [] };
  res.json({ success: true });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = await verifyPassword(email, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  req.session.user = { id: user.id, firstName: user.firstName, onboardingComplete: user.onboardingComplete };
  // Determine onboarding step from saved data
  if (!user.onboardingComplete) {
    let step = 'livingSituation';
    const d = user.onboardingData || {};
    if (d.livingSituation && !d.neighborhood) step = 'neighborhood';
    else if (d.livingSituation && d.neighborhood && !d.interests) step = 'interests';
    req.session.onboarding = {
      step,
      collectedInterests: (d.interests && d.interests.extracted) || [],
    };
  }
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  const user = getUser(req.session.user.id);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }
  res.json({
    firstName: user.firstName,
    onboardingComplete: user.onboardingComplete,
    onboardingData: user.onboardingData,
  });
});

// Get the initial Emiri message for the current onboarding step
app.get('/api/onboarding/start', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const user = getUser(req.session.user.id);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (user.onboardingComplete) return res.json({ complete: true });

  // Ensure onboarding session state
  if (!req.session.onboarding) {
    let step = 'livingSituation';
    const d = user.onboardingData || {};
    if (d.livingSituation && !d.neighborhood) step = 'neighborhood';
    else if (d.livingSituation && d.neighborhood && !d.interests) step = 'interests';
    req.session.onboarding = {
      step,
      collectedInterests: (d.interests && d.interests.extracted) || [],
    };
  }

  const step = req.session.onboarding.step;
  const firstName = req.session.user.firstName;
  let message;

  if (step === 'livingSituation') {
    message = `Hi ${firstName}, I'm Emiri. Let's onboard you with CityHello! Do you live alone, or with: a boyfriend/girlfriend, a husband/wife, a family with kids?`;
  } else if (step === 'neighborhood') {
    message = "Nice! And what part of town do you live in?";
  } else {
    message = await generateInterestsPrompt(firstName);
  }

  const audioUrl = await generateTTSAudio(message);
  res.json({ message, audioUrl, step });
});

// Handle each user chat message during onboarding
app.post('/api/onboarding/chat', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const user = getUser(req.session.user.id);
  if (!user) return res.status(401).json({ error: 'User not found' });

  const { message: userMessage } = req.body;
  if (!userMessage) return res.status(400).json({ error: 'Message required' });

  const ob = req.session.onboarding || { step: 'livingSituation', collectedInterests: [] };
  const firstName = req.session.user.firstName;

  if (ob.step === 'livingSituation') {
    // Save living situation
    user.onboardingData.livingSituation = userMessage;
    updateUser(user.id, { onboardingData: user.onboardingData });

    ob.step = 'neighborhood';
    req.session.onboarding = ob;

    const reply = "Nice! And what part of town do you live in?";
    const audioUrl = await generateTTSAudio(reply);
    return res.json({ reply, audioUrl, complete: false });
  }

  if (ob.step === 'neighborhood') {
    // Save neighborhood
    user.onboardingData.neighborhood = userMessage;
    updateUser(user.id, { onboardingData: user.onboardingData });

    ob.step = 'interests';
    req.session.onboarding = ob;

    const reply = await generateInterestsPrompt(firstName);
    const audioUrl = await generateTTSAudio(reply);
    return res.json({ reply, audioUrl, complete: false });
  }

  if (ob.step === 'interests') {
    // Sub-step: user confirmed/denied an interest — either way it counts
    if (ob.subStep === 'confirm') {
      if (ob.currentInterest && !ob.collectedInterests.includes(ob.currentInterest)) {
        ob.collectedInterests.push(ob.currentInterest);
      }
      ob.currentInterest = null;
      ob.subStep = null;

      // More pending interests to show?
      if (ob.pendingInterests && ob.pendingInterests.length > 0) {
        const next = ob.pendingInterests.shift();
        ob.currentInterest = next;
        ob.subStep = 'confirm';
        req.session.onboarding = ob;

        const venues = await findMiamiVenues(next);
        const reply = `And ${next} — here are some spots you might like:`;
        const audioUrl = await generateTTSAudio(reply);
        return res.json({ reply, audioUrl, complete: false, venues, currentInterest: next, showConfirm: true });
      }

      // Check if done
      if (ob.collectedInterests.length >= 3) {
        user.onboardingData.interests = { extracted: ob.collectedInterests };
        updateUser(user.id, { onboardingData: user.onboardingData, onboardingComplete: true });
        req.session.user.onboardingComplete = true;

        const reply = "Love it! I've got a great feel for what you're into. I'll personalize your CityHello experience with these. You're all set!";
        const audioUrl = await generateTTSAudio(reply);
        return res.json({ reply, audioUrl, complete: true, interests: ob.collectedInterests });
      }

      // Need more interests
      req.session.onboarding = ob;
      const reply = await generateFollowup(firstName, ob.collectedInterests, userMessage);
      const audioUrl = await generateTTSAudio(reply);
      return res.json({ reply, audioUrl, complete: false });
    }

    // Regular text input — extract interests
    const newInterests = await extractInterests(userMessage);

    if (newInterests.length > 0) {
      const first = newInterests[0];
      ob.pendingInterests = newInterests.slice(1);
      ob.currentInterest = first;
      ob.subStep = 'confirm';
      req.session.onboarding = ob;

      const venues = await findMiamiVenues(first);
      const reply = `Ooh, ${first}! Check these out:`;
      const audioUrl = await generateTTSAudio(reply);
      return res.json({ reply, audioUrl, complete: false, venues, currentInterest: first, showConfirm: true });
    }

    // No interests extracted — ask again
    req.session.onboarding = ob;
    const reply = await generateFollowup(firstName, ob.collectedInterests, userMessage);
    const audioUrl = await generateTTSAudio(reply);
    return res.json({ reply, audioUrl, complete: false });
  }
});

// --- Page routes ---

// Homepage (login/signup page)
app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect('/onboarding');
  }
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Terms & Privacy Policy — accessible without login
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'terms.html'));
});

// Onboarding — requires login
app.get('/onboarding', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'views', 'onboarding.html'));
});

// All other routes require auth — redirect to homepage if not logged in
app.use((req, res, next) => {
  if (req.session && req.session.user) {
    return next();
  }
  res.redirect('/');
});

// 404 handler — must be last
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'views', '404.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
