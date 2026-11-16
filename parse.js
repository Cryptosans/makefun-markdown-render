// parse.js — dependency-free CommonMark 0.31.2 + GFM 0.29 renderer.
// Returns exactly the HTML marked 18.1.3 renders with its default options (GFM on).
// Written from scratch for the make.fun markdown-render-speed-02 bounty.
// Single pass, no regexes in the hot inline loop beyond one scan regex.

export function parse(markdown) {
  // Line endings normalized; tabs are NOT expanded globally: they are handled
  // per line during parsing (a tab advances to the next multiple of 4 columns,
  // and code content keeps its tabs, as marked does).
  const src = markdown.replace(/\r\n?/g, '\n');
  const refs = new Map();
  const lines = src.split('\n');
  // The '' after a final newline is not a line; drop it (else fenced code and
  // other blocks gain a phantom trailing blank line).
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const doc = parseBlocks(lines, refs);
  // An HTML block renders its raw text with NO trailing newline added;
  // only the document's last block, when the source ends with '\n', gets one.
  if (src.endsWith('\n') && doc.blocks.length) {
    const last = doc.blocks[doc.blocks.length - 1];
    if (last.t === 'html') last.addTrailingNL = true;
  }
  return renderBlocks(doc.blocks, refs);
}

// ---------------- HTML escaping / URLs / entities ----------------

function escapeText(s) {
  // marked's escape: & < > " ' (used for text, code and attributes alike).
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { out += s.slice(start, i) + '&amp;'; start = i + 1; }
    else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

const escapeAttr = escapeText;

const UNESCAPE_RE = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g;
function unescapePunct(s) { return s.replace(UNESCAPE_RE, '$1'); }

// Escape &, <, >, ", ' — but pass valid entity references through unchanged
// (&name; &#123; &#xAB;). Used for link destinations/titles, image alt text and
// fenced-code info strings, where marked keeps entities as-is.
const ENTITY_REF_RE = /^&(?:#[xX][0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z0-9]+);/;
function escapeEntityAware(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      if (ENTITY_REF_RE.test(s.slice(i, i + 34))) continue;
      out += s.slice(start, i) + '&amp;'; start = i + 1;
    }
    else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// marked encodes link destinations with encodeURI, then HTML-escapes the attribute.
function encodeHref(dest) {
  let u;
  try { u = encodeURI(dest).replace(/%25/g, '%'); } catch (e) { u = dest; }
  return escapeEntityAware(u);
}

const NAMED_ENTITY_RE = /^&([A-Za-z0-9]+);/;
const NUM_ENTITY_RE = /^&#([xX][0-9a-fA-F]{1,6}|[0-9]{1,7});/;

// Decode one entity at s[i] === '&'. Returns {html, len, kind} or null.
// kind 'num': the decoded character (rendered as text, so it is escaped if special).
// kind 'named': passed through unchanged, as marked does.
function entityAt(s, i) {
  const rest = s.slice(i, i + 40);
  let m = NUM_ENTITY_RE.exec(rest);
  if (m) {
    const body = m[1];
    let cp;
    if (body[0] === 'x' || body[0] === 'X') cp = parseInt(body.slice(1), 16);
    else cp = parseInt(body, 10);
    if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
    return { html: String.fromCodePoint(cp), len: m[0].length, kind: 'num' };
  }
  m = NAMED_ENTITY_RE.exec(rest);
  if (m) {
    // marked passes named entity references through unchanged.
    return { html: m[0], len: m[0].length, kind: 'named' };
  }
  return null;
}

const UNICODE_PUNCT_RE = /^[\p{P}\p{S}]$/u;
function isPunct(ch) {
  // ASCII punctuation (CommonMark), plus Unicode punctuation/symbols for
  // flanking (marked uses \p{P} and \p{S}). ch is a one-character string.
  const c = ch.charCodeAt(0);
  if (c < 128) {
    return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
      (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
  }
  return UNICODE_PUNCT_RE.test(ch);
}
function isSpace(ch) {
  if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') return true;
  const c = ch.charCodeAt(0);
  // Unicode whitespace (nbsp, en/em spaces, line/paragraph separators, ...).
  return c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) ||
    c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
}
function isAlnum(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9');
}

// Normalize a link label: collapse whitespace and case-fold. Backslash escapes
// are NOT resolved here: marked keeps them, so a label written [foo\!] does
// not match [foo!]. (The sharp-s / final-sigma folds are the only specials.)
function normalizeLabel(label) {
  return label.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

// ---------------- Inline parsing ----------------

// Node types: {t:'text',s} {t:'code',s} {t:'delim',ch,n,canOpen,canClose}
// {t:'link',href,title,children} {t:'img',src,alt,title} {t:'html',s} {t:'br'} {t:'em'|'strong'|'del',children}

const INLINE_RE = /\\|`|\*|_|\[|!|<|&|~|\n|@|www\.|https?:\/\/|ftp:\/\/|mailto:|xmpp:/g;

function renderInline(s, refs) {
  const nodes = tokenizeInline(s, refs);
  resolveEmphasis(nodes);
  return renderNodes(nodes);
}

function renderNodes(nodes) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text': out += n.s; break;
      case 'code': out += '<code>' + escapeText(n.s) + '</code>'; break;
      case 'html': out += n.s; break;
      case 'br': out += '<br>'; break;
      case 'delim': out += escapeText(n.ch.repeat(n.n)); break;
      case 'em': out += '<em>' + renderNodes(n.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderNodes(n.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderNodes(n.children) + '</del>'; break;
      case 'link': {
        out += '<a href="' + encodeHref(n.href) + '"';
        if (n.title != null) out += ' title="' + escapeEntityAware(n.title) + '"';
        out += '>' + renderNodes(n.children) + '</a>';
        break;
      }
      case 'img': {
        out += '<img src="' + encodeHref(n.src) + '" alt="' + escapeEntityAware(n.alt) + '"';
        if (n.title != null) out += ' title="' + escapeEntityAware(n.title) + '"';
        out += '>';
        break;
      }
    }
  }
  return out;
}

// Plain-text run: HTML-escape it (autolinks are tokenized by the main regex).
function pushText(nodes, s) {
  if (!s) return;
  const last = nodes[nodes.length - 1];
  if (last && last.t === 'text') last.s += escapeText(s);
  else nodes.push({ t: 'text', s: escapeText(s) });
}

// Find the index of the ']' matching the '[' at `open` (depth-aware, skips \x and code spans).
function findClosingBracket(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') {
      let j = i;
      while (j < s.length && s[j] === '`') j++;
      const run = j - i;
      let k = j;
      while (k < s.length) {
        if (s[k] === '`') {
          let e = k;
          while (e < s.length && s[e] === '`') e++;
          if (e - k === run) { i = e - 1; break; }
          k = e;
        } else k++;
      }
      if (k >= s.length) return -1;
      continue;
    }
    if (c === '<') {
      const h = htmlInlineAt(s, i) || autolinkAt(s, i);
      if (h) { i = h.end - 1; continue; }
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Parse an inline link destination + optional title starting at s[i] === '('.
// Returns {href, title, end} (end = index past ')') or null.
function parseInlineLink(s, i) {
  let p = i + 1;
  while (p < s.length && (s[p] === ' ' || s[p] === '\n')) p++;
  if (p >= s.length) return null;
  let href = '';
  if (s[p] === '<') {
    let close = -1;
    for (let q = p + 1; q < s.length; q++) {
      if (s[q] === '\\') { q++; continue; }
      if (s[q] === '>') { close = q; break; }
    }
    if (close === -1) return null;
    const inner = s.slice(p + 1, close);
    if (inner.indexOf('<') !== -1 || inner.indexOf('\n') !== -1) return null;
    href = inner.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    p = close + 1;
  } else {
    // Bare destination: no spaces/control chars; balanced parens allowed.
    let depth = 0;
    const start = p;
    while (p < s.length) {
      const c = s[p];
      if (c === '\\' && p + 1 < s.length && isPunct(s[p + 1])) { p += 2; continue; }
      if (c === ' ' || c === '\n' || c.charCodeAt(0) < 32) break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      p++;
    }
    if (p === start) {
      // Empty destination: "[link]()" is a link with an empty href.
      href = '';
    } else {
      href = s.slice(start, p).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    }
  }
  while (p < s.length && (s[p] === ' ' || s[p] === '\n')) p++;
  let title = null;
  if (p < s.length && s[p] !== ')') {
    const q = s[p];
    if (q === '"' || q === "'") {
      let close = -1;
      for (let j = p + 1; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === q) { close = j; break; }
      }
      if (close === -1) return null;
      title = unescapePunct(s.slice(p + 1, close));
      p = close + 1;
    } else if (q === '(') {
      let depth = 1;
      let j = p + 1;
      while (j < s.length && depth > 0) {
        if (s[j] === '\\' && j + 1 < s.length) { j += 2; continue; }
        if (s[j] === '(') depth++;
        else if (s[j] === ')') depth--;
        j++;
      }
      if (depth !== 0) return null;
      title = unescapePunct(s.slice(p + 1, j - 1));
      p = j;
    } else return null;
    while (p < s.length && (s[p] === ' ' || s[p] === '\n')) p++;
  }
  if (p >= s.length || s[p] !== ')') return null;
  return { href, title, end: p + 1 };
}

// Does this inline-node list contain a link (recursively)? A link's text may
// not contain another link — if it does, the outer link is not formed.
function hasLink(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'link') return true;
    if (nd.children && hasLink(nd.children)) return true;
  }
  return false;
}

