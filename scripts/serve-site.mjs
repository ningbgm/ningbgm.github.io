import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const root = resolve(project, process.argv[2] || "site-preview");
const port = Number(process.argv[3] || 4173);
if (!relative(project, root) || relative(project, root).startsWith("..")) {
  throw new Error("Serve a publication build, not the workspace root.");
}
await stat(resolve(root, "index.html"));
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".mp3": "audio/mpeg" };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const file = resolve(root, `.${path === "/" ? "/index.html" : path}`);
    const name = relative(root, file).replaceAll("\\", "/");
    if (name.startsWith("..") || !(name === "index.html" || name.startsWith("web/") || name.startsWith("demo_io/")) || !types[extname(file).toLowerCase()]) {
      response.writeHead(404).end(); return;
    }
    const info = await stat(file);
    if (!info.isFile()) { response.writeHead(404).end(); return; }
    const headers = { "Content-Type": types[extname(file).toLowerCase()], "Accept-Ranges": "bytes", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" };
    let start = 0;
    let end = info.size - 1;
    let status = 200;
    if (request.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
      if (!match) { response.writeHead(416, { "Content-Range": `bytes */${info.size}` }).end(); return; }
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
      if (start > end || start >= info.size) { response.writeHead(416, { "Content-Range": `bytes */${info.size}` }).end(); return; }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
    }
    headers["Content-Length"] = end - start + 1;
    response.writeHead(status, headers);
    if (request.method === "HEAD") { response.end(); return; }
    const stream = createReadStream(file, { start, end });
    stream.on("error", () => response.destroy());
    response.on("close", () => stream.destroy());
    stream.pipe(response);
  } catch { response.writeHead(404).end(); }
});
server.listen(port, "127.0.0.1", () => console.log(`Preview: http://127.0.0.1:${port}`));
