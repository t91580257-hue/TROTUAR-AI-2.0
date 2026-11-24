/**
 * TROTUAR AI 2.0 — поддержка Google Gemini (унаследовано из TROTUAR AI 1.x).
 * Используется, если в настройках выбран provider = 'gemini'.
 * Эндпоинт Interactions API остался прежним, как в версии 1.0.
 */
const API_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

async function chat({ message, previousId, model, apiKey, timeoutMs = 90_000 }) {
  const payload = {
    model,
    input: message,
    ...(previousId ? { previous_interaction_id: previousId } : {})
  };

  const apiResponse = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
      "Api-Revision": "2026-05-20"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });

  const data = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) {
    const apiMessage = data.error?.message || "Провайдер ИИ вернул ошибку.";
    throw Object.assign(new Error(apiMessage), { status: apiResponse.status === 429 ? 429 : 502 });
  }

  const outputSteps = (data.steps || []).filter((step) => step.type === "model_output");
  const reply = outputSteps
    .flatMap((step) => step.content || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (!reply) throw Object.assign(new Error("ИИ вернул пустой ответ. Попробуйте переформулировать запрос."), { status: 502 });
  return { reply, interactionId: data.id || null };
}

module.exports = { chat };
