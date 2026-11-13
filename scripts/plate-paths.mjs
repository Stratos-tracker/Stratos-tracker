// Inspect a chart PDF's vector paths offline.
// Usage: node scripts/plate-paths.mjs artifacts/kjfk-apd.pdf
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/plate-paths.mjs <file.pdf>');
  process.exit(1);
}

const pdfjs = await import('../app/vendor/pdfjs/pdf.min.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../app/vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
const doc = await pdfjs.getDocument({
  data: new Uint8Array(fs.readFileSync(file)),
  useWorkerFetch: false,
  isEvalSupported: false,
  disableFontFace: true,
}).promise;
const page = await doc.getPage(1);
const list = await page.getOperatorList();
const OPS = pdfjs.OPS;

let first = null;
let count = 0;
for (let i = 0; i < list.fnArray.length; i++) {
  if (list.fnArray[i] !== OPS.constructPath) continue;
  count++;
  if (!first) first = list.argsArray[i];
}
console.log('constructPath ops:', count, 'of', list.fnArray.length);
if (first) {
  console.log('argc:', first.length);
  first.forEach((a, idx) => {
    console.log('  arg', idx, 'ctype:', a && a.constructor && a.constructor.name, 'len:', a && a.length, 'sample:', String(a).slice(0, 80));
    if (a && typeof a === 'object' && a.length) {
      console.log('     head:', Array.from(a).slice(0, 12));
    }
  });
}
await doc.destroy();
