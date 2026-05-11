// One-shot rasterizer: SVG logos → PNG icons committed to public/icons/.
//
// Run from apps/pwa/:
//   pnpm exec tsx scripts/rasterize-icons.ts
//
// Outputs:
//   192.png              standard app icon
//   512.png              high-res app icon (required by Lighthouse PWA)
//   512-maskable.png     same logo composited on a 20%-padded background
//                        so iOS / Android can apply rounded-corner masks
//                        without clipping the shield
//   apple-touch-icon.png 180×180 — iOS Safari pulls this from the HTML head
//
// We don't generate at build time. The PNGs are checked in so production
// boots zero-deps and there's nothing surprising in CI.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "public", "icons");
mkdirSync(out, { recursive: true });

const LOGO_SVG = `<svg width="1024" height="1024" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <path d="M 18 14 L 82 14 L 82 46 Q 82 70 50 88 Q 18 70 18 46 Z"
        fill="#d4a82c" stroke="#8a1a30" stroke-width="3.5" stroke-linejoin="round"/>
  <path d="M 22 18 L 78 18 L 78 46 Q 78 67 50 83 Q 22 67 22 46 Z"
        fill="none" stroke="#8a1a30" stroke-width="1" opacity="0.25"/>
  <text x="50" y="56" font-family="ui-monospace, monospace" font-size="32"
        fill="#8a1a30" font-weight="700" text-anchor="middle">{ }</text>
</svg>`;

// Maskable: the shield must fit inside a "safe zone" that is 80% of the
// canvas (Web App Manifest spec). We render the logo at 80% scale and
// pad with cream so the OS can crop to any shape without clipping it.
const MASKABLE_SVG = `<svg width="1024" height="1024" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect width="100" height="100" fill="#f3ead7"/>
  <g transform="translate(10 10) scale(0.8)">
    <path d="M 18 14 L 82 14 L 82 46 Q 82 70 50 88 Q 18 70 18 46 Z"
          fill="#d4a82c" stroke="#8a1a30" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M 22 18 L 78 18 L 78 46 Q 78 67 50 83 Q 22 67 22 46 Z"
          fill="none" stroke="#8a1a30" stroke-width="1" opacity="0.25"/>
    <text x="50" y="56" font-family="ui-monospace, monospace" font-size="32"
          fill="#8a1a30" font-weight="700" text-anchor="middle">{ }</text>
  </g>
</svg>`;

interface Target {
  filename: string;
  size: number;
  svg: string;
}

const targets: Target[] = [
  { filename: "192.png", size: 192, svg: LOGO_SVG },
  { filename: "512.png", size: 512, svg: LOGO_SVG },
  { filename: "512-maskable.png", size: 512, svg: MASKABLE_SVG },
  { filename: "apple-touch-icon.png", size: 180, svg: LOGO_SVG },
];

async function main(): Promise<void> {
  for (const t of targets) {
    const png = await sharp(Buffer.from(t.svg))
      .resize(t.size, t.size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const dest = resolve(out, t.filename);
    writeFileSync(dest, png);
    console.warn(`wrote ${dest} (${png.byteLength} bytes)`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