// Try to build a link/image node for '[' at `open` (or '![' with isImage).
// Returns {node, end} or null.
function tryLink(s, open, refs, isImage) {
  const close = findClosingBracket(s, open);
  if (close === -1) return null;
  const text = s.slice(open + 1, close);
  let p = close + 1;
  let href = null, title = null;
  if (p < s.length && s[p] === '(') {
    const r = parseInlineLink(s, p);
    if (r) { href = r.href; title = r.title; p = r.end; }
    else {
      // Not a valid inline link: fall back to a reference link for the text,
      // with the "(...)" left as literal text after it.
      const ref = refs.get(normalizeLabel(text));
      if (!ref) return null;
      href = ref.href; title = ref.title;
    }
  } else if (p < s.length && s[p] === '[') {
    const end = s.indexOf(']', p + 1);
    if (end === -1) return null;
    const label = end === p + 1 ? text : s.slice(p + 1, end);
    // A reference label may not contain an unescaped '['.
    if (label.indexOf('[') !== -1) return null;
    const ref = refs.get(normalizeLabel(label));
    if (!ref) return null;
    href = ref.href; title = ref.title; p = end + 1;
  } else {
    const ref = refs.get(normalizeLabel(text));
    if (!ref) return null;
    href = ref.href; title = ref.title;
  }
  if (isImage) {
    return { node: { t: 'img', src: href, alt: plainTextOf(renderInline(text, refs)), title }, end: p };
  }
  const children = tokenizeInline(text, refs);
  resolveEmphasis(children);
  if (hasLink(children)) return null;
  return { node: { t: 'link', href, title, children }, end: p };
}

// Plain text of already-rendered inline nodes (for img alt: strip markup, unescape).
function plainTextOf(html) {
  return html.replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

// GFM autolink URL end: scan from `start`, stop at whitespace or '<'.
// Returns the raw URL (before trailing-punctuation trimming).
function scanBareUrl(s, start) {
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '<') break;
    i++;
  }
  return s.slice(start, i);
}

// GFM backpedal: drop trailing punctuation, unbalanced ')' and a trailing
// entity reference (&name;) from a bare URL. Applied until stable.
const BACKPEDAL_RE = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![A-Za-z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function trimAutolink(url) {
  let cur = url, prev;
  do {
    prev = cur;
    const m = BACKPEDAL_RE.exec(cur);
    cur = m ? m[0] : '';
  } while (cur !== prev);
  return cur;
}

// GFM bare-email pattern: narrow local part, domain labels may contain - and _,
// at least one dot, and the domain must not be followed by a word char or '-'.
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![\w-])/;
const EMAIL_LOCAL_CH = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-";

