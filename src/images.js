/**
 * TROTUAR AI 2.0 — генерация и редактирование изображений.
 *
 * ГЕНЕРАЦИЯ (бесплатно, без ключа — проверено):
 *   GET https://image.pollinations.ai/prompt/{prompt}?width=&height=&seed=&nologo=true
 *   Лимит анонимного доступа: ~1 запрос / 45 сек, иначе 402 + Retry-After.
 *   Сгенерированные файлы кэшируются в data/generated (не фото пользователей),
 *   чтобы история картинок открывалась мгновенно и без повторных запросов.
 *
 * РЕДАКТИРОВАНИЕ (требуется ключ POLLINATIONS_API_KEY с enter.pollinations.ai):
 *   POST https://gen.pollinations.ai/v1/images/edits
 *   OpenAI-совместимый JSON: { prompt, image:[{image_url}], model, size, response_format }
 *   image_url может быть data URI — фото не нужно размещать на публичном хостинге.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const GEN_BASE = "https://image.pollinations.ai/prompt/";
const GEN_API_BASE = "https://gen.pollinations.ai/v1/images/generations";
const EDIT_API_BASE = "https://gen.pollinations.ai/v1/images/edits";

const CACHE_DIR = path.join(__dirname, "..", "data", "generated");
const CACHE_MAX_FILES = 60;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней

const STYLES = {
  none: "",
  realism: "photorealistic, hyperrealistic photography, 8k, sharp focus, natural lighting",
  anime: "anime style, cel shading, vibrant colors, studio anime artwork",
  "3d": "3D render, octane render, soft studio lighting, high detail, pixar-like",
  pixel: "pixel art, 16-bit retro game sprite style, crisp pixels",
  cartoon: "cartoon style, bold outlines, flat vivid colors, playful",
  fantasy: "epic fantasy art, magical atmosphere, intricate details, matte painting",
  cyberpunk: "cyberpunk style, neon lights, futuristic city, high contrast, moody",
  painting: "digital painting, expressive brush strokes, artstation trending"
};

const SIZES = {
  "1:1": { width: 1024, height: 1024 },
  "3:2": { width: 1248, height: 832 },
  "2:3": { width: 832, height: 1248 },
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 }
};

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function pruneCache() {
  if (!fs.existsSync(CACHE_DIR)) return;
  const entries = fs.readdirSync(CACHE_DIR).map((name) => {
    const full = path.join(CACHE_DIR, name);
    return { name, full, mtime: fs.statSync(full).mtimeMs };
  });
  const now = Date.now();
  let files = entries.filter((e) => now - e.mtime < CACHE_MAX_AGE_MS);
  for (const e of entries) {
    if (now - e.mtime >= CACHE_MAX_AGE_MS) fs.unlinkSync(e.full);
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const e of files.slice(CACHE_MAX_FILES)) fs.unlinkSync(e.full);
}

function buildPrompt(prompt, style) {
  const suffix = STYLES[style] || "";
  return suffix ? `${prompt}. Style: ${suffix}` : prompt;
}

/**
 * Генерация изображения. Возвращает { fileName, url, seed }.
 * Классический бесплатный эндпоинт детерминирован при одинаковом seed.
 */
