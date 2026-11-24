/**
 * TROTUAR AI 2.0 — загрузка и разбор файлов.
 *
 * Безопасность:
 *  - проверка МАГИЧЕСКИХ БАЙТОВ (не доверяем расширению);
 *  - жёсткий лимит размера (задаётся в server.js);
 *  - файлы не сохраняются на диск: буфер живёт в памяти,
 *    наружу отдаётся извлечённый текст или data URI для vision-моделей.
 */
const path = require("path");
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");

const STANDARD_FONTS_URL = path.join(__dirname, "..", "node_modules", "pdfjs-dist", "standard_fonts") + path.sep;

const MAX_TEXT_CHARS = 120_000; // обрезка извлечённого текста

const IMAGE_MIMES = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/webp": null // проверяется по сигнатуре RIFF....WEBP
};

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "json", "log", "yml", "yaml", "xml", "html", "css",
  "js", "mjs", "cjs", "ts", "jsx", "tsx", "py", "rb", "go", "rs", "java", "kt", "c",
  "cpp", "h", "hpp", "cs", "php", "sh", "bash", "sql", "toml", "ini", "env"
]);

function detectMagic(buffer) {
  const bytes = buffer.subarray(0, 16);
  if (!bytes.length) return null;
  for (const [mime, signature] of Object.entries(IMAGE_MIMES)) {
    if (!signature) continue;
    if (signature.every((byte, i) => bytes[i] === byte)) return mime;
  }
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
  return null;
}

function sanitizeText(text) {
  let value = String(text || "").replace(/\u0000/g, "").replace(/\r\n/g, "\n");
  if (value.length > MAX_TEXT_CHARS) {
    value = value.slice(0, MAX_TEXT_CHARS) + `\n\n[Документ обрезан: показано первые ${MAX_TEXT_CHARS} символов из ${value.length}.]`;
  }
  return value;
}

/**
 * Разбор загруженного файла.
 * Возвращает { kind: 'text'|'image', name, mime, text?, dataUrl?, truncated? }
 */
async function parseFile({ originalname, buffer, mimetype }) {
  const extension = String(originalname || "").split(".").pop().toLowerCase();

  // 1) Изображения — для vision-моделей Ollama (llava, llama3.2-vision, qwen2.5-vl...)
  const detectedImage = detectMagic(buffer);
  if (detectedImage && detectedImage.startsWith("image/")) {
    const mime = detectedImage === "image/webp" ? "image/webp" : detectedImage;
    return {
      kind: "image",
      name: String(originalname || "image").slice(0, 120),
      mime,
      size: buffer.length,
      dataUrl: `data:${mime};base64,${buffer.toString("base64")}`
    };
  }

  // 2) PDF — извлекаем текст (pdfjs-dist, стабильно работает в Node 20+)
  if (detectedImage === "application/pdf" || mimetype === "application/pdf" || extension === "pdf") {
    try {
      const doc = await pdfjs.getDocument({
        data: new Uint8Array(buffer),
        isEvalSupported: false,
        useSystemFonts: false,
        standardFontDataUrl: STANDARD_FONTS_URL
      }).promise;
      let text = "";
      const maxPages = Math.min(doc.numPages, 120);
      for (let i = 1; i <= maxPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map((item) => item.str).join(" ");
        text += pageText + "\n\n";
      }
      if (doc.numPages > maxPages) text += `[Показаны первые ${maxPages} страниц из ${doc.numPages}.]\n\n`;
      return {
        kind: "text",
        name: String(originalname || "document.pdf").slice(0, 120),
        mime: "application/pdf",
        size: buffer.length,
        text: sanitizeText(text.trim() || "(PDF не содержит извлекаемого текста — возможно, это скан. Распознавание сканов не поддерживается.)")
      };
    } catch (error) {
      throw Object.assign(new Error(`Не удалось разобрать PDF: ${error.message}`), { status: 400 });
    }
  }

  // 3) Текстовые файлы
  if (TEXT_EXTENSIONS.has(extension) || mimetype.startsWith("text/")) {
    const decoded = buffer.toString("utf8");
    // Эвристика бинарности: много управляющих символов — не текст
    const controlChars = (decoded.match(/[\x00-\x08\x0E-\x1F]/g) || []).length;
    if (decoded.length && controlChars / decoded.length > 0.05) {
      throw Object.assign(new Error("Файл выглядит бинарным и не поддерживается. Загрузите текст, PDF или изображение."), { status: 415 });
    }
    return {
      kind: "text",
      name: String(originalname || "file").slice(0, 120),
      mime: mimetype || "text/plain",
      size: buffer.length,
      text: sanitizeText(decoded)
    };
  }

  throw Object.assign(
    new Error("Поддерживаются: изображения (PNG, JPG, WebP), PDF и текстовые файлы (txt, md, код, csv, json...)."),
    { status: 415 }
  );
}

module.exports = { parseFile, detectMagic, sanitizeText, TEXT_EXTENSIONS };
