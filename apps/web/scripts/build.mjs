import { cp, mkdir, rm } from "node:fs/promises";

await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
for (const file of ["index.html", "styles.css", "app.js"]) {
  await cp(new URL(`../src/${file}`, import.meta.url), new URL(`../dist/${file}`, import.meta.url));
}

