/**
 * TROTUAR AI 2.0 — основной сервер.
 *
 * Архитектура:
 *  - Статика: public/ (SPA TROTUAR AI, стиль Liquid Glass сохранён из 1.x)
 *  - Текстовый ИИ: Ollama (нативный API, стриминг SSE) + резервный Gemini из 1.x
 *  - Изображения: Pollinations (генерация бесплатно; редактирование по ключу)
 *  - Файлы: PDF/текст/изображения — разбор в памяти, ничего не пишем на диск
 *
 * Безопасность:
 *  - API-ключи только на сервере (.env + data/settings.json, не отдаются клиенту)
 *  - серверная валидация всех входов, лимиты размеров, rate limit по IP
 *  - загруженные фото пользователей не сохраняются
 */
require("dotenv").config();

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const settings = require("./src/settings");
const ollama = require("./src/ollama");
const gemini = require("./src/gemini");
const images = require("./src/images");
const uploads = require("./src/uploads");
const { createLimiter } = require("./src/limiter");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------- Общие лимиты и безопасность ----------
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "SAMEORIGIN");
  res.set("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.json({ limit: "256kb" })); // чат-запросы компактны: текст + параметры

const chatLimiter = createLimiter({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_CHAT) || 20,
  message: "Слишком много сообщений подряд. Подождите минуту."
});
const imageLimiter = createLimiter({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_IMAGE) || 6,
  message: "Лимит генераций изображений исчерпан. Подождите минуту (бесплатный API работает с задержкой между запросами)."
});
const uploadLimiter = createLimiter({ windowMs: 60_000, max: 12 });

// ---------- Мультизагрузка (в память, без записи на диск) ----------
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB) * 1024 * 1024 || 15 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "image/jpeg", "image/png", "image/webp", "application/pdf",
      "text/plain", "text/markdown", "text/csv", "application/json"
    ];
    const extension = file.originalname.split(".").pop().toLowerCase();
    if (allowed.includes(file.mimetype) || uploads.TEXT_EXTENSIONS.has(extension)) cb(null, true);
    else cb(new Error("Этот тип файла не поддерживается. Доступны: PNG, JPG, WebP, PDF, текстовые файлы."));
  }
});

// ---------- Статика ----------
app.use(express.static(PUBLIC_DIR, { index: false, maxAge: "1d", setHeaders: (res, filePath) => {
  // HTML, CSS и JS — всегда свежие; кэшируются только картинки и вендорные библиотеки
  if (filePath.endsWith("index.html") || filePath.endsWith(".css") || (filePath.endsWith(".js") && !filePath.includes("vendor"))) {
    res.setHeader("Cache-Control", "no-cache");
  }
}}));
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

// ---------- Здоровье и модели ----------
app.get("/api/health", async (_req, res) => {
  const view = settings.publicView();
  let ollamaOnline = null;
  if (view.provider === "ollama") {
    const result = await ollama.testConnection();
    ollamaOnline = result.ok;
  }
  res.json({ ok: true, version: "2.0.0", ...view, ollamaOnline });
});

app.get("/api/models", async (_req, res) => {
  try {
    const models = await ollama.listModels();
    res.json({ ok: true, models });
  } catch (error) {
    res.status(502).json({ ok: false, error: ollama.friendlyError(error, settings.load().ollama.url) });
  }
});

// ---------- Чат (стриминг SSE) ----------
const MAX_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 60_000;
const MAX_IMAGES_PER_MESSAGE = 4;

