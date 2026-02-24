import sharp from "sharp";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public", "icons");

await mkdir(publicDir, { recursive: true });

const sizes = [192, 512];
const bg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0a0a0a"/>
  <text x="256" y="280" font-family="system-ui,sans-serif" font-size="120" font-weight="700" fill="#ededed" text-anchor="middle">B</text>
</svg>`
);

for (const size of sizes) {
  const png = await sharp(bg).resize(size, size).png().toBuffer();
  await writeFile(join(publicDir, `icon-${size}x${size}.png`), png);
  console.log(`Created icon-${size}x${size}.png`);
}

console.log("PWA icons generated in public/icons/");
