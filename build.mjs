// Builds the site into dist/ for GitHub Pages.
//   - Minifies script.js and styles.css with esbuild
//   - Gives them content-hashed names (script.3f9a1c2b7d.js) so browsers never use a stale copy
//   - Rewrites index.html to point at the hashed files
//   - Writes sw.js with this build's version and file list
//
// Run: npm run build

import { transform } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';

const OUT = 'dist';
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 10);

function replaceOnce(text, from, to, file) {
  if (!text.includes(from)) throw new Error(`build: "${from}" not found in ${file}`);
  return text.replace(from, to);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// Static folders are copied as-is (the font and Papa Parse are already compressed/minified)
await cp('fonts', `${OUT}/fonts`, { recursive: true });
await cp('vendor', `${OUT}/vendor`, { recursive: true });
for (const icon of ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png']) await cp(icon, `${OUT}/${icon}`);

// JS: no `target`, so modern syntax (??=, ?.) is kept as written
const js = (await transform(await readFile('script.js', 'utf8'), {
  loader: 'js',
  minify: true,
  legalComments: 'none',
})).code;

// CSS: no `target`, so nesting, @layer, light-dark() and @starting-style are left alone
const css = (await transform(await readFile('styles.css', 'utf8'), {
  loader: 'css',
  minify: true,
  legalComments: 'none',
})).code;

const jsName = `script.${hash(js)}.js`;
const cssName = `styles.${hash(css)}.css`;
await writeFile(`${OUT}/${jsName}`, js);
await writeFile(`${OUT}/${cssName}`, css);

// HTML: point at the hashed files and drop indentation
let html = await readFile('index.html', 'utf8');
html = replaceOnce(html, 'href="styles.css"', `href="${cssName}"`, 'index.html');
html = replaceOnce(html, 'src="script.js"', `src="${jsName}"`, 'index.html');
html = html.replace(/\n[ \t]+/g, '\n');
await writeFile(`${OUT}/index.html`, html);

// Service worker: stamped with a build version so each deploy gets a fresh cache
const precache = ['./', cssName, jsName, 'fonts/schibsted-grotesk.woff2'];
let sw = await readFile('sw.js', 'utf8');
sw = replaceOnce(sw, "'__VERSION__'", JSON.stringify(hash(html + js + css)), 'sw.js');
sw = replaceOnce(sw, '[/* __PRECACHE__ */]', JSON.stringify(precache), 'sw.js');
sw = (await transform(sw, { loader: 'js', minify: true, legalComments: 'none' })).code;
await writeFile(`${OUT}/sw.js`, sw);

// Size report
const kb = n => `${(n / 1024).toFixed(1)} KB`;
for (const [src, out] of [['script.js', jsName], ['styles.css', cssName], ['index.html', 'index.html']]) {
  const before = (await stat(src)).size;
  const after = (await stat(`${OUT}/${out}`)).size;
  console.log(`${src.padEnd(11)} ${kb(before).padStart(8)} -> ${kb(after).padStart(8)}  ${out}`);
}
