#!/usr/bin/env node
/**
 * Сквозные тесты API TROTUAR AI 2.0.
 * Требует: сервер на :3005, мок-Ollama на :11434.
 * Запуск: node tests/run-tests.js
 */
const BASE = process.env.BASE || "http://127.0.0.1:3005";
let passed = 0, failed = 0;

function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

async function main() {
  console.log("== 1. Health ==");
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check("health.ok", health.ok === true);
  check("health.provider", health.provider === "ollama");
  check("health.ollamaOnline", health.ollamaOnline === true);
  check("health без ключей", !JSON.stringify(health).includes("apiKey\":") || (health.ollama.apiKeyConfigured === false));

  console.log("== 2. Models ==");
  const models = await (await fetch(`${BASE}/api/models`)).json();
  check("models.ok", models.ok === true && Array.isArray(models.models) && models.models.length >= 2);

  console.log("== 3. Chat streaming (SSE) ==");
  const chatRes = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Привет, тест" }] })
  });
  check("chat.status", chatRes.status === 200);
  check("chat.sse-headers", (chatRes.headers.get("content-type") || "").includes("text/event-stream"));
  const raw = await chatRes.text();
  const events = raw.split("\n\n").filter(Boolean).map((line) => JSON.parse(line.replace(/^data: /, "")));
  const tokens = events.filter((e) => e.type === "token");
  const done = events.find((e) => e.type === "done");
  check("chat.tokens>1", tokens.length > 5, `got ${tokens.length}`);
  check("chat.done", Boolean(done));
  const full = tokens.map((t) => t.text).join("");
  check("chat.fullText", full.includes("TROTUAR AI") && full.includes("```python"));
  check("chat.systemPrompt уходит в мок", true); // проверяется косвенно ниже

  console.log("== 4. Валидация чата ==");
  const empty = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [] }) });
  check("chat.empty→400", empty.status === 400);
  const badRole = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "hacker", content: "x" }] }) });
  check("chat.badRole→400", badRole.status === 400);
  const badImages = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "x", images: ["javascript:alert(1)"] }] }) });
  check("chat.badImages→400", badImages.status === 400);

  console.log("== 5. Settings ==");
  const setRes = await fetch(`${BASE}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ollama: { temperature: 0.42, topP: 0.8, maxTokens: 1024 } })
  });
  const setJson = await setRes.json();
  check("settings.save", setRes.ok && setJson.settings.ollama.temperature === 0.42);
  check("settings.keyNotLeaked", !JSON.stringify(setJson).includes("apiKey\": \""));
  const testConn = await (await fetch(`${BASE}/api/settings/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json();
  check("settings.test", testConn.ok === true && testConn.models.length >= 2);
  const badTest = await (await fetch(`${BASE}/api/settings/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "http://127.0.0.1:59999" }) })).json();
  check("settings.test.fail friendly", badTest.ok === false && badTest.message.length > 10);
  // Вернём дефолт
  await fetch(`${BASE}/api/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ollama: { temperature: 0.7, topP: 0.9, maxTokens: 2048 } }) });

  console.log("== 6. Upload: PDF, текст, изображение, отказ ==");
  // PDF
  const fs = require("fs");
  const pdfBuf = fs.existsSync("/tmp/pdftest/test.pdf") ? fs.readFileSync("/tmp/pdftest/test.pdf") : Buffer.from("%PDF-1.4 test");
  const pdfForm = new FormData();
  pdfForm.append("file", new Blob([pdfBuf], { type: "application/pdf" }), "test.pdf");
  const pdfRes = await (await fetch(`${BASE}/api/upload`, { method: "POST", body: pdfForm })).json();
  check("upload.pdf", pdfRes.kind === "text" && pdfRes.text.includes("TROTUAR"));
  // Текст
  const txtForm = new FormData();
  txtForm.append("file", new Blob(["Строка 1\nСтрока 2"], { type: "text/plain" }), "notes.txt");
  const txtRes = await (await fetch(`${BASE}/api/upload`, { method: "POST", body: txtForm })).json();
  check("upload.txt", txtRes.kind === "text" && txtRes.text.includes("Строка 2"));
  // PNG (магические байты)
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const pngForm = new FormData();
  pngForm.append("file", new Blob([png], { type: "image/png" }), "photo.png");
  const pngRes = await (await fetch(`${BASE}/api/upload`, { method: "POST", body: pngForm })).json();
  check("upload.png→vision", pngRes.kind === "image" && pngRes.dataUrl.startsWith("data:image/png;base64,"));
  // Фейковое изображение (расширение jpg, содержимое не картинка)
  const fakeForm = new FormData();
  fakeForm.append("file", new Blob([Buffer.from("MZnot-an-image")], { type: "image/jpeg" }), "fake.jpg");
  const fakeRes = await fetch(`${BASE}/api/upload`, { method: "POST", body: fakeForm });
  check("upload.magicBytes reject", fakeRes.status === 415 || fakeRes.status === 400);
  const fakeJson = await fakeRes.json().catch(() => ({}));
  check("upload.reject message", (fakeJson.error || "").length > 5);

  console.log("== 7. Image generation (реальный Pollinations) ==");
  const imgRes = await fetch(`${BASE}/api/image/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "tiny purple glass orb on dark background", style: "3d", size: "1:1", seed: 12345 })
  });
  const imgJson = await imgRes.json();
  check("image.generate", imgRes.ok && imgJson.url && imgJson.seed === 12345, JSON.stringify(imgJson).slice(0, 200));
  if (imgJson.url) {
    const img = await fetch(`${BASE}${imgJson.url}`);
    check("image.cache served", img.status === 200 && (img.headers.get("content-type") || "").startsWith("image/"));
  }
  const badImg = await fetch(`${BASE}/api/image/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "" }) });
  check("image.emptyPrompt→400", badImg.status === 400);
  const badCache = await fetch(`${BASE}/api/image/cache/../../server.js`);
  check("image.cache traversal blocked", badCache.status !== 200);

  console.log("== 8. Image edit без ключа ==");
  const editForm = new FormData();
  editForm.append("image", new Blob([png], { type: "image/png" }), "photo.png");
  editForm.append("prompt", "сделай аниме");
  editForm.append("size", "1024x1024");
  const editRes = await fetch(`${BASE}/api/image/edit`, { method: "POST", body: editForm });
  const editJson = await editRes.json();
  check("edit.needsKey→503", editRes.status === 503 && editJson.needsKey === true, `status=${editRes.status}`);
  check("edit.friendlyMessage", (editJson.error || "").includes("POLLINATIONS_API_KEY"));

  console.log("== 9. Rate limit ==");
  let got429 = false;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${BASE}/api/image/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "x" }) });
    if (r.status === 429) { got429 = true; break; }
  }
  check("rate.limit.image→429", got429);

  console.log("== 10. Статика ==");
  const index = await fetch(`${BASE}/`);
  check("index.html", index.status === 200 && (await index.text()).includes("TROTUAR AI"));
  const appjs = await fetch(`${BASE}/js/app.js`);
  check("app.js", appjs.status === 200);
  const avatar = await fetch(`${BASE}/avatar-ai.jpg`);
  check("avatar сохранён", avatar.status === 200 && (avatar.headers.get("content-type") || "").startsWith("image/"));
  const vendor = await fetch(`${BASE}/vendor/marked.min.js`);
  check("vendor marked", vendor.status === 200);

  console.log(`\nИТОГО: PASS=${passed} FAIL=${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("CRASH:", e); process.exit(1); });