async function generateImage({ prompt, style = "none", size = "1:1", seed }) {
  if (!prompt || !prompt.trim()) throw Object.assign(new Error("Опишите, что нужно нарисовать."), { status: 400 });
  if (prompt.length > 2000) throw Object.assign(new Error("Слишком длинный запрос (максимум 2000 символов)."), { status: 400 });

  const dimensions = SIZES[size] || SIZES["1:1"];
  const usedSeed = Number.isFinite(Number(seed)) && Number(seed) > 0
    ? Math.floor(Number(seed))
    : crypto.randomInt(1, 2_000_000_000);
  const fullPrompt = buildPrompt(prompt.trim(), style);
  const url = `${GEN_BASE}${encodeURIComponent(fullPrompt)}?width=${dimensions.width}&height=${dimensions.height}&seed=${usedSeed}&nologo=true&safe=false`;

  // Сервис бывает временно перегружен (503) — делаем до 3 попыток с паузой
  let response = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (response.ok) break;
      lastError = response.status;
    } catch (error) {
      lastError = error;
    }
    response = null;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 4000 + attempt * 6000));
  }
  if (!response) {
    if (lastError === 402 || lastError === 429) {
      throw Object.assign(
        new Error("Сервис изображений перегружен (лимит бесплатного доступа). Подождите около 45 секунд и попробуйте снова."),
        { status: 429 }
      );
    }
    throw Object.assign(
      new Error(`Сервис изображений недоступен${lastError ? ` (ошибка ${lastError})` : ""}. Попробуйте ещё раз через минуту.`),
      { status: 502 }
    );
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    throw Object.assign(new Error("Сервис вернул не изображение. Попробуйте переформулировать запрос."), { status: 502 });
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 24);
  const fileName = `${hash}.jpg`;
  ensureCacheDir();
  fs.writeFileSync(path.join(CACHE_DIR, fileName), buffer);
  pruneCache();

  return {
    fileName,
    url: `/api/image/cache/${fileName}`,
    seed: usedSeed,
    width: dimensions.width,
    height: dimensions.height,
    providerUrl: url
  };
}

/** Генерация через ключевой API (больше лимитов, модели flux). */
async function generateImageWithKey({ prompt, style = "none", size = "1:1", seed, apiKey, model }) {
  const dimensions = SIZES[size] || SIZES["1:1"];
  const body = {
    prompt: buildPrompt(prompt, style),
    width: dimensions.width,
    height: dimensions.height,
    model: model || "black-forest-labs/flux.1-schnell",
    response_format: "b64_json",
    ...(Number.isFinite(Number(seed)) && Number(seed) > 0 ? { seed: Math.floor(Number(seed)) } : {})
  };
  const response = await fetch(GEN_API_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(
      new Error(data?.error?.message || `Pollinations API вернул ${response.status}.`),
      { status: response.status === 401 ? 401 : 502 }
    );
  }
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw Object.assign(new Error("API не вернул изображение."), { status: 502 });
  const buffer = Buffer.from(b64, "base64");
  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 24);
  const fileName = `${hash}.png`;
  ensureCacheDir();
  fs.writeFileSync(path.join(CACHE_DIR, fileName), buffer);
  pruneCache();
  return { fileName, url: `/api/image/cache/${fileName}`, seed: body.seed || null };
}

/**
 * Редактирование фото. ФОТО ПОЛЬЗОВАТЕЛЯ НИГДЕ НЕ СОХРАНЯЕТСЯ:
 * буфер живёт в памяти только на время запроса и уходит провайдеру
 * в виде data URI в JSON-запросе.
 */
async function editImage({ buffer, mime, prompt, size = "1024x1024", apiKey, model }) {
  if (!apiKey) {
    throw Object.assign(
      new Error(
        "Для редактирования фотографий нужен ключ Pollinations (POLLINATIONS_API_KEY). Бесплатный анонимный API не поддерживает image-to-image. Получите ключ на enter.pollinations.ai и добавьте его в .env — инструкция в README, раздел «Редактирование фото»."
      ),
      { status: 503, needsKey: true }
    );
  }
  if (!prompt || !prompt.trim()) {
    throw Object.assign(new Error("Опишите, что нужно изменить на фото."), { status: 400 });
  }
  const dataUri = `data:${mime};base64,${buffer.toString("base64")}`;
  const body = {
    prompt: prompt.trim().slice(0, 4000),
    image: [{ image_url: dataUri }],
    model: model || undefined,
    size: /^\d{1,4}x\d{1,4}$/.test(size) ? size : "1024x1024",
    response_format: "b64_json"
  };
  const response = await fetch(EDIT_API_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Pollinations Edit API вернул ${response.status}.`;
    if (response.status === 401) {
      throw Object.assign(new Error("Ключ Pollinations недействителен (401). Проверьте POLLINATIONS_API_KEY в .env."), { status: 401 });
    }
    throw Object.assign(new Error(message), { status: 502 });
  }
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw Object.assign(new Error("API редактирования не вернул изображение."), { status: 502 });
  return { dataUrl: `data:image/png;base64,${b64}` };
}

module.exports = { generateImage, generateImageWithKey, editImage, STYLES, SIZES, CACHE_DIR };
