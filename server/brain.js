// The autopilot "brain". v1 is a fast, free rules engine (no API cost).
// It is deliberately pluggable: an `generateReply()` async function is the
// single seam where you can later swap in GPT/Claude/Gemini (see README).

import { getSettings } from './store.js';

const BASE_INTENTS = [
  {
    id: 'greeting',
    aliases: ['hello', 'hi ', 'hey', 'howzit', 'sup ', 'yo ', 'hola', 'sawubona', 'good morning', 'good evening', 'howdy', 'greetings'],
    replies: [
      'Welcome in {name}! 🔥 What game should we run today?',
      'Ayy {name}, great to have you in the stream! 👊',
      '{name} enters the chat — let’s gooo!',
    ],
  },
  {
    id: 'game',
    aliases: ['what game', 'which game', 'game is this', 'game are you playing', 'playing what', 'what you playing'],
    replies: ['We’re playing {game} right now! Stay tuned for the next round 🎮'],
  },
  {
    id: 'win',
    aliases: ['gg', 'good game', 'nice win', 'you won', 'dub', 'clutch'],
    replies: ['GG {name}! That was a clean one 💪', 'Big f- energy {name}, GG! 🏆'],
  },
  {
    id: 'schedule',
    aliases: ['when do you stream', 'schedule', 'next stream', 'when live', 'streaming schedule', 'how often'],
    replies: [
      'We go live on {schedule}! Drop a follow so you don’t miss it 🔔',
      'Schedule is {schedule} — set that reminder! 🗓️',
    ],
  },
  {
    id: 'support',
    aliases: ['love the stream', 'great stream', 'nice stream', 'youre the best', 'favorite streamer', 'subbed', 'just subscribed'],
    replies: ['Much love {name} ❤️ Appreciate you being here!', 'Thank you {name}! You’re the real MVP 🙌'],
  },
  {
    id: 'socials',
    aliases: ['instagram', 'discord', 'twitter', 'x.com', 'youtube', 'tiktok', 'socials', 'other platforms', 'where else'],
    replies: ['Catch me everywhere: {socials} 🔗'],
  },
  {
    id: 'clip',
    aliases: ['!clip', 'clip that', 'clip this', 'highlight'],
    replies: ['📎 CLIP! Noted that moment {name} — I’ll cut it after the stream.'],
  },
  {
    id: 'donation',
    aliases: ['donate', 'tip ', 'how to tip', 'support you', 'donation'],
    replies: ['You can support the stream at {donation} — every bit fuels the grind 💜'],
  },
  {
    id: 'bye',
    aliases: ['bye', 'see ya', 'goodnight', 'gtg', 'later', 'cya'],
    replies: ['Later {name}! Thanks for hanging out 👋', 'See you next stream {name}! 🫡'],
  },
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function nospace(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** True if `needle` appears in `haystack` as a whole phrase (word boundaries). */
function phraseMatch(haystack, needle) {
  needle = nospace(needle);
  if (!needle) return false;
  const pattern = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${pattern}($|\\s)`).test(haystack);
}

/**
 * Given an incoming chat message, decide what (if anything) to send back.
 * Returns { reply, matchedIntent, spam } or null (stay silent).
 */
export async function decide({ text, author, platform }) {
  const s = await getSettings();
  const brain = s.brain || {};

  if (!s.autopilotEnabled) return null;

  const intents = brain.customIntents?.length ? [...BASE_INTENTS, ...brain.customIntents] : BASE_INTENTS;

  const t = nospace(text || '');
  if (!t) return null;

  // Hard-coded bot commands first
  if (t === '!clip' || t === 'clip that' || t === 'clip this') {
    return { reply: '📎 CLIP! Noted ' + (author ? `${author} — ` : '') + 'I’ll cut that moment after the stream.', matchedIntent: 'clip', spam: false };
  }
  if (t.startsWith('!game')) {
    return { reply: `We’re playing ${s.game || 'the game you see on screen'} 🎮`, matchedIntent: 'game', spam: false };
  }
  if (t.startsWith('!socials') || t.startsWith('!links')) {
    return { reply: `All my links: ${s.socials || '(add your links in Settings → Autopilot)'}`, matchedIntent: 'socials', spam: false };
  }
  if (t.startsWith('!donate')) {
    return { reply: `Support the stream: ${s.donation || '(add a link in Settings → Autopilot)'}`, matchedIntent: 'donation', spam: false };
  }
  if (t.startsWith('!schedule')) {
    return { reply: `We go live: ${s.schedule || '(set your schedule in Settings → Autopilot)'}`, matchedIntent: 'schedule', spam: false };
  }

  // FAQ answers (configurable) — whole-phrase keyword match
  const faqs = brain.faqs || [];
  for (const faq of faqs) {
    if (!faq || !faq.question || !faq.answer) continue;
    if (phraseMatch(t, faq.question)) {
      return { reply: faq.answer, matchedIntent: `faq:${faq.question}`, spam: false };
    }
  }

  // Intent keyword matching
  for (const intent of intents) {
    for (const alias of intent.aliases || []) {
      if (alias && phraseMatch(t, alias)) {
        const reply = fill(pick(intent.replies), { name: author, game: s.game, schedule: s.schedule, socials: s.socials, donation: s.donation });
        return { reply, matchedIntent: intent.id, spam: false };
      }
    }
  }

  return null;
}

function fill(template, vars) {
  return (template || '')
    .replace(/\{name\}/g, vars.name ? vars.name : 'friend')
    .replace(/\{game\}/g, vars.game || 'this game')
    .replace(/\{schedule\}/g, vars.schedule || 'most days at 19:00')
    .replace(/\{socials\}/g, vars.socials || 'in my bio')
    .replace(/\{donation\}/g, vars.donation || 'the link in my bio');
}
