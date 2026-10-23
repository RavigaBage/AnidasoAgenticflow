'use strict';

const fs = require('fs');
const path = require('path');

const TTS_CATEGORIES = new Set(['name', 'number', 'amount', 'reference']);

function normalizeSpokenText(value) {
  return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

function loadAudioLibrary(audioLibraryDirectory) {
  const libraryPath = path.join(audioLibraryDirectory, 'urls.json');

  try {
    const library = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
    const missingFiles = [];
    const clips = Object.entries(library).flatMap(([key, entry]) => {
      if (!entry || !Number.isInteger(entry.audio_file_id) || typeof entry.language !== 'string' ||
          entry.language.toLocaleLowerCase() !== 'twi' || typeof entry.content_item !== 'string' ||
          typeof entry.url !== 'string') {
        return [];
      }

      const file = entry.url.replace(/\\/g, '/');
      if (file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..')) {
        console.warn(`[Audio Arranger] Ignoring unsafe audio path for "${key}".`);
        return [];
      }

      const clipPath = path.resolve(audioLibraryDirectory, file);
      if (!clipPath.startsWith(`${path.resolve(audioLibraryDirectory)}${path.sep}`)) {
        console.warn(`[Audio Arranger] Ignoring audio path outside the library for "${key}".`);
        return [];
      }
      if (!fs.existsSync(clipPath)) {
        missingFiles.push(`${key}: ${file}`);
        return [];
      }

      return [{
        id: String(entry.audio_file_id),
        file,
        text: entry.content_item,
        language: 'twi'
      }];
    });
    if (missingFiles.length) {
      console.warn(`[Audio Arranger] Audio files listed in urls.json are missing: ${missingFiles.join(', ')}`);
    }
    return clips;
  } catch (err) {
    console.warn('[Audio Arranger] Could not load audio library:', err.message);
    return [];
  }
}

function fallbackArrangement(reply) {
  return [{ type: 'tts', category: 'reference', text: String(reply || '') }];
}

function parseArrangement(content, reply, availableClips) {
  let parsed;
  try {
    const raw = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    parsed = JSON.parse(raw);
  } catch (err) {
    return null;
  }

  if (!parsed || !Array.isArray(parsed.segments) || parsed.segments.length === 0) return null;

  const clipsById = new Map(availableClips.map(clip => [clip.id, clip]));
  const validated = [];

  for (const segment of parsed.segments) {
    if (!segment || typeof segment.text !== 'string' || !segment.text.trim()) return null;

    if (segment.type === 'clip') {
      const clip = clipsById.get(segment.id);
      if (!clip || normalizeSpokenText(segment.text) !== normalizeSpokenText(clip.text)) return null;
      validated.push({ type: 'clip', id: clip.id, file: clip.file, text: segment.text });
      continue;
    }

    if (segment.type === 'tts') {
      const category = TTS_CATEGORIES.has(segment.category) ? segment.category : 'reference';
      validated.push({ type: 'tts', category, text: segment.text });
      continue;
    }

    return null;
  }

  const assembled = normalizeSpokenText(validated.map(segment => segment.text).join(''));
  if (!assembled || assembled !== normalizeSpokenText(reply)) return null;
  return validated;
}

function buildArrangementPrompt({ userTranscription, assistantReply, conversation, clips }) {
  return `Arrange audio for one spoken assistant reply. Return JSON only in this shape: {"segments":[{"type":"clip","id":"clip-id","text":"exact clip text"},{"type":"tts","category":"name|number|amount|reference","text":"exact reply text"}]}.

Use only the supplied clip IDs. A clip's text must be spoken exactly as listed. Use TTS for all reply words not covered by an exact clip. TTS text must be copied exactly from the assistant reply, in order, with no translation, paraphrase, omission, or additions. Use category name for a person's name, number for phone digits, amount for money, and reference for all other missing audio. Keep adjacent missing words together in one TTS segment where possible. The concatenated segment text must reproduce the entire assistant reply exactly, including every word and value. Do not choose empathy audio unless the assistant reply itself contains empathy.

Caller transcription: ${JSON.stringify(userTranscription || '')}
Recent conversation: ${JSON.stringify(Array.isArray(conversation) ? conversation : [])}
Assistant reply: ${JSON.stringify(assistantReply || '')}
Available clips: ${JSON.stringify(Array.isArray(clips) ? clips.map(({ id, text }) => ({ id, text })) : [])}`;
}

module.exports = {
  buildArrangementPrompt,
  fallbackArrangement,
  loadAudioLibrary,
  parseArrangement
};
