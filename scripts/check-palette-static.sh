#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmp_out=0
if [ -n "${1:-}" ]; then out="$1"; mkdir -p "$out"; else out="$(mktemp -d)"; tmp_out=1; fi
# The server exists only inside this script; EXIT cleans it up even on failed curl.
port="$(python3 - <<'PY'
import socket
with socket.socket() as s:
    s.bind(('127.0.0.1', 0))
    print(s.getsockname()[1])
PY
)"
python3 -m http.server "$port" --bind 127.0.0.1 --directory site >"$out/server-output.txt" 2>&1 &
pid=$!
cleanup() { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; if [ "$tmp_out" = 1 ]; then rm -rf "$out" 2>/dev/null || true; fi; }
trap cleanup EXIT
ready=0
for n in 1 2 3; do
  if curl --noproxy '*' -fsS "http://127.0.0.1:$port/" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.3
done
if [ "$ready" != 1 ]; then echo '本地服务未就绪（3 轮已停止）' >&2; exit 1; fi
{
  echo "Local loopback server ready (ephemeral port omitted)."
  for resource in '' index.html style.css favicon.svg example.png color-math.js image-input.js owned-colors.js white-balance.js vendor/spectral.js vendor/LICENSE-spectral.txt recipe.js worker.js palette.js wax-paper.js wax-render.js soft-smudge.js paper-studio.js paper-engine.js paper-pipeline.js paper-worker.js pick-loupe.js photo-view.js palette-ui.js app.js data/kuelox.json; do
    code="$(curl --noproxy '*' -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/$resource")"
    [ "$code" = 200 ]; echo "HTTP $code /$resource"
  done
  node - <<'NODE'
const fs = require('node:fs'), assert = require('node:assert/strict');
const html = fs.readFileSync('site/index.html', 'utf8'), css = fs.readFileSync('site/style.css', 'utf8');
assert.doesNotMatch(html, /(?:href|src)=["'](?:https?:)?\/\//);
assert.doesNotMatch(css, /@import|url\s*\(/i);
// The entry inherits visible/clickable button styling. Conservatively forbid
// selector-local visibility overrides instead of pretending the DOM adapter
// computes the browser's CSS cascade.
for (const [, declarations] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/#view-recipes\b[^{}]*\{([^{}]*)\}/g)) {
  assert.doesNotMatch(declarations, /(?:^|;)\s*(?:display|visibility|content-visibility|opacity|pointer-events)\s*:/i,
    'Recipe entry must inherit visible, clickable button styling');
}
assert.match(html, /connect-src 'self'/);
assert.match(html, /worker-src 'self'/);
assert.match(fs.readFileSync('site/paper-pipeline.js', 'utf8'), /new root\.Worker\('\.\/paper-worker\.js'\)/);
for (const worker of ['worker.js', 'paper-worker.js']) {
  const source = fs.readFileSync('site/' + worker, 'utf8');
  for (const call of source.matchAll(/importScripts\(([\s\S]*?)\)/g))
    for (const [, ref] of call[1].matchAll(/['"]([^'"]+)['"]/g)) {
      assert.match(ref, /^\.\//); assert(fs.existsSync('site/' + ref));
    }
}
const app = fs.readFileSync('site/app.js', 'utf8');
assert.deepEqual([...app.matchAll(/fetch\('([^']+)'/g)].map(v => v[1]).sort(), ['./data/kuelox.json', './example.png']);
for (const name of ['app.js', 'color-math.js', 'image-input.js', 'owned-colors.js', 'white-balance.js', 'recipe.js', 'palette.js', 'wax-paper.js', 'wax-render.js', 'soft-smudge.js', 'paper-studio.js', 'paper-engine.js', 'paper-pipeline.js', 'paper-worker.js', 'pick-loupe.js', 'photo-view.js', 'palette-ui.js', 'worker.js', 'vendor/spectral.js']) {
  const source = fs.readFileSync('site/' + name, 'utf8');
  assert.doesNotMatch(source, /XMLHttpRequest|WebSocket|sendBeacon|import\s*\(|importScripts\(['"](?:https?:)?\/\//);
  if (name !== 'app.js') assert.doesNotMatch(source, /fetch\s*\(/);
}
assert.equal(require(process.cwd() + '/site/data/kuelox.json').colors.length, 237);
console.log('Local-only audit PASS: all page references, fetches, worker imports; CSP self; color table 237.');
console.log('Recipe-entry CSS invariant PASS: no selector-local visibility or pointer overrides.');
NODE
  cleanup
  if curl --noproxy '*' -fsS --max-time 1 "http://127.0.0.1:$port/" >/dev/null 2>&1; then
    echo 'FAIL: service still reachable'; exit 1
  fi
  echo 'Temporary server stopped; curl confirms port is no longer reachable.'
} | tee "$out/static-check.txt"
