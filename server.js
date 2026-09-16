import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT || 4173);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

const server = createServer(async (request, response) => {
  try {
    const requested = request.url === "/" ? "index.html" : decodeURIComponent(request.url.split("?")[0]).replace(/^\/+/, "");
    const path = normalize(join(root, requested));
    if (!path.startsWith(root)) throw new Error("Invalid path");
    const content = await readFile(path);
    response.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not found");
  }
});

let nextPort = port;

server.on("error", (error) => {
  if (error.code !== "EADDRINUSE") throw error;
  console.log(`Port ${nextPort} is in use, trying ${nextPort + 1}.`);
  nextPort += 1;
  server.listen(nextPort);
});

server.on("listening", () => {
  const address = server.address();
  console.log(`Copilot Budget Lab: http://localhost:${address.port}`);
});

server.listen(nextPort);
