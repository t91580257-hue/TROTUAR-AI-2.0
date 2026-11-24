/**
 * Мок-сервер Ollama для сквозного тестирования TROTUAR AI 2.0.
 * Реализует: GET /api/tags, GET /api/version, POST /api/chat (NDJSON-стриминг).
 * Запуск: node tests/mock-ollama.js [port]
 */
const http = require("http");
const PORT = Number(process.argv[2]) || 11434;

const server = http.createServer((req, res) => {
  if (req.url === "/api/tags" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      models: [
        { name: "qwen2.5:7b", size: 4700000000, details: { family: "qwen2", parameter_size: "7.6B" } },
        { name: "llama3.2-vision:11b", size: 8000000000, details: { family: "llama", parameter_size: "11B" } },
        { name: "mistral:7b", size: 4100000000, details: { family: "llama", parameter_size: "7B" } }
      ]
    }));
  }
  if (req.url === "/api/version" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ version: "0.5.4-mock" }));
  }
  if (req.url === "/api/chat" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      const last = (parsed.messages || []).filter((m) => m.role === "user").pop();
      const text = `Привет! Ты написал: "${(last?.content || "").slice(0, 120)}". Это тестовый стриминг-ответ мок-сервера Ollama.\n\nВот пример кода:\n\n\`\`\`python\nprint("TROTUAR AI 2.0 работает")\n\`\`\`\n\nИ таблица:\n\n| Режим | Статус |\n|-------|--------|\n| Чат | работает |\n| Изображение | работает |`;
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const chunks = text.match(/.{1,24}/gs) || [];
      let i = 0;
      const timer = setInterval(() => {
        if (i < chunks.length) {
          res.write(JSON.stringify({ model: parsed.model, message: { role: "assistant", content: chunks[i] }, done: false }) + "\n");
          i++;
        } else {
          res.write(JSON.stringify({ model: parsed.model, message: { role: "assistant", content: "" }, done: true, eval_count: 42 }) + "\n");
          res.end();
          clearInterval(timer);
        }
      }, 15);
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => console.log(`Mock Ollama on http://127.0.0.1:${PORT}`));