// HTML tag / comment / PI / declaration / CDATA at s[i] === '<'. Returns {html, end} or null.
function htmlInlineAt(s, i) {
  const rest = s.slice(i, i + 12);
  if (rest.startsWith('<!--')) {
    const e = s.indexOf('-->', i + 4);
    if (e === -1) return null;
    return { html: s.slice(i, e + 3), end: e + 3 };
  }
  if (rest.startsWith('<?')) {
    const e = s.indexOf('?>', i + 2);
    if (e === -1) return null;
    return { html: s.slice(i, e + 2), end: e + 2 };
  }
  if (rest.startsWith('<!')) {
    if (rest[2] === '[' && rest.slice(2, 9).toUpperCase() === '[CDATA[') {
      const e = s.indexOf(']]>', i + 9);
      if (e === -1) return null;
      return { html: s.slice(i, e + 3), end: e + 3 };
    }
    if (rest[2] && /[A-Za-z]/.test(rest[2])) {
      const e = s.indexOf('>', i + 2);
      if (e === -1) return null;
      return { html: s.slice(i, e + 1), end: e + 1 };
    }
    return null;
  }
  const m = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/.exec(s.slice(i, i + 200));
  if (m) return { html: m[0], end: i + m[0].length };
  return null;
}

// Autolink <scheme:...> or <email> at s[i] === '<'. Returns {node, end} or null.
function autolinkAt(s, i) {
  const m = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/.exec(s.slice(i, i + 200));
  if (m) {
    const url = m[1];
    return { node: { t: 'link', href: url, title: null, children: [{ t: 'text', s: escapeText(url) }] }, end: i + m[0].length };
  }
  const e = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/.exec(s.slice(i, i + 200));
  if (e) {
    const addr = e[1];
    return { node: { t: 'link', href: 'mailto:' + addr, title: null, children: [{ t: 'text', s: escapeText(addr) }] }, end: i + e[0].length };
  }
  return null;
}

// ---------------- Inline tokenizer ----------------

const EMAIL_LOCAL = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-';
const WWW_PREV_BAD = '.-/';

// Is the '_' at `pos` part of a bare-email local part? If so it must stay plain
// text (it would otherwise be consumed as an emphasis delimiter before the
// '@' is reached, and the email would be cut short).
function underscoreInEmail(s, pos) {
  let j = pos;
  while (j < s.length && EMAIL_LOCAL.indexOf(s[j]) !== -1) j++;
  if (j >= s.length || s[j] !== '@') return false;
  let ls = j;
  while (ls > 0 && EMAIL_LOCAL.indexOf(s[ls - 1]) !== -1) ls--;
  if (ls > pos) return false;
  return EMAIL_RE.test(s.slice(ls, ls + 200));
}
const WWW_DOMAIN_RE = /^www\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/;

function flanking(s, pos, len) {
  const before = pos > 0 ? s[pos - 1] : '\n';
  const after = pos + len < s.length ? s[pos + len] : '\n';
  const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
  const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
  return { left, right, before, after };
}

