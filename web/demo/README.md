# denoise-voice-clarity — live demo

A zero-backend page that loads the real package and lets anyone hear the filter
on their own microphone. This is the single best conversion asset for the
project — link it from the top of the npm page and the GitHub README.

## Run locally

```bash
cd web/demo
npm install
npm run dev          # builds the package first, then serves at http://localhost:5173
```

Open it, click **Enable microphone**, then either:

- toggle **Denoise ON/OFF** while monitoring on headphones, or
- hit **Record 5 seconds** and A/B the original vs denoised clips (no headphones
  needed — this is the share-friendly demo).

## Deploy (pick one — all free)

The demo is a static bundle (`npm run build` → `dist/`). Two gotchas:

- it must be served over **HTTPS or localhost** (getUserMedia requires a secure
  context), and
- it ships an ~18 MB `.wasm` — make sure your host doesn't strip large assets.

**GitHub Pages** (same repo, great for the README link):

```bash
cd web/demo
npm run build
npx gh-pages -d dist        # publishes dist/ to the gh-pages branch
# → https://rajan471.github.io/denoise-voice-clarity/
```

**Vercel:**

```bash
cd web/demo
npm run build
npx vercel deploy dist --prod
```

**Netlify:**

```bash
cd web/demo
npm run build
npx netlify deploy --dir=dist --prod
```

Once it's live, put the URL in:

- the GitHub repo **About → Website** field,
- the very top of `web/README.md` (a "▶ Live demo" link), and
- the npm `homepage` field in `web/package.json`.