app.post("/api/chat", chatLimiter, async (req, res) => {
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];

  if (!messages.length) return res.status(400).json({ error: "Пустой запрос: нет сообщений." });
  if (messages.length > MAX_MESSAGES) return res.status(400).json({ error: `Слишком длинная история (максимум ${MAX_MESSAGES} сообщений).` });

  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant" && m.role !== "system")) {
      return res.status(400).json({ error: "Некорректная роль сообщения." });
    }
    if (typeof m.content !== "string" || m.content.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: "Сообщение слишком длинное." });
    }
    if (m.images && (!Array.isArray(m.images) || m.images.length > MAX_IMAGES_PER_MESSAGE)) {
      return res.status(400).json({ error: `Максимум ${MAX_IMAGES_PER_MESSAGE} изображения на сообщение.` });
    }
    if (m.images && m.images.some((i) => typeof i !== "string" || !i.startsWith("data:image/"))) {
      return res.status(400).json({ error: "Изображения должны быть в формате data URI." });
    }
  }

  const config = settings.load();
  const model = typeof body.model === "string" && body.model.length <= 100 ? body.model : undefined;

  // SSE-заголовки
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const abort = new AbortController();
  // ВАЖНО: событие close у req срабатывает после получения тела запроса,
  // поэтому отслеживаем разрыв соединения только на res.
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  try {
    if (config.provider === "gemini") {
      if (!config.gemini.apiKey) {
        send({ type: "error", message: "GEMINI_API_KEY не настроен. Добавьте ключ в .env или переключите провайдера на Ollama в настройках." });
        return res.end();
      }
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const result = await gemini.chat({
        message: lastUser ? lastUser.content : "",
        previousId: typeof body.geminiInteractionId === "string" ? body.geminiInteractionId.slice(0, 100) : null,
        model: config.gemini.model,
        apiKey: config.gemini.apiKey
      });
      send({ type: "token", text: result.reply });
      send({ type: "done", meta: { provider: "gemini", interactionId: result.interactionId } });
      return res.end();
    }

    // Основной провайдер — Ollama, нативный стриминг
    const payload = messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(Array.isArray(m.images) && m.images.length ? { images: m.images.map((dataUrl) => dataUrl.split(",")[1]) } : {})
    }));
    if (config.ollama.systemPrompt && config.ollama.systemPrompt.trim()) {
      payload.unshift({ role: "system", content: config.ollama.systemPrompt.trim().slice(0, 4000) });
    }

    await ollama.chatStream({
      messages: payload,
      model,
      options: body.options || {},
      signal: abort.signal,
      onToken: ({ content, done, meta }) => {
        if (done) send({ type: "done", meta: { ...(meta || {}), provider: "ollama" } });
        else send({ type: "token", text: content });
      }
    });
    res.end();
  } catch (error) {
    if (req.aborted || abort.signal.aborted) {
      send({ type: "aborted" });
    } else {
      console.error("Chat error:", error.message);
      send({ type: "error", message: ollama.friendlyError(error, config.ollama.url) });
    }
    res.end();
  }
});

// ---------- Настройки ----------
app.get("/api/settings", (_req, res) => {
  res.json({ ok: true, settings: settings.publicView() });
});

app.post("/api/settings", (req, res) => {
  const body = req.body || {};
  const patch = {};

  if (body.provider === "ollama" || body.provider === "gemini") patch.provider = body.provider;

  if (body.ollama && typeof body.ollama === "object") {
    const o = body.ollama;
    patch.ollama = {};
    if (typeof o.url === "string") {
      if (!/^https?:\/\/.+/i.test(o.url.trim()) && !/^[a-z0-9.-]+:\d+$/i.test(o.url.trim())) {
        return res.status(400).json({ error: "Некорректный адрес Ollama. Пример: http://127.0.0.1:11434 или https://ollama.example.com" });
      }
      patch.ollama.url = o.url.trim().slice(0, 300);
    }
    if (typeof o.model === "string") patch.ollama.model = o.model.trim().slice(0, 100);
    if (typeof o.apiKey === "string") patch.ollama.apiKey = o.apiKey.trim().slice(0, 200);
    if (typeof o.systemPrompt === "string") patch.ollama.systemPrompt = o.systemPrompt.slice(0, 4000);
    for (const key of ["temperature", "topP"]) {
      const num = Number(o[key]);
      if (Number.isFinite(num) && num >= 0 && num <= 2) patch.ollama[key] = Math.round(num * 100) / 100;
    }
    const maxTokens = Number(o.maxTokens);
    if (Number.isFinite(maxTokens) && maxTokens >= 64 && maxTokens <= 32768) patch.ollama.maxTokens = Math.floor(maxTokens);
  }
  if (body.gemini && typeof body.gemini === "object") {
    patch.gemini = {};
    if (typeof body.gemini.apiKey === "string") patch.gemini.apiKey = body.gemini.apiKey.trim().slice(0, 200);
    if (typeof body.gemini.model === "string") patch.gemini.model = body.gemini.model.trim().slice(0, 100);
  }
  if (body.image && typeof body.image === "object") {
    patch.image = {};
    if (typeof body.image.pollinationsApiKey === "string") patch.image.pollinationsApiKey = body.image.pollinationsApiKey.trim().slice(0, 200);
    if (typeof body.image.editModel === "string") patch.image.editModel = body.image.editModel.trim().slice(0, 120);
  }

  settings.update(patch);
  res.json({ ok: true, settings: settings.publicView() });
});