function tokenizeInline(s, refs) {
  const nodes = [];
  const n = s.length;
  let i = 0;
  let rawStart = 0; // pending plain text is s.slice(rawStart, i)
  const flush = (upto) => {
    if (upto > rawStart) pushText(nodes, s.slice(rawStart, upto));
    rawStart = upto;
  };
  INLINE_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_RE.exec(s)) !== null) {
    const pos = m.index;
    const tok = m[0];
    const c = tok[0];
    if (c === '\\') {
      flush(pos);
      const nx = s[pos + 1];
      if (nx === '\n') {
        nodes.push({ t: 'br' });
        i = pos + 2;
        // After a hard break, the next line's leading whitespace is dropped.
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
      }
      else if (nx !== undefined && isPunct(nx)) { pushText(nodes, nx); i = pos + 2; }
      else { pushText(nodes, '\\'); i = pos + 1; }
      rawStart = i; INLINE_RE.lastIndex = i; continue;
    }
    if (c === '`') {
      flush(pos);
      let j = pos;
      while (j < n && s[j] === '`') j++;
      const run = j - pos;
      // Find a closing run of exactly `run` backticks.
      let k = j, closeStart = -1;
      while (k < n) {
        if (s[k] === '`') {
          let e = k;
          while (e < n && s[e] === '`') e++;
          if (e - k === run) { closeStart = k; break; }
          k = e;
        } else k++;
      }
      if (closeStart === -1) { pushText(nodes, '`'.repeat(run)); i = j; }
      else {
        let content = s.slice(j, closeStart);
        content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        nodes.push({ t: 'code', s: content });
        i = closeStart + run;
      }
      rawStart = i; INLINE_RE.lastIndex = i; continue;
    }
    if (c === '*' || c === '_') {
      if (c === '_' && underscoreInEmail(s, pos)) {
        // Part of a bare-email local part: leave it in the pending raw text.
        i = pos + 1; INLINE_RE.lastIndex = i; continue;
      }
      flush(pos);
      let j = pos;
      while (j < n && s[j] === c) j++;
      const run = j - pos;
      const fl = flanking(s, pos, run);
      let canOpen, canClose;
      if (c === '*') { canOpen = fl.left; canClose = fl.right; }
      else {
        canOpen = fl.left && (!fl.right || isPunct(fl.before));
        canClose = fl.right && (!fl.left || isPunct(fl.after));
      }
      nodes.push({ t: 'delim', ch: c, n: run, canOpen, canClose });
      i = j; rawStart = i; INLINE_RE.lastIndex = i; continue;
    }
    if (c === '~') {
      flush(pos);
      let j = pos;
      while (j < n && s[j] === '~') j++;
      const run = j - pos;
      // Strikethrough delimiters are runs of 1 or 2 tildes; 3+ are literal text.
      if (run <= 2) {
        const fl = flanking(s, pos, run);
        nodes.push({ t: 'delim', ch: '~', n: run, canOpen: fl.left, canClose: fl.right });
      } else pushText(nodes, '~'.repeat(run));
      i = j; rawStart = i; INLINE_RE.lastIndex = i; continue;
    }
    if (c === '[') {
      flush(pos);
      const r = tryLink(s, pos, refs, false);
      if (r) { nodes.push(r.node); i = r.end; }
      else { pushText(nodes, '['); i = pos + 1; }
      rawStart = i; INLINE_RE.lastIndex = i; continue;
    }
    if (c === '!') {
      flush(pos);
      if (s[pos + 1] === '[') {
        const r = tryLink(s, pos + 1, refs, true);
        if (r) { nodes.push(r.node); i = r.end; rawStart = i; INLINE_RE.lastIndex = i; continue; }
      }
      pushText(nodes, '!'); i = pos + 1; rawStart = i; INLINE_RE.lastIndex = i; continue;
    }
    if (c === '<') {
      flush(pos);
      const a = autolinkAt(s, pos);
      if (a) { nodes.push(a.node); i = a.end; rawStart = i; INLINE_RE.lastIndex = i; continue; }
      const h = htmlInlineAt(s, pos);
      if (h) { nodes.push({ t: 'html', s: h.html }); i = h.end; rawStart = i; INLINE_RE.lastIndex = i; continue; }
      pushText(nodes, '<'); i = pos + 1; rawStart = i; INLINE_RE.lastIndex = i; continue;
    }
    if (c === '&') {
      flush(pos);
      const e = entityAt(s, pos);
      if (e) {
        // Numeric entity: decoded char as text (escaped if it is & < > " ').
        // Named entity: passed through unchanged.
        if (e.kind === 'num') pushText(nodes, e.html);
        else nodes.push({ t: 'html', s: e.html });
        i = pos + e.len;
      }
      else { pushText(nodes, '&'); i = pos + 1; }
      rawStart = i; INLINE_RE.lastIndex = i; continue;
    }
    if (c === '\n') {
      // Hard break if the pending text ends with 2+ spaces.
      let end = pos;
      while (end > rawStart && s[end - 1] === ' ') end--;
      if (pos - end >= 2) {
        flush(end); nodes.push({ t: 'br' });
        i = pos + 1;
        // After a hard break, the next line's leading whitespace is dropped.
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
      }
      else { flush(pos); nodes.push({ t: 'text', s: '\n' }); i = pos + 1; }
      rawStart = i; INLINE_RE.lastIndex = i; continue;
    }
    if (c === '@') {
      // Bare email: local part is the trailing run of EMAIL_LOCAL in the pending raw text.
      let ls = pos;
      while (ls > rawStart && EMAIL_LOCAL.indexOf(s[ls - 1]) !== -1) ls--;
      if (ls < pos) {
        const em = EMAIL_RE.exec(s.slice(ls, ls + 200));
        if (em) {
          flush(ls);
          const addr = em[0];
          nodes.push({ t: 'link', href: 'mailto:' + addr, title: null, children: [{ t: 'text', s: escapeText(addr) }] });
          i = ls + addr.length; rawStart = i; INLINE_RE.lastIndex = i; continue;
        }
      }
      i = pos + 1; INLINE_RE.lastIndex = i; continue;
    }
    if (tok === 'www.') {
      const prev = pos > 0 ? s[pos - 1] : '';
      const okPrev = prev === '' || isSpace(prev) || (isPunct(prev) && WWW_PREV_BAD.indexOf(prev) === -1);
      if (okPrev) {
        const raw = scanBareUrl(s, pos);
        const url = trimAutolink(raw);
        if (url.length > 4 && WWW_DOMAIN_RE.test(url)) {
          flush(pos);
          nodes.push({ t: 'link', href: 'http://' + url, title: null, children: [{ t: 'text', s: escapeText(url) }] });
          i = pos + url.length; rawStart = i; INLINE_RE.lastIndex = i; continue;
        }
      }
      i = pos + 4; INLINE_RE.lastIndex = i; continue;
    }
    if (tok === 'mailto:' || tok === 'xmpp:') {
      // GFM scheme autolink: mailto:email or xmpp:email[/one-segment-path].
      // Must not start inside a word.
      const prev = pos > 0 ? s[pos - 1] : '';
      if (prev === '' || !isAlnum(prev)) {
        const em = EMAIL_RE.exec(s.slice(pos + tok.length, pos + tok.length + 200));
        if (em) {
          let url = tok + em[0];
          let end = pos + tok.length + em[0].length;
          if (tok === 'xmpp:' && s[end] === '/') {
            const pm = /^[A-Za-z0-9@.]+/.exec(s.slice(end + 1, end + 200));
            if (pm) { url += '/' + pm[0]; end += 1 + pm[0].length; }
          }
          url = trimAutolink(url);
          end = pos + url.length;
          flush(pos);
          nodes.push({ t: 'link', href: url, title: null, children: [{ t: 'text', s: escapeText(url) }] });
          i = end; rawStart = i; INLINE_RE.lastIndex = i; continue;
        }
      }
      i = pos + tok.length; INLINE_RE.lastIndex = i; continue;
    }
    if (tok === 'http://' || tok === 'https://' || tok === 'ftp://') {
      const raw = scanBareUrl(s, pos);
      const url = trimAutolink(raw);
      if (url.length > tok.length && /[A-Za-z0-9]/.test(url[tok.length])) {
        flush(pos);
        nodes.push({ t: 'link', href: url, title: null, children: [{ t: 'text', s: escapeText(url) }] });
        i = pos + url.length; rawStart = i; INLINE_RE.lastIndex = i; continue;
      }
      i = pos + tok.length; INLINE_RE.lastIndex = i; continue;
    }
    // Unreachable for current regex, but keep the scanner moving.
    i = pos + 1; INLINE_RE.lastIndex = i;
  }
  flush(n);
  return nodes;
}

// ---------------- Emphasis / strikethrough resolution ----------------

