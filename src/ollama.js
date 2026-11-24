/**
 * TROTUAR AI 2.0 — клиент Ollama.
 *
 * Использует НАТИВНЫЙ API Ollama (/api/chat, /api/tags, /api/version).
 * Стриминг: Ollama отдаёт NDJSON построчно, мы парсим каждую строку
 * и отдаём токен в колбэк. Поддерживает необязательный Bearer-ключ
 * (например, для облачного Ollama: https://ollama.com).
 */

const DEFAULT_TIMEOUT_MS = 300_000; // 5 минут на длинные генерации
const TEST_TIMEOUT_MS = 12_000;

function normalizeUrl(url) {
  let value = String(url || "").trim();
  if (!value) value = "http://127.0.0.1:11434";
  if (!/^https?:\/\//i.test(value)) value = "http://" + value;
  return value.replace(/\/+$/, "");
}

function headers(apiKey) {
  const base = { "Content-Type": "application/json" };
  if (apiKey) base["Authorization"] = `Bearer ${apiKey}`;
  return base;
}

function friendlyError(error, ollamaUrl) {
  if (!process.env.OLLAMA_API_KEY && /^https:\/\/ollama\.com$/i.test(ollamaUrl)) {
    return "Ollama Cloud ещё не настроен на сервере: добавьте OLLAMA_API_KEY в Secrets / Environment Variables и перезапустите backend.";
  }
  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return "Ollama не ответил за отведённое время. Если модель большая — увеличьте таймаут OLLAMA_TIMEOUT_MS или попробуйте более лёгкую модель.";
  }
  if (error.cause && (error.cause.code === "ECONNREFUSED" || error.cause.code === "ENOTFOUND" || error.cause.code === "ECONNRESET")) {
    return `Не удалось подключиться к Ollama (${ollamaUrl}). Проверьте, что сервер запущен: \`ollama serve\`, и адрес доступен с машины, где работает TROTUAR AI.`;
  }
  return error.message || "Неизвестная ошибка при обращении к Ollama.";
}

/** GET /api/tags — список локальных моделей. */
async function listModels({ url, apiKey } = {}) {
  const config = require("./settings").load();
  const ollamaUrl = normalizeUrl(url || config.ollama.url);
  const key = apiKey !== undefined ? apiKey : config.ollama.apiKey;
  const response = await fetch(`${ollamaUrl}/api/tags`, {
    headers: headers(key),
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ollama вернул ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = await response.json();
  return (data.models || []).map((m) => ({
    name: m.name,
    size: m.size,
    family: m.details?.family || "",
    parameterSize: m.details?.parameter_size || ""
  }));
}

/** Проверка подключения: /api/version + /api/tags. */
async function testConnection({ url, apiKey } = {}) {
  const config = require("./settings").load();
  const ollamaUrl = normalizeUrl(url || config.ollama.url);
  const key = apiKey !== undefined ? apiKey : config.ollama.apiKey;
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, {
      headers: headers(key),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      return { ok: false, url: ollamaUrl, message: `Ollama ответил со статусом ${response.status}.` };
    }
    const data = await response.json();
    const models = (data.models || []).map((m) => m.name);
    return {
      ok: true,
      url: ollamaUrl,
      models,
      message: `Подключение установлено. Доступно моделей: ${models.length}.`
    };
  } catch (error) {
    return { ok: false, url: ollamaUrl, message: friendlyError(error, ollamaUrl) };
  }
}

/**
 * Потоковый чат. Вызывает onToken({content, done, meta}) на каждый чанк.
 * Возвращает полный текст ответа.
 */
async function chatStream({ messages, model, options = {}, apiKey, onToken, signal }) {
  const config = require("./settings").load();
  const ollamaUrl = normalizeUrl(config.ollama.url);
  const key = apiKey !== undefined ? apiKey : config.ollama.apiKey;
  const body = {
    model: model || config.ollama.model,
    messages,
    stream: true,
    options: {
      temperature: options.temperature ?? config.ollama.temperature,
      top_p: options.topP ?? config.ollama.topP,
      num_predict: options.maxTokens ?? config.ollama.maxTokens
    }
  };

  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(Number(process.env.OLLAMA_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error || detail;
    } catch {}
    throw new Error(`Ollama вернул ${response.status}: ${detail}`);
  }
  if (!response.body) throw new Error("Ollama не вернул поток данных.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let chunk;
      try {
        chunk = JSON.parse(line);
      } catch {
        continue; // игнорируем неполные строки
      }
      if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
      const token = chunk.message?.content || "";
      if (token) {
        full += token;
        if (onToken) onToken({ content: token });
      }
      if (chunk.done) {
        if (onToken) {
          onToken({
            done: true,
            meta: {
              totalDuration: chunk.total_duration,
              evalCount: chunk.eval_count,
              model: chunk.model
            }
          });
        }
        return { text: full, meta: chunk };
      }
    }
  }
  if (onToken) onToken({ done: true, meta: { model: body.model } });
  return { text: full, meta: {} };
}

module.exports = { listModels, testConnection, chatStream, normalizeUrl, friendlyError };
