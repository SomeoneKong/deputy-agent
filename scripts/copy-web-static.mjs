// After build, copy the Web GUI static assets (src/web/static -> dist/web/static).
// tsc compiles only .ts; the native html/css/js frontend is not compiled and must be
// copied to the output directory separately.
import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src", "web", "static");
const dest = join(here, "..", "dist", "web", "static");

if (!existsSync(src)) {
  console.warn(`copy-web-static: source missing ${src}, skip`);
  process.exit(0);
}
await mkdir(dirname(dest), { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`copy-web-static: ${src} -> ${dest}`);
