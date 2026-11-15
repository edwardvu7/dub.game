'use strict';
// Player settings and API keys. Keys are encrypted with Electron's safeStorage and stay in the
// main process: nothing in this module's public (IPC) shape ever contains a key.
const fs = require('node:fs');
const path = require('node:path');

const ENV_NAMES = { elevenlabs: 'ELEVENLABS_API_KEY', gemini: 'GEMINI_API_KEY', grok: 'XAI_API_KEY' };

/**
 * createSettings({file, safeStorage, env?, testers?})
 * safeStorage: Electron's safeStorage (or a stand-in with the same three methods).
 * testers: { elevenlabs(key) -> {ok,error?}, gemini(key) -> {ok,error?} }
 */
function createSettings({ file, safeStorage, env = process.env, testers = {} }) {
  let data = { narration: true, clipboardMode: false, acting: true, keys: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = {
      narration: raw.narration !== false,
      clipboardMode: raw.clipboardMode === true,
      acting: raw.acting !== false,
      keys: raw.keys && typeof raw.keys === 'object' ? raw.keys : {},
    };
  } catch { /* first launch */ }
  const memoryKeys = {}; // used only when the OS offers no encryption: kept for this session

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  const canEncrypt = () => {
    try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
  };

  /** Main-process only. Player's saved key first, then the .env/dev key. */
  function getKey(provider) {
    if (!Object.prototype.hasOwnProperty.call(ENV_NAMES, provider)) return '';
    if (memoryKeys[provider]) return memoryKeys[provider];
    const stored = data.keys[provider];
    if (stored && canEncrypt()) {
      try { return safeStorage.decryptString(Buffer.from(stored, 'base64')); } catch { /* fall through */ }
    }
    return (env[ENV_NAMES[provider]] || '').trim();
  }

  function getPublic() {
    return {
      hasElevenLabsKey: !!getKey('elevenlabs'),
      hasGeminiKey: !!getKey('gemini'),
      hasGrokKey: !!getKey('grok'),
      narration: data.narration,
      clipboardMode: data.clipboardMode,
      acting: data.acting,
    };
  }

  return {
    getKey,
    getPublic,
    narration: () => data.narration,
    clipboardMode: () => data.clipboardMode,
    acting: () => data.acting,

    /** setKeys({elevenlabs?, gemini?, grok?}): a non-empty string saves, an empty string removes. */
    setKeys(keys) {
      for (const provider of Object.keys(ENV_NAMES)) {
        const value = keys && keys[provider];
        if (typeof value !== 'string') continue;
        const key = value.trim();
        delete memoryKeys[provider];
        delete data.keys[provider];
        if (!key) continue;
        if (canEncrypt()) data.keys[provider] = safeStorage.encryptString(key).toString('base64');
        else memoryKeys[provider] = key; // never written to disk unencrypted
      }
      save();
      return getPublic();
    },

    setNarration(on) { data.narration = !!on; save(); return getPublic(); },
    setClipboardMode(on) { data.clipboardMode = !!on; save(); return getPublic(); },
    setActing(on) { data.acting = !!on; save(); return getPublic(); },

    /** test({provider}) -> {ok, error?}: one tiny call with the saved key. */
    async test(arg) {
      const provider = arg && arg.provider;
      if (!Object.prototype.hasOwnProperty.call(ENV_NAMES, provider || '') || !testers[provider]) {
        return { ok: false, error: 'Unknown provider.' };
      }
      const key = getKey(provider);
      if (!key) return { ok: false, error: 'No key saved yet.' };
      try {
        const r = await testers[provider](key);
        return r && r.ok ? { ok: true } : { ok: false, error: String((r && r.error) || 'Test failed.') };
      } catch (e) {
        return { ok: false, error: String(e && e.message) };
      }
    },
  };
}

module.exports = { createSettings, ENV_NAMES };
