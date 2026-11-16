// Driver for the fast Markdown renderer (markdown-render-speed-02).
// The harness runs `node main.ts` with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// set (defaulting to /input and /output inside the grading container).
// It reads cases.json (one {id, markdown} per case) and writes html.json:
// one HTML string per case, in the same order.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Array<{
  id: string;
  markdown: string;
}>;

const html: string[] = new Array(cases.length);
for (let k = 0; k < cases.length; k++) {
  html[k] = parse(cases[k].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