function resolveEmphasis(nodes) {
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    if (node.t === 'delim' && node.canClose && node.n > 0) {
      let openerIdx = -1;
      for (let j = i - 1; j >= 0; j--) {
        const o = nodes[j];
        if (o.t !== 'delim' || o.ch !== node.ch || o.n === 0) continue;
        if (!o.canOpen) continue;
        const oddMatch = (o.canClose || node.canOpen) && (o.n % 3 !== 0) && ((o.n + node.n) % 3 === 0);
        if (oddMatch) continue;
        openerIdx = j;
        break;
      }
      if (openerIdx !== -1) {
        const opener = nodes[openerIdx];
        const use = (opener.n >= 2 && node.n >= 2 ? 2 : 1);
        const type = node.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
        const children = nodes.slice(openerIdx + 1, i);
        const wrapper = { t: type, children };
        opener.n -= use;
        node.n -= use;
        const rep = [];
        if (opener.n > 0) rep.push({ t: 'delim', ch: opener.ch, n: opener.n, canOpen: opener.canOpen, canClose: opener.canClose });
        rep.push(wrapper);
        if (node.n > 0) rep.push({ t: 'delim', ch: node.ch, n: node.n, canOpen: node.canOpen, canClose: node.canClose });
        nodes.splice(openerIdx, i - openerIdx + 1, ...rep);
        i = openerIdx;
        continue;
      }
    }
    i++;
  }
}

// ---------------- Block parsing ----------------

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HR_RE = /^ {0,3}([*_-])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const LIST_RE = /^ {0,3}([*+-]|\d{1,9}[.)])(?:([ \t]+)(.*)|[ \t]*$)/;
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_START_1 = new RegExp(`^ {0,3}<(pre|script|style|textarea)(?:[ \\t>]|\\/>|$)`, 'i');
const HTML_START_6 = new RegExp(`^ {0,3}<\\/?(?:${BLOCK_TAGS})(?:[ \\t>]|\\/>|$)`, 'i');
const HTML_START_7 = /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>[ \t]*$/;

