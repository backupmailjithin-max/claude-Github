// Optional build step: creates app-compiled.min.js from app-compiled.js (needs `npm install terser` once, on any machine - not needed on the server).
// The server sends the .min.js under the normal /app-compiled.js URL ONLY when the stamp on its first line matches the current app-compiled.js,
// so a forgotten rebuild can never serve an outdated bundle (it falls back to the readable file and logs a warning).
// Usage:  node tools/build-min.js
const fs = require('fs'), path = require('path'), crypto = require('crypto');
let terser; try { terser = require('terser'); } catch (e) { try { terser = require(process.env.TERSER_PATH || 'terser'); } catch (e2) { console.error('terser is not installed: run  npm install terser  (or set TERSER_PATH)'); process.exit(1); } }
(async () => {
  const root = path.join(__dirname, '..'); const src = fs.readFileSync(path.join(root, 'app-compiled.js'), 'utf8');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'app-compiled.js'))).digest('hex').slice(0, 16);
  const out = await terser.minify(src, { compress: { passes: 1, drop_console: false }, mangle: true, format: { comments: false, ascii_only: false } });
  if (out.error) throw out.error;
  fs.writeFileSync(path.join(root, 'app-compiled.min.js'), `/*! src:${hash} */\n` + out.code);
  console.log(`app-compiled.min.js written: ${src.length} -> ${out.code.length} bytes (stamp src:${hash})`);
})().catch((e) => { console.error(e); process.exit(1); });
