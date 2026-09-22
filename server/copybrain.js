// Copy Brain — auto-writes the marketing copy for every clip/VOD.
// Free (no LLM call): deterministic, vibe-curated templates + context.

import { getSettings } from './store.js';

const pick = (arr, seedText) => {
  if (!arr || !arr.length) return '';
  // deterministic-ish: hash the seed so the same clip gets the same copy
  let h = 0;
  for (let i = 0; i < String(seedText || '').length; i++) h = (h * 31 + String(seedText).charCodeAt(i)) >>> 0;
  return arr[h % arr.length];
};

const TITLE_STYLES = [
  'THIS {game} MOMENT WAS ILLEGAL 😱🔥',
  '{game} CLUTCH SO CLEAN THEY THOUGHT I HACKED 🎯',
  'YOU WON’T BELIEVE THIS {game} ENDING 💀',
  'the most DISRESPECTFUL {game} play you’ll see today',
  '{game} ranked clip that broke my controller 🎮',
  'POV: you’re watching the best {game} clip of the week 🏆',
  'this {game} moment belongs in a museum 🖼️',
];

const DESC_TEMPLATES = [
  'Clip from today’s stream of {game} 🎮 Drop a like if you’d watch a full montage. {hashtags}',
  'Caught this live while grinding {game}. What rank/level am I? Guess in the comments 👇 {hashtags}',
  'That’s the kind of {game} energy we bring every stream. Turning on notifications? 🔔 {hashtags}',
  'Straight from the PS5/live — {game} be having a mind of its own 😭 {hashtags}',
];

const BASE_HASHTAGS = ['gaming', 'gamingclips', 'shorts', 'tiktokgaming', 'highlight', 'fyp', 'gamers', 'streamer', 'clutch'];

function gameTag(game) {
  const g = String(game || '').trim();
  return g ? g.toLowerCase().replace(/[^a-z0-9]/g, '') : null;
}

/**
 * Generate copy for a clip/VOD.
 * @param {object} ctx { game, author, titleSeed, kind: 'clip'|'vod' }
 */
export async function generateCopy(ctx = {}) {
  const s = await getSettings();
  const game = ctx.game || s.game || 'gaming';
  const seed = ctx.titleSeed || `${game}:${ctx.kind || 'clip'}:${Date.now()}`;
  const gt = gameTag(game);

  const tags = new Set(BASE_HASHTAGS);
  if (gt) tags.add(gt);
  if (gt) tags.add(gt + 'clips');
  for (const t of (s.brain?.hashtags || [])) if (t) tags.add(t.trim().toLowerCase().replace(/^#/, ''));

  const hashtagStr = [...tags].map((t) => '#' + t).join(' ');

  let title;
  if (ctx.customTitle) {
    title = ctx.customTitle;
  } else if (ctx.kind === 'clip') {
    title = pick(TITLE_STYLES, seed).replace(/\{game\}/g, game);
  } else {
    title = `${game} — Full Stream Highlights (${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}) 🎮`;
  }

  const description = pick(DESC_TEMPLATES, seed + ':desc')
    .replace(/\{game\}/g, game)
    .replace(/\{hashtags\}/g, hashtagStr)
    + (ctx.extra ? `\n\n${ctx.extra}` : '');

  return { title, description, tags: [...tags], hashtags: hashtagStr };
}