// Split a line's leading whitespace: cols is the visual indent (a tab advances
// to the next multiple of 4), rest is the line with that whitespace removed.
function splitLeading(line) {
  let col = 0, i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col = (Math.floor(col / 4) + 1) * 4; i++; }
    else break;
  }
  return { cols: col, rest: line.slice(i), index: i };
}
function lineIndent(line) { return splitLeading(line).cols; }
// Remove n columns of leading indentation (a straddled tab leaves spaces behind).
// `startCol` is the absolute column the string starts at (tab widths depend on it).
// When n is not a multiple of 4 and the line has tabs, the tabs are first expanded
// to spaces at their absolute columns — otherwise a tab after the strip point
// would be re-measured from the wrong column and the indent would be wrong.
function stripColumns(line, n, startCol = 0) {
  if (n % 4 !== 0 && line.indexOf('\t') !== -1) {
    let out = '', col = startCol;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '\t') { const next = (Math.floor(col / 4) + 1) * 4; out += ' '.repeat(next - col); col = next; }
      else { out += c; col++; }
    }
    return out.slice(n);
  }
  let col = startCol, i = 0;
  const target = startCol + n;
  while (i < line.length && col < target) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const next = (Math.floor(col / 4) + 1) * 4;
      if (next > target) return ' '.repeat(next - target) + line.slice(i + 1);
      col = next; i++;
    } else break;
  }
  return line.slice(i);
}
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// HTML block start condition at a line (indent already ≤ 3 checked by caller).
// Returns 0 (none) or the type 1..7.
function htmlBlockStart(line) {
  if (HTML_START_1.test(line)) return 1;
  if (line.slice(0, 7).toLowerCase().includes('<!--') && /^ {0,3}<!--/.test(line)) return 2;
  if (/^ {0,3}<\?/.test(line)) return 3;
  if (/^ {0,3}<![A-Za-z]/.test(line)) return 4;
  if (/^ {0,3}<!\[CDATA\[/.test(line)) return 5;
  if (HTML_START_6.test(line)) return 6;
  if (HTML_START_7.test(line)) return 7;
  return 0;
}

// Would this line start a new block construct (used for lazy-continuation decisions)?
function startsBlock(line) {
  const { cols: ind, rest: content } = splitLeading(line);
  if (ind > 3) return false;
  if (content === '') return false;
  if (content[0] === '#' && /^#{1,6}(?:[ \t]+|[ \t]*$)/.test(content)) return true;
  if (content[0] === '`' || content[0] === '~') {
    const m = /^(`{3,}|~{3,})/.exec(content);
    if (m) {
      if (m[1][0] === '`' && content.slice(m[1].length).includes('`')) return false;
      return true;
    }
  }
  if (content[0] === '>') return true;
  if (content[0] === '<' && htmlBlockStart(line) > 0) return true;
  if (HR_RE.test(line)) return true;
  if (SETEXT_RE.test(line)) return true;
  if (LIST_RE.test(line)) return true;
  return false;
}

// Parse a link reference definition starting at lines[i]. Returns {label, href, title, used}
// (used = 1 or 2 lines) or null.
function parseRefDef(lines, i, refs) {
  const line = lines[i];
  const m = /^ {0,3}\[((?:\\.|[^\]])+)\]:[ \t]*(.*)$/.exec(line);
  if (!m) return null;
  const label = m[1];
  let rest = m[2];
  let used = 1;
  let href = null;
  let title = null;
  const takeTitle = (t) => {
    const s = t.trim();
    if (s.length >= 2) {
      if (s[0] === '"' && s[s.length - 1] === '"') return unescapePunct(s.slice(1, -1));
      if (s[0] === "'" && s[s.length - 1] === "'") return unescapePunct(s.slice(1, -1));
      if (s[0] === '(' && s[s.length - 1] === ')') return unescapePunct(s.slice(1, -1));
    }
    return undefined;
  };
  // Destination.
  rest = rest.replace(/^[ \t]+/, '');
  if (rest === '') return null; // no destination on this line -> not a def (title may not precede dest)
  if (rest[0] === '<') {
    let close = -1;
    for (let q = 1; q < rest.length; q++) {
      if (rest[q] === '\\') { q++; continue; }
      if (rest[q] === '>') { close = q; break; }
    }
    if (close === -1) return null;
    const inner = rest.slice(1, close);
    if (inner.includes('<') || inner.includes('\n')) return null;
    href = inner.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    rest = rest.slice(close + 1);
    // The destination and a following title must be separated by whitespace.
    if (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') return null;
  } else {
    let depth = 0, p = 0;
    while (p < rest.length) {
      const c = rest[p];
      if (c === '\\' && p + 1 < rest.length && isPunct(rest[p + 1])) { p += 2; continue; }
      if (c === ' ' || c === '\t' || c.charCodeAt(0) < 32) break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      p++;
    }
    if (p === 0) return null;
    href = rest.slice(0, p).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    rest = rest.slice(p);
  }
  rest = rest.replace(/^[ \t]+/, '');
  if (rest === '') {
    // Title may be on the next line.
    if (i + 1 < lines.length) {
      const t = takeTitle(lines[i + 1]);
      if (t !== undefined) { title = t; used = 2; }
    }
  } else {
    const t = takeTitle(rest);
    if (t === undefined) return null;
    title = t;
  }
  const key = normalizeLabel(label);
  if (key === '') return null;
  if (!refs.has(key)) refs.set(key, { href, title });
  return { label, href, title, used };
}

// Split a table row on unescaped pipes (outer pipes dropped).
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}
function isTableDelim(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const m = /^(:?)-+(:?)$/.exec(cell.trim());
    if (!m) return null;
    aligns.push(m[1] && m[2] ? 'center' : m[1] ? 'left' : m[2] ? 'right' : null);
  }
  return aligns;
}

// Finalize a paragraph's lines: strip leading ref defs; detect a table; else paragraph node.
// Returns a block node or null.
function finalizeParagraph(paraLines, refs) {
  let lines = paraLines;
  let i = 0;
  while (i < lines.length) {
    const d = parseRefDef(lines, i, refs);
    if (!d) break;
    i += d.used;
  }
  lines = lines.slice(i);
  if (lines.length === 0) return null;
  if (lines.length >= 2 && lineIndent(lines[1]) <= 3) {
    const aligns = isTableDelim(lines[1]);
    if (aligns !== null) {
      const header = splitTableRow(lines[0]);
      // The delimiter row must have exactly as many cells as the header row.
      if (aligns.length === header.length) {
        const ncol = aligns.length;
        const rows = [];
        for (let r = 2; r < lines.length; r++) {
          const cells = splitTableRow(lines[r]);
          while (cells.length < ncol) cells.push('');
          rows.push(cells.slice(0, ncol));
        }
        while (header.length < ncol) header.push('');
        return { t: 'table', header: header.slice(0, ncol), aligns, rows };
      }
    }
  }
  return { t: 'paragraph', lines };
}

// Parse a list marker at the start of `line` (indent already counted).
// Returns null or {bullet, delim, num, contentIndent, contentStart, empty}.
function parseMarker(line) {
  const { cols: ind, rest, index: base } = splitLeading(line);
  if (ind > 3) return null;
  const m = /^([*+-]|\d{1,9}[.)])(?:([ \t]+)(.*)|[ \t]*$)/.exec(rest);
  if (!m) return null;
  const marker = m[1];
  const bullet = (marker === '*' || marker === '+' || marker === '-') ? marker : null;
  const delim = bullet ? null : marker[marker.length - 1];
  const num = bullet ? null : parseInt(marker.slice(0, -1), 10);
  const markerEndCol = ind + marker.length;
  const markerEndChar = base + marker.length;
  // Column width of the whitespace run after the marker.
  let spacesCols = 0, col = markerEndCol;
  if (m[2]) {
    for (const ch of m[2]) {
      if (ch === ' ') { spacesCols++; col++; }
      else { const nx = (Math.floor(col / 4) + 1) * 4; spacesCols += nx - col; col = nx; }
    }
  }
  const hasContent = m[3] !== undefined && m[3] !== '';
  let contentIndent, firstContent;
  if (!hasContent) {
    contentIndent = markerEndCol + 1;
    firstContent = '';
  } else if (spacesCols >= 5) {
    contentIndent = markerEndCol + 1;
    firstContent = stripColumns(line.slice(markerEndChar), 1, markerEndCol);
  } else {
    contentIndent = markerEndCol + spacesCols;
    firstContent = m[3];
  }
  return { bullet, delim, num, contentIndent, firstContent, empty: !hasContent };
}

function makeHeading(atx) {
  const level = atx[1].length;
  let text = atx[2] !== undefined ? atx[2] : '';
  text = text.replace(/[ \t]+$/, '');
  const m = /[ \t]+#+$/.exec(text);
  if (m) text = text.slice(0, m.index);
  else if (/^#+$/.test(text)) text = '';
  return { t: 'heading', level, lines: [text] };
}

function readFence(lines, i, end, fm, blocks) {
  const fence = fm[1];
  const ch = fence[0];
  const len = fence.length;
  const info = unescapePunct(fm[2].trim());
  // The opening fence's indent is stripped from every content line.
  const { cols: ind0 } = splitLeading(lines[i]);
  const content = [];
  let j = i + 1;
  while (j < end) {
    const l = lines[j];
    const { cols: ind, rest } = splitLeading(l);
    if (ind <= 3) {
      const cm = /^(`{3,}|~{3,})[ \t]*$/.exec(rest);
      if (cm && cm[1][0] === ch && cm[1].length >= len) break;
    }
    content.push(ind0 > 0 ? stripColumns(l, ind0) : l);
    j++;
  }
  blocks.push({ t: 'fence', info, lines: content });
  return j < end ? j + 1 : end;
}

function readIndentedCode(lines, i, end, blocks) {
  const content = [];
  let j = i;
  while (j < end) {
    const l = lines[j];
    if (isBlank(l)) {
      let k = j + 1;
      while (k < end && isBlank(lines[k])) k++;
      if (k < end && lineIndent(lines[k]) >= 4) {
        while (j < k) { content.push(stripColumns(lines[j], 4)); j++; }
        continue;
      }
      break;
    }
    if (lineIndent(l) >= 4) { content.push(stripColumns(l, 4)); j++; continue; }
    break;
  }
  while (content.length && isBlank(content[content.length - 1])) content.pop();
  blocks.push({ t: 'code', lines: content });
  return j;
}

function readHtml(lines, i, end, type, blocks) {
  const content = [lines[i]];
  const enders = { 2: '-->', 3: '?>', 5: ']]>' };
  if (type >= 2 && type <= 5) {
    const term = type === 4 ? '>' : enders[type];
    if (lines[i].includes(term)) {
      blocks.push({ t: 'html', lines: content });
      return i + 1;
    }
  }
  // Type 1 blocks (pre/script/style/textarea) end at the matching end tag,
  // not at a blank line; an unclosed one runs to EOF.
  if (type === 1) {
    const tm = /<([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/i.exec(lines[i]);
    if (tm) {
      const endTag = '</' + tm[1].toLowerCase() + '>';
      const rest = lines[i].slice(lines[i].indexOf('>') + 1);
      if (rest.toLowerCase().includes(endTag)) {
        blocks.push({ t: 'html', lines: content });
        return i + 1;
      }
      let j = i + 1;
      while (j < end) {
        const l = lines[j];
        content.push(l);
        j++;
        if (l.toLowerCase().includes(endTag)) break;
      }
      blocks.push({ t: 'html', lines: content });
      return j;
    }
  }
  let j = i + 1;
  while (j < end) {
    const l = lines[j];
    if (type === 6 || type === 7) {
      if (isBlank(l)) break;
      content.push(l);
      j++;
      continue;
    }
    content.push(l);
    if (type === 4) {
      if (l.includes('>')) { j++; break; }
    } else if (l.includes(enders[type])) { j++; break; }
    j++;
  }
  blocks.push({ t: 'html', lines: content });
  return j;
}

function readQuote(lines, i, end, refs, blocks) {
  const inner = [];
  let paraOpen = false;
  // Track whether the inner content is currently inside a fenced code block:
  // a lazy line may only continue a paragraph, never a fence (or other block).
  let fenceCh = null, fenceLen = 0;
  const trackFence = (content) => {
    const { cols: ind, rest } = splitLeading(content);
    if (ind > 3) return;
    if (fenceCh === null) {
      const fm = FENCE_RE.exec(content);
      if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) {
        fenceCh = fm[1][0]; fenceLen = fm[1].length;
      }
    } else {
      const cm = /^(`{3,}|~{3,})[ \t]*$/.exec(rest);
      if (cm && cm[1][0] === fenceCh && cm[1].length >= fenceLen) fenceCh = null;
    }
  };
  let j = i;
  while (j < end) {
    const line = lines[j];
    const { cols: ind, rest } = splitLeading(line);
    if (ind <= 3 && rest[0] === '>') {
      // After '>', one optional column of whitespace is consumed (a tab counts
      // by its absolute width, so a straddled tab leaves spaces behind).
      const content = stripColumns(rest.slice(1), 1, ind + 1);
      inner.push(content);
      trackFence(content);
      paraOpen = fenceCh === null && !isBlank(content) && !startsBlock(content);
      j++;
      continue;
    }
    // A truly blank line (no '>') ends the blockquote; the next '>' line
    // starts a new one. (A '>' line with empty content is NOT blank here.)
    if (isBlank(line)) break;
    if (paraOpen && !startsBlock(line)) {
      // Lazy continuation: strip 4 columns if the line is indented >= 4,
      // otherwise keep it verbatim.
      inner.push(lineIndent(line) >= 4 ? stripColumns(line, 4) : line);
      j++; continue;
    }
    break;
  }
  const innerParsed = parseRange(inner, 0, inner.length, refs);
  blocks.push({ t: 'quote', children: innerParsed.blocks });
  return j;
}

function readList(lines, i, end, refs, blocks) {
  const first = parseMarker(lines[i]);
  const items = [];
  let loose = false;
  let j = i;
  while (j < end) {
    const line = lines[j];
    // A thematic break ends the list (it is an <hr>, not another item).
    if (items.length > 0 && lineIndent(line) <= 3 && HR_RE.test(line)) break;
    const m = parseMarker(line);
    if (!m) break;
    if (items.length > 0 && (m.bullet !== first.bullet || m.delim !== first.delim)) break;
    const itemLines = [m.firstContent];
    let paraOpen = !m.empty && !startsBlock(m.firstContent);
    let sawBlank = false;
    j++;
    while (j < end) {
      const l = lines[j];
      if (isBlank(l)) { itemLines.push(''); sawBlank = true; paraOpen = false; j++; continue; }
      const ind = lineIndent(l);
      if (ind >= m.contentIndent) {
        const stripped = stripColumns(l, m.contentIndent);
        itemLines.push(stripped);
        paraOpen = stripped !== '' && !startsBlock(stripped);
        j++;
        continue;
      }
      // A line that is a thematic break ends the list (it is an <hr>, not an item).
      if (ind <= 3 && HR_RE.test(l)) break;
      const nm = parseMarker(l);
      if (nm && nm.bullet === first.bullet && nm.delim === first.delim) {
        if (sawBlank) loose = true;
        break;
      }
      if (paraOpen && !startsBlock(l)) {
        itemLines.push(lineIndent(l) >= 4 ? stripColumns(l, 4) : l);
        j++; continue;
      }
      break;
    }
    while (itemLines.length && itemLines[itemLines.length - 1] === '') itemLines.pop();
    const inner = parseRange(itemLines, 0, itemLines.length, refs);
    if (inner.blankBetween) loose = true;
    items.push({ children: inner.blocks, startNum: m.num });
  }
  blocks.push({ t: 'list', ordered: first.bullet === null, bullet: first.bullet, delim: first.delim, start: first.num === null ? 1 : first.num, tight: !loose, children: items });
  return j;
}

// Parse lines[start..end) into blocks. Returns {blocks, blankBetween}.
function parseRange(lines, start, end, refs) {
  const blocks = [];
  let blankBetween = false;
  let pendingBlank = false;
  let para = null;
  const pushBlock = (b) => {
    if (b) {
      if (pendingBlank && blocks.length > 0) blankBetween = true;
      blocks.push(b);
    }
    pendingBlank = false;
  };
  const flushPara = () => {
    if (para) {
      pushBlock(finalizeParagraph(para, refs));
      para = null;
    }
  };
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) { flushPara(); pendingBlank = true; i++; continue; }
    const { cols: ind, rest: content } = splitLeading(line);
    if (para) {
      if (ind <= 3 && SETEXT_RE.test(line)) {
        let k = 0;
        while (k < para.length) {
          const d = parseRefDef(para, k, refs);
          if (!d) break;
          k += d.used;
        }
        const rest = para.slice(k);
        para = null;
        if (rest.length > 0) {
          // Heading text: first line's leading indent stripped, every line's
          // trailing whitespace stripped, continuation indents kept.
          const hlines = rest.map((l, idx) => {
            let t = l.replace(/[ \t]+$/, '');
            if (idx === 0) t = splitLeading(t).rest;
            return t;
          });
          pushBlock({ t: 'heading', level: line.trim()[0] === '=' ? 1 : 2, lines: hlines });
        } else {
          // Only ref defs: the setext line starts fresh below.
          continue;
        }
        i++;
        continue;
      }
      if (ind <= 3) {
        const atx = ATX_RE.exec(line);
        if (atx) { flushPara(); pushBlock(makeHeading(atx)); i++; continue; }
        const fm = FENCE_RE.exec(line);
        if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) { flushPara(); if (pendingBlank && blocks.length > 0) blankBetween = true; i = readFence(lines, i, end, fm, blocks); pendingBlank = false; continue; }
        if (HR_RE.test(line)) { flushPara(); pushBlock({ t: 'hr' }); i++; continue; }
        if (content[0] === '>') { flushPara(); if (pendingBlank && blocks.length > 0) blankBetween = true; i = readQuote(lines, i, end, refs, blocks); pendingBlank = false; continue; }
        // HTML blocks of types 1-6 can interrupt a paragraph (type 7 cannot).
        const hb = htmlBlockStart(line);
        if (hb >= 1 && hb <= 6) { flushPara(); if (pendingBlank && blocks.length > 0) blankBetween = true; i = readHtml(lines, i, end, hb, blocks); pendingBlank = false; continue; }
        const lm = parseMarker(line);
        if (lm && (lm.bullet !== null || lm.num === 1) && !lm.empty) { flushPara(); if (pendingBlank && blocks.length > 0) blankBetween = true; i = readList(lines, i, end, refs, blocks); pendingBlank = false; continue; }
      }
      para.push(line);
      i++;
      continue;
    }
    if (ind <= 3) {
      const atx = ATX_RE.exec(line);
      if (atx) { pushBlock(makeHeading(atx)); i++; continue; }
      const fm = FENCE_RE.exec(line);
      if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) { if (pendingBlank && blocks.length > 0) blankBetween = true; i = readFence(lines, i, end, fm, blocks); pendingBlank = false; continue; }
      const hb = htmlBlockStart(line);
      if (hb > 0) { if (pendingBlank && blocks.length > 0) blankBetween = true; i = readHtml(lines, i, end, hb, blocks); pendingBlank = false; continue; }
      if (HR_RE.test(line)) { pushBlock({ t: 'hr' }); i++; continue; }
      if (content[0] === '>') { if (pendingBlank && blocks.length > 0) blankBetween = true; i = readQuote(lines, i, end, refs, blocks); pendingBlank = false; continue; }
      const lm = parseMarker(line);
      if (lm) { if (pendingBlank && blocks.length > 0) blankBetween = true; i = readList(lines, i, end, refs, blocks); pendingBlank = false; continue; }
    }
    if (ind >= 4) { if (pendingBlank && blocks.length > 0) blankBetween = true; i = readIndentedCode(lines, i, end, blocks); pendingBlank = false; continue; }
    para = [line];
    i++;
  }
  flushPara();
  return { blocks, blankBetween };
}

function parseBlocks(lines, refs) {
  return parseRange(lines, 0, lines.length, refs);
}

// ---------------- Rendering ----------------

function renderItem(item, tight, refs) {
  let checkbox = '';
  const first = item.children[0];
  if (first && first.t === 'paragraph' && first.lines.length > 0) {
    const m = /^\[([ xX])\] /.exec(first.lines[0]);
    if (m) {
      checkbox = m[1] === ' '
        ? '<input disabled="" type="checkbox"> '
        : '<input checked="" disabled="" type="checkbox"> ';
      first.lines[0] = first.lines[0].slice(4);
      if (first.lines[0] === '') first.lines.shift();
    }
  }
  let inner = '';
  for (let k = 0; k < item.children.length; k++) {
    const c = item.children[k];
    if (c.t === 'paragraph' && tight && k === 0) {
      inner += checkbox + renderInline(c.lines.join('\n'), refs);
    } else if (c.t === 'paragraph') {
      inner += '<p>' + (k === 0 ? checkbox : '') + renderInline(c.lines.join('\n'), refs) + '</p>\n';
    } else {
      inner += renderBlock(c, refs);
    }
  }
  return '<li>' + inner + '</li>\n';
}

function renderBlock(b, refs) {
  switch (b.t) {
    case 'paragraph':
      return '<p>' + renderInline(b.lines.join('\n'), refs) + '</p>\n';
    case 'heading':
      return '<h' + b.level + '>' + renderInline(b.lines.join('\n'), refs) + '</h' + b.level + '>\n';
    case 'fence': {
      const lang = b.info === '' ? '' : ' class="language-' + escapeEntityAware(b.info.split(/[ \t]+/)[0]) + '"';
      const body = b.lines.length ? b.lines.join('\n') + '\n' : '';
      return '<pre><code' + lang + '>' + escapeText(body) + '</code></pre>\n';
    }
    case 'code': {
      const body = b.lines.length ? b.lines.join('\n') + '\n' : '';
      return '<pre><code>' + escapeText(body) + '</code></pre>\n';
    }
    case 'html':
      return b.lines.join('\n') + (b.addTrailingNL ? '\n' : '');
    case 'hr':
      return '<hr>\n';
    case 'quote':
      return '<blockquote>\n' + renderBlocks(b.children, refs) + '</blockquote>\n';
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (const item of b.children) out += renderItem(item, b.tight, refs);
      return out + '</' + tag + '>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < b.header.length; k++) {
        const a = b.aligns[k];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(b.header[k], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let k = 0; k < row.length; k++) {
            const a = b.aligns[k];
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(row[k], refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
  }
  return '';
}

function renderBlocks(blocks, refs) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, refs);
  return out;
}
