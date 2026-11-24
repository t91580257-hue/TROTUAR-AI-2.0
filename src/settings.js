/**
 * TROTUAR AI 2.0 — модуль настроек.
 *
 * Настройки хранятся в data/settings.json (персистентны между перезапусками).
 * Значения из .env используются как значения по умолчанию при первом запуске.
 * API-ключи никогда не отправляются на клиент: наружу отдаётся только факт
 * их наличия (boolean) и замаскированный хвост.
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const DEFAULTS = {
  provider: "ollama", // 'ollama' | 'gemini'
  ollama: {
    url: process.env.OLLAMA_URL || "https://ollama.com",
    model: process.env.OLLAMA_MODEL || "gemma4:31b",
    apiKey: process.env.OLLAMA_API_KEY || "",
    systemPrompt:
      process.env.SYSTEM_PROMPT ||
      "Ты TROTUAR AI — дружелюбный и умный ассистент. Отвечай на языке пользователя. Используй Markdown для форматирования.",
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 2048
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-2.0-flash"
  },
  image: {
    provider: "pollinations",
    pollinationsApiKey: process.env.POLLINATIONS_API_KEY || "",
    editModel: process.env.POLLINATIONS_EDIT_MODEL || "openai/gpt-image-1-mini"
  }
};

function deepMerge(base, patch) {
  const out = { ...base };
  for (const key of Object.keys(patch || {})) {
    const value = patch[key];
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object") {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

let cache = null;

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    }
  } catch (error) {
    console.error("Не удалось прочитать settings.json, использую значения по умолчанию:", error.message);
    stored = {};
  }
  cache = deepMerge(DEFAULTS, stored);
  // TROTUAR AI Cloud mode: deployment environment is authoritative.
  // The API key is read only from server environment variables, never from browser settings.
  cache.provider = "ollama";
  cache.ollama.url = process.env.OLLAMA_URL || "https://ollama.com";
  cache.ollama.model = process.env.OLLAMA_MODEL || "gemma4:31b";
  cache.ollama.apiKey = process.env.OLLAMA_API_KEY || "";
  return cache;
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(load(), null, 2), "utf8");
}

function update(patch) {
  cache = deepMerge(load(), patch);
  cache.provider = "ollama";
  cache.ollama.url = process.env.OLLAMA_URL || "https://ollama.com";
  cache.ollama.model = process.env.OLLAMA_MODEL || "gemma4:31b";
  cache.ollama.apiKey = process.env.OLLAMA_API_KEY || "";
  save();
  return cache;
}

function maskSecret(secret) {
  if (!secret) return "";
  if (secret.length <= 6) return "***";
  return "…" + secret.slice(-4);
}

/** Безопасное представление для клиента: без ключей. */
function publicView() {
  const s = load();
  return {
    provider: s.provider,
    ollama: {
      url: s.ollama.url,
      model: s.ollama.model,
      apiKeyConfigured: Boolean(s.ollama.apiKey),
      apiKeyMasked: maskSecret(s.ollama.apiKey),
      systemPrompt: s.ollama.systemPrompt,
      temperature: s.ollama.temperature,
      topP: s.ollama.topP,
      maxTokens: s.ollama.maxTokens
    },
    gemini: {
      model: s.gemini.model,
      apiKeyConfigured: Boolean(s.gemini.apiKey),
      apiKeyMasked: maskSecret(s.gemini.apiKey)
    },
    image: {
      provider: s.image.provider,
      editModel: s.image.editModel,
      apiKeyConfigured: Boolean(s.image.pollinationsApiKey),
      apiKeyMasked: maskSecret(s.image.pollinationsApiKey)
    }
  };
}

module.exports = { load, save, update, publicView };