app.post("/api/settings/test", async (req, res) => {
  const body = req.body || {};
  const result = await ollama.testConnection({ url: body.url, apiKey: body.apiKey });
  res.json({ ok: result.ok, message: result.message, url: result.url, models: result.models || [] });
});

// ---------- Изображения ----------
app.post("/api/image/generate", imageLimiter, async (req, res) => {
  const body = req.body || {};
  const config = settings.load();
  try {
    const params = {
      prompt: typeof body.prompt === "string" ? body.prompt : "",
      style: typeof body.style === "string" && images.STYLES[body.style] !== undefined ? body.style : "none",
      size: typeof body.size === "string" && images.SIZES[body.size] ? body.size : "1:1",
      seed: body.seed
    };
    const useKey = Boolean(config.image.pollinationsApiKey) && body.useKeyApi === true;
    const result = useKey
      ? await images.generateImageWithKey({ ...params, apiKey: config.image.pollinationsApiKey })
      : await images.generateImage(params);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get("/api/image/cache/:file", (req, res) => {
  const file = req.params.file;
  if (!/^[a-f0-9]{24}\.(jpg|png)$/.test(file)) return res.status(400).json({ error: "Некорректное имя файла." });
  const full = path.join(images.CACHE_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: "Изображение не найдено или удалено из кэша. Сгенерируйте заново." });
  res.set("Cache-Control", "public, max-age=604800");
  res.sendFile(full);
});

app.post("/api/image/edit", uploadLimiter, upload.single("image"), async (req, res) => {
  const config = settings.load();
  if (!req.file) return res.status(400).json({ error: "Файл не получен." });
  const prompt = typeof req.body.prompt === "string" ? req.body.prompt.trim().slice(0, 4000) : "";
  const size = typeof req.body.size === "string" ? req.body.size : "1024x1024";
  if (!prompt) return res.status(400).json({ error: "Опишите, что нужно изменить на фото." });
  try {
    const result = await images.editImage({
      buffer: req.file.buffer,
      mime: req.file.mimetype,
      prompt,
      size,
      apiKey: config.image.pollinationsApiKey,
      model: config.image.editModel
    });
    res.json({ ok: true, dataUrl: result.dataUrl });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, needsKey: Boolean(error.needsKey) });
  }
});

// ---------- Загрузка файлов (чат: PDF, текст, картинки для vision) ----------
app.post("/api/upload", uploadLimiter, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не получен." });
  try {
    const parsed = await uploads.parseFile({
      originalname: req.file.originalname,
      buffer: req.file.buffer,
      mimetype: req.file.mimetype
    });
    res.json({ ok: true, ...parsed });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ---------- Ошибки multer и 404 ----------
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? `Файл слишком большой (максимум ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} МБ).`
      : `Ошибка загрузки файла: ${error.code}`;
    return res.status(413).json({ error: message });
  }
  if (error) return res.status(error.status || 500).json({ error: error.message || "Внутренняя ошибка сервера." });
});

app.use((_req, res) => res.status(404).json({ error: "Эндпоинт не найден." }));

app.listen(PORT, () => {
  const view = settings.publicView();
  console.log("==================================================");
  console.log("  TROTUAR AI 2.0 запущен");
  console.log(`  Адрес:        http://localhost:${PORT}`);
  console.log(`  Провайдер:    ${view.provider}`);
  console.log(`  Ollama URL:   ${view.ollama.url}`);
  console.log(`  Модель:       ${view.ollama.model}`);
  console.log(`  Изображения:  Pollinations (ключ ${view.image.apiKeyConfigured ? "настроен" : "НЕ настроен: только генерация"})`);
  console.log("==================================================");
  if (!fs.existsSync(path.join(__dirname, ".env"))) {
    console.warn("Подсказка: создайте файл .env из .env.example для своих настроек.");
  }
});
