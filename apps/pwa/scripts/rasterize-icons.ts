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

// Dark icon tile: near-black background, white shield outline, wine
// `{ }` glyph — matches the app's dark-first rebrand. The background
// rect is essential: a fill-less outline would be invisible on a
// light tab strip or home screen.
const LOGO_SVG = `<svg width="1024" height="1024" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect width="100" height="100" fill="#0d0d10"/>
  <path d="M 18 16 L 82 16 L 82 48 Q 82 72 50 88 Q 18 72 18 48 Z"
        fill="none" stroke="#ededef" stroke-width="5.5" stroke-linejoin="round"/>
  <text x="50" y="58" font-family="ui-monospace, monospace" font-size="30"
        fill="#cf3a52" font-weight="700" text-anchor="middle">{ }</text>
</svg>`;

// Maskable: the shield must fit inside a "safe zone" that is 80% of the
// canvas (Web App Manifest spec). We render the logo at 80% scale and
// pad with the canvas near-black so the OS can crop to any shape
// without clipping the shield.
const MASKABLE_SVG = `<svg width="1024" height="1024" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect width="100" height="100" fill="#0d0d10"/>
  <g transform="translate(10 10) scale(0.8)">
    <path d="M 18 16 L 82 16 L 82 48 Q 82 72 50 88 Q 18 72 18 48 Z"
          fill="none" stroke="#ededef" stroke-width="5.5" stroke-linejoin="round"/>
    <text x="50" y="58" font-family="ui-monospace, monospace" font-size="30"
          fill="#cf3a52" font-weight="700" text-anchor="middle">{ }</text>
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
