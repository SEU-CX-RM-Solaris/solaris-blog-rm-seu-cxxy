// Prefix internal absolute URLs in built HTML with the site's base path.
// GitHub Pages serves the site under /solaris-blog-rm-seu-cxxy/, but links
// hardcoded in components and markdown are root-relative. Astro rewrites its
// own generated asset URLs; this step covers the author-written ones so the
// built pages work both locally (astro preview) and on Pages.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));
const configSource = await readFile(
  fileURLToPath(new URL('../astro.config.ts', import.meta.url)),
  'utf8',
);
const base = (configSource.match(/base:\s*'([^']+)'/) ?? [])[1];
if (!base || base === '/' || !base.startsWith('/')) {
  throw new Error('apply-base-path: cannot read a non-root base from astro.config.ts.');
}

function needsBase(value) {
  return (
    value.startsWith('/') &&
    !value.startsWith('//') &&
    value !== base &&
    !value.startsWith(`${base}/`)
  );
}

function prefixSrcset(value) {
  return value
    .split(',')
    .map((candidate) => {
      const pieces = candidate.trim().split(/\s+/);
      if (!pieces[0]) return candidate;
      if (needsBase(pieces[0])) pieces[0] = `${base}${pieces[0]}`;
      return pieces.join(' ');
    })
    .join(', ');
}

let changedFiles = 0;
let changedUrls = 0;

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!entry.name.endsWith('.html')) continue;
    const original = await readFile(path, 'utf8');
    let updated = original.replace(/(srcset=")([^"]*)(")/g, (_m, open, value, close) => {
      return `${open}${prefixSrcset(value)}${close}`;
    });
    updated = updated.replace(
      /\b(href|src|poster|data-original-src)="(\/[^"]*)"/g,
      (match, attr, value) => {
        if (!needsBase(value)) return match;
        changedUrls += 1;
        return `${attr}="${base}${value}"`;
      },
    );
    if (updated !== original) {
      await writeFile(path, updated);
      changedFiles += 1;
    }
  }
}

await walk(distDir);
console.log(
  `apply-base-path: prefixed ${changedUrls} URL(s) with "${base}" across ${changedFiles} HTML file(s).`,
);
