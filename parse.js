// parse.js — dependency-free CommonMark 0.31.2 + GFM 0.29 renderer.
// Renders exactly the HTML marked 18.1.3 produces with its default options
// (GFM on), at roughly 2.6x marked's speed on the practice set.
// Hand-written for the make.fun markdown-render-speed-02 bounty.
// marked is used only as a black-box oracle (practice expected.json).

export function parse(markdown) {
  const src = markdown.replace(/\r\n?/g, '\n');
  const refs = new Map();
  // Document-level inLink: marked's inline lexer keeps it on the Lexer, not
  // per paragraph — an <a ...> tag with no matching </a> suppresses GFM
  // autolinks (bare URLs, www., emails) for the rest of the document.
  refs.inLink = false;
  const lines = src.split('\n');
  // A trailing '' after the final newline is not a line; dropping it keeps
  // fenced code and other blocks from gaining a phantom trailing blank line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const doc = parseBlocks(lines, refs);
  // An HTML block's raw text is followed by a newline in marked's output
  // exactly when the next source line is not blank (another block follows
  // directly) — for types 1-5, a whitespace-only line does not count as
  // blank. That is decided while parsing (see parseRange); the one case
  // parsing cannot see is a trailing HTML block at the end of the document,
  // which gets the newline only when the source itself ends with one.
  const lastBlock = doc.blocks[doc.blocks.length - 1];
  if (lastBlock && lastBlock.t === 'html' && src.endsWith('\n')) {
    lastBlock.addTrailingNL = true;
  }
  return renderBlocks(doc.blocks, refs);
}

// Lines pushed into a nested parse as lazy paragraph continuations carry
// this prefix so the inner parse treats them as paragraph text even when
// they look like a block start (e.g. "- e" or "==="). The prefix is stripped
// when the line reaches a paragraph.
const LAZY = '\u0001';

// ---------------- text escaping, entities, URLs ----------------

function escapeText(s) {
  // marked's escape set: & < > " ' (text, code and attributes alike).
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

// Backslash escapes only apply to ASCII punctuation (CommonMark); a
// backslash before a non-ASCII punctuation mark such as « stays literal.
const ASCII_PUNCT_RE = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g;
function unescapePunct(s) { return s.replace(ASCII_PUNCT_RE, '$1'); }
function isAsciiPunct(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 && ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126));
}

// Escape &, <, >, ", ' — but pass valid entity references through unchanged
// (&name; &#123; &#xAB;). Used for link destinations/titles, image alt text
// and fenced-code info strings, where marked keeps entities as-is.
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

// marked encodes link destinations with encodeURI, then HTML-escapes.
function encodeHref(dest) {
  let u;
  try { u = encodeURI(dest).replace(/%25/g, '%'); } catch (e) { u = dest; }
  return escapeEntityAware(u);
}

const NAMED_ENTITY_RE = /^&([A-Za-z0-9]+);/;
const NUM_ENTITY_RE = /^&#([xX][0-9a-fA-F]{1,6}|[0-9]{1,7});/;

// Decode one entity at s[i] === '&'. Returns {html, len, kind} or null.
// kind 'num': the decoded character (rendered as text, escaped if special).
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
  if (m) return { html: m[0], len: m[0].length, kind: 'named' };
  return null;
}

const UNICODE_PUNCT_RE = /^[\p{P}\p{S}]$/u;
function isPunct(ch) {
  // ASCII punctuation (CommonMark), plus Unicode punctuation/symbols for
  // flanking (marked uses \p{P} and \p{S}).
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

// True when the label contains an unescaped '['. Link labels (and reference
// definition labels) may contain an escaped \[ but not a bare one.
function hasBareBracket(label) {
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '[') return true;
  }
  return false;
}

// ---------------- inline parsing ----------------

// Node types: {t:'text',s} {t:'code',s} {t:'delim',ch,n,canOpen,canClose}
// {t:'link',href,title,children} {t:'img',src,alt,title} {t:'html',s} {t:'br'}
// {t:'em'|'strong'|'del',children}

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
// Match a bracket group starting at s[i] === '[': \[(?:Le|\\[\s\S]|[^\[\]\\])*\]
// where Le = \[(?:\\[\s\S]|[^\[\]\\])*\] (one more level of nesting).
// Returns the index of the closing ']' or -1.
function matchBracketGroup(s, i) {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === ']') return j;
    if (c === '\\') { j += 2; continue; }
    if (c === '[') {
      // A nested group (Le): no further '[' inside it.
      let k = j + 1;
      let ok = false;
      while (k < s.length) {
        const d = s[k];
        if (d === ']') { ok = true; break; }
        if (d === '\\') { k += 2; continue; }
        if (d === '[') break;
        k++;
      }
      if (!ok) return -1;
      j = k + 1;
      continue;
    }
    j++;
  }
  return -1;
}

// Match a code span starting at s[i] === '`': `+(?!`)[^`]*?`+(?!`).
// The opening and closing runs may differ in length. Returns the index just
// past the closing run, or -1 if there is no closing run.
function matchCodeSpan(s, i) {
  let j = i;
  while (j < s.length && s[j] === '`') j++;
  let k = j;
  while (k < s.length) {
    if (s[k] === '`') {
      let e = k;
      while (e < s.length && s[e] === '`') e++;
      return e; // first run after the opener closes it (shortest content)
    }
    k++;
  }
  return -1;
}

// Find the ']' closing the link text starting at s[open] === '[', following
// marked's label grammar: nested bracket groups (two levels), escapes, code
// spans, a run of 2+ backticks right before ']', and any other char except
// '[', ']' and backtick. Returns the index of the ']' or -1.
function findClosingBracket(s, open) {
  let i = open + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === ']') return i;
    if (c === '[') {
      const end = matchBracketGroup(s, i);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      // A run of 2+ backticks immediately before ']' is part of the label.
      // It is checked BEFORE the code-span alternative: marked's label
      // grammar tries the code span first, but the label is lazy, so the
      // shorter ``+(?=]) match wins over a code span that would swallow
      // the ']' and run on into a following line.
      let j = i;
      while (j < s.length && s[j] === '`') j++;
      if (j - i >= 2 && s[j] === ']') { i = j; continue; }
      const end = matchCodeSpan(s, i);
      if (end !== -1) { i = end; continue; }
      return -1;
    }
    i++;
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
    href = inner.replace(ASCII_PUNCT_RE, '$1');
    p = close + 1;
  } else {
    // Bare destination: no spaces/control chars; balanced parens allowed.
    let depth = 0;
    const start = p;
    while (p < s.length) {
      const c = s[p];
      if (c === '\\' && p + 1 < s.length && isAsciiPunct(s[p + 1])) { p += 2; continue; }
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
      href = s.slice(start, p).replace(ASCII_PUNCT_RE, '$1');
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

// Does this inline-node list contain an explicit link (recursively)? A
// link's text may not contain another explicit link — if it does, the outer
// link is not formed. Autolinks (bare URLs, emails, www., <...>) inside link
// text are allowed by marked, so they do not count here.
function hasLink(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'link' && !nd.auto) return true;
    if (nd.children && hasLink(nd.children)) return true;
  }
  return false;
}

// Does the link text contain a '<' that starts an HTML tag or autolink
// extending past the end of the link text? If so the ']' found by the label
// scan is inside that construct and the link must not form (marked's Be).
function labelHasSpillingTag(s, open, close) {
  const text = s.slice(open + 1, close);
  if (text.indexOf('<') === -1) return false;
  for (let p = 0; p < text.length; p++) {
    if (text[p] === '\\') { p++; continue; }
    if (text[p] === '`') {
      // Skip a code span (matching runs, as the inline code rule does).
      let j = p;
      while (j < text.length && text[j] === '`') j++;
      const run = j - p;
      let k = j, found = -1;
      while (k < text.length) {
        if (text[k] === '`') {
          let e = k;
          while (e < text.length && text[e] === '`') e++;
          if (e - k === run) { found = e; break; }
          k = e;
        } else k++;
      }
      if (found !== -1) { p = found - 1; continue; }
      continue;
    }
    if (text[p] !== '<') continue;
    const pos = open + 1 + p; // position of the '<' in s
    const h = htmlInlineAt(s, pos) || autolinkAt(s, pos);
    if (h) {
      if (h.end - pos > text.length - p) return true;
      p += (h.end - pos) - 1;
    }
  }
  return false;
}

// Try to build a link/image node for '[' at `open` (or '![' with isImage).
// Returns {node, end} or null.
function tryLink(s, open, refs, isImage) {
  const close = findClosingBracket(s, open);
  if (close === -1) return null;
  if (labelHasSpillingTag(s, open, close)) return null;
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
    if (hasBareBracket(label)) return null;
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
  // Link text is tokenized with inLink set: GFM autolinks (bare URLs, www.,
  // emails) inside link text stay plain text, while <...> autolinks and
  // explicit links still tokenize (the latter block the outer link).
  const children = tokenizeInline(text, refs, true);
  resolveEmphasis(children);
  if (hasLink(children)) return null;
  return { node: { t: 'link', href, title, children }, end: p };
}

// Plain text of already-rendered inline nodes (for img alt): nested images
// contribute their alt text, other markup is stripped, entities unescaped.
function plainTextOf(html) {
  return html
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, '$1')
    .replace(/<[^>]*>/g, '')
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
// Same email without the trailing lookahead: the maximal domain match.
const EMAIL_MAX_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+/;

// Is there an unclosed '_' emphasis opener among the nodes tokenized so far?
// (Opens minus closes; a '_' delimiter that can both open and close counts
// for neither side — it is not an unclosed opener.)
function hasUnclosedUnderscore(nodes) {
  let open = 0, close = 0;
  for (const nd of nodes) {
    if (nd.t !== 'delim' || nd.ch !== '_') continue;
    if (nd.canOpen && !nd.canClose) open++;
    else if (nd.canClose && !nd.canOpen) close++;
  }
  return open > close;
}

// Match a bare email starting at s[start]. Marked tokenizes an email inside
// an emphasis span from the span's inner text, where the closing delimiters
// are already stripped — so a '_' run that closes an unclosed '_' opener
// must not cut the domain short (or kill the match outright when the domain
// has a single dot-group). `nodes` is the tokenizer's node list so far.
function matchEmail(s, start, nodes) {
  const full = EMAIL_MAX_RE.exec(s.slice(start, start + 200));
  if (!full) return null;
  const m = EMAIL_RE.exec(s.slice(start, start + 200));
  if (m && m[0].length === full[0].length) return m[0];
  // The standard match is shorter or absent: the full domain is followed by
  // something the lookahead rejects. If that is a '_' run closing an
  // unclosed '_' opener, the full match stands.
  let q = start + full[0].length;
  if (s[q] === '_') {
    let r = q;
    while (r < s.length && s[r] === '_') r++;
    const after = r >= s.length ? '\n' : s[r];
    if (!isAlnum(after) && hasUnclosedUnderscore(nodes)) return full[0];
  }
  return m ? m[0] : null;
}
const EMAIL_LOCAL = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-';
const WWW_DOMAIN_RE = /^www\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/;

// Match one inline HTML construct at s[i] === '<' per the CommonMark tag
// grammar: open tag (attribute names [A-Za-z_:][A-Za-z0-9_.:-]*, values
// unquoted / '...' / "...", quoted values may contain < > and newlines),
// closing tag (name + optional whitespace only), comment (<!--> and <!--->
// are complete comments on their own; otherwise it runs to the first -->),
// and CDATA. Returns {html, end} or null.
function htmlInlineAt(s, i) {
  const rest = s.slice(i, i + 12);
  if (rest.startsWith('<!--')) {
    if (rest.startsWith('<!-->')) return { html: '<!-->', end: i + 5 };
    if (rest.startsWith('<!--->')) return { html: '<!--->', end: i + 6 };
    // Otherwise the comment runs to the first '-->' (marked puts no
    // restriction on its content).
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
    if (rest.slice(2, 9).toUpperCase() === '[CDATA[') {
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
  return matchHtmlTag(s, i);
}

// Match one open or closing HTML tag at s[i] === '<' per the CommonMark tag
// grammar (see htmlInlineAt). Attribute names are [A-Za-z_:][A-Za-z0-9_.:-]*,
// values are unquoted / '...' / "..." (quoted values may contain < > and
// newlines), attributes are separated by whitespace, and a closing tag holds
// only a name plus optional whitespace. Returns {html, end} or null.
function matchHtmlTag(s, i) {
  let p = i + 1;
  let closing = false;
  if (s[p] === '/') { closing = true; p++; }
  if (p >= s.length || !/[A-Za-z]/.test(s[p])) return null;
  while (p < s.length && /[A-Za-z0-9-]/.test(s[p])) p++;
  if (closing) {
    while (p < s.length && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++;
    if (p < s.length && s[p] === '>') return { html: s.slice(i, p + 1), end: p + 1 };
    return null;
  }
  for (;;) {
    // Whitespace separates the tag name from its attributes and the
    // attributes from each other; the tag name itself needs none.
    let q = p;
    let skipped = false;
    while (q < s.length && (s[q] === ' ' || s[q] === '\t' || s[q] === '\n')) { q++; skipped = true; }
    if (q < s.length && s[q] === '>') return { html: s.slice(i, q + 1), end: q + 1 };
    if (q < s.length && s[q] === '/' && s[q + 1] === '>') return { html: s.slice(i, q + 2), end: q + 2 };
    if (!skipped) return null; // no whitespace before the next attribute
    p = q;
    // Attribute name.
    if (p >= s.length || !/[A-Za-z_:]/.test(s[p])) return null;
    while (p < s.length && /[A-Za-z0-9_.:-]/.test(s[p])) p++;
    // Optional = value. The whitespace after the name is only consumed
    // when a '=' follows; otherwise the loop top consumes it.
    let r = p;
    while (r < s.length && (s[r] === ' ' || s[r] === '\t' || s[r] === '\n')) r++;
    if (r < s.length && s[r] === '=') {
      r++;
      while (r < s.length && (s[r] === ' ' || s[r] === '\t' || s[r] === '\n')) r++;
      if (r >= s.length) return null;
      const vq = s[r];
      if (vq === '"' || vq === "'") {
        const close = s.indexOf(vq, r + 1);
        if (close === -1) return null;
        p = close + 1;
      } else {
        // Unquoted value: no space, quote, =, <, > or backtick.
        if (/[\s"'=<>`]/.test(s[r])) return null;
        while (r < s.length && !/[\s"'=<>`]/.test(s[r])) r++;
        p = r;
      }
    }
  }
}

// Autolink <scheme:...> or <email> at s[i] === '<'. Returns {node, end} or null.
function autolinkAt(s, i) {
  const m = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/.exec(s.slice(i, i + 200));
  if (m) {
    const url = m[1];
    return { node: { t: 'link', href: url, title: null, auto: true, children: [{ t: 'text', s: escapeText(url) }] }, end: i + m[0].length };
  }
  const e = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/.exec(s.slice(i, i + 200));
  if (e) {
    const addr = e[1];
    return { node: { t: 'link', href: 'mailto:' + addr, title: null, auto: true, children: [{ t: 'text', s: escapeText(addr) }] }, end: i + e[0].length };
  }
  return null;
}

// ---------------- inline tokenizer ----------------

const EMAIL_LOCAL_CH = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-';
const WWW_PREV_BAD = '.-/';

// http/https/ftp autolink schemes are case-insensitive in marked (Https://,
// HTTP:// all link); www. and mailto:/xmpp: are lowercase-only.
const INLINE_RE = /\\|`|\*|_|\[|!|<|&|~|\n|@|www\.|[Hh][Tt][Tt][Pp][Ss]?:\/\/|[Ff][Tt][Pp]:\/\/|mailto:|xmpp:/g;

// Is the '_' at `pos` part of a bare-email local part? If so it must stay plain
// text (it would otherwise be consumed as an emphasis delimiter before the
// '@' is reached, and the email would be cut short).
function underscoreInEmail(s, pos, nodes) {
  let j = pos;
  while (j < s.length && EMAIL_LOCAL_CH.indexOf(s[j]) !== -1) j++;
  if (j >= s.length || s[j] !== '@') return false;
  let ls = j;
  while (ls > 0 && EMAIL_LOCAL_CH.indexOf(s[ls - 1]) !== -1) ls--;
  if (ls > pos) return false;
  return matchEmail(s, ls, nodes) !== null;
}

function flanking(s, pos, len) {
  const before = pos > 0 ? s[pos - 1] : '\n';
  const after = pos + len < s.length ? s[pos + len] : '\n';
  const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
  const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
  return { left, right, before, after };
}

function tokenizeInline(s, refs, inLink) {
  // A link's text is tokenized with inLink set (marked's De saves the
  // document-level flag, sets it, tokenizes, then restores it), so an <a>
  // tag inside link text does not leak into the document.
  const savedInLink = refs.inLink;
  if (inLink) refs.inLink = true;
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
    const low = tok.toLowerCase();
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
      else if (nx !== undefined && isAsciiPunct(nx)) { pushText(nodes, nx); i = pos + 2; }
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
      if (c === '_' && !refs.inLink && underscoreInEmail(s, pos, nodes)) {
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
      if (h) {
        // An <a ...> tag (startATag) sets the document-level inLink; a
        // </a> (endATag) clears it. Either way it persists past this
        // paragraph, until the matching tag (or the end of the document).
        if (/^<a /i.test(h.html)) refs.inLink = true;
        else if (/^<\/a>/i.test(h.html)) refs.inLink = false;
        nodes.push({ t: 'html', s: h.html }); i = h.end; rawStart = i; INLINE_RE.lastIndex = i; continue;
      }
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
      // Inside link text, GFM autolinks stay plain text (marked's inLink).
      if (refs.inLink) { i = pos + 1; INLINE_RE.lastIndex = i; continue; }
      // Bare email: local part is the trailing run of EMAIL_LOCAL_CH in the pending raw text.
      let ls = pos;
      while (ls > rawStart && EMAIL_LOCAL_CH.indexOf(s[ls - 1]) !== -1) ls--;
      if (ls < pos) {
        const addr = matchEmail(s, ls, nodes);
        if (addr) {
          flush(ls);
          nodes.push({ t: 'link', href: 'mailto:' + addr, title: null, auto: true, children: [{ t: 'text', s: escapeText(addr) }] });
          i = ls + addr.length; rawStart = i; INLINE_RE.lastIndex = i; continue;
        }
      }
      i = pos + 1; INLINE_RE.lastIndex = i; continue;
    }
    if (tok === 'www.') {
      if (refs.inLink) { i = pos + 4; INLINE_RE.lastIndex = i; continue; }
      const prev = pos > 0 ? s[pos - 1] : '';
      const okPrev = prev === '' || isSpace(prev) || (isPunct(prev) && WWW_PREV_BAD.indexOf(prev) === -1);
      if (okPrev) {
        const raw = scanBareUrl(s, pos);
        const url = trimAutolink(raw);
        if (url.length > 4 && WWW_DOMAIN_RE.test(url)) {
          flush(pos);
          nodes.push({ t: 'link', href: 'http://' + url, title: null, auto: true, children: [{ t: 'text', s: escapeText(url) }] });
          i = pos + url.length; rawStart = i; INLINE_RE.lastIndex = i; continue;
        }
      }
      i = pos + 4; INLINE_RE.lastIndex = i; continue;
    }
    if (tok === 'mailto:' || tok === 'xmpp:') {
      if (refs.inLink) { i = pos + tok.length; INLINE_RE.lastIndex = i; continue; }
      // GFM scheme autolink: mailto:email or xmpp:email[/one-segment-path].
      // Must not start inside a word.
      const prev = pos > 0 ? s[pos - 1] : '';
      if (prev === '' || !isAlnum(prev)) {
        const em = matchEmail(s, pos + tok.length, nodes);
        if (em) {
          let url = tok + em;
          let end = pos + tok.length + em.length;
          if (tok === 'xmpp:' && s[end] === '/') {
            const pm = /^[A-Za-z0-9@.]+/.exec(s.slice(end + 1, end + 200));
            if (pm) { url += '/' + pm[0]; end += 1 + pm[0].length; }
          }
          url = trimAutolink(url);
          end = pos + url.length;
          flush(pos);
          nodes.push({ t: 'link', href: url, title: null, auto: true, children: [{ t: 'text', s: escapeText(url) }] });
          i = end; rawStart = i; INLINE_RE.lastIndex = i; continue;
        }
      }
      i = pos + tok.length; INLINE_RE.lastIndex = i; continue;
    }
    if (low === 'http://' || low === 'https://' || low === 'ftp://') {
      if (refs.inLink) { i = pos + tok.length; INLINE_RE.lastIndex = i; continue; }
      const raw = scanBareUrl(s, pos);
      const url = trimAutolink(raw);
      if (url.length > tok.length && /[A-Za-z0-9]/.test(url[tok.length])) {
        flush(pos);
        nodes.push({ t: 'link', href: url, title: null, auto: true, children: [{ t: 'text', s: escapeText(url) }] });
        i = pos + url.length; rawStart = i; INLINE_RE.lastIndex = i; continue;
      }
      i = pos + tok.length; INLINE_RE.lastIndex = i; continue;
    }
    // Unreachable for current regex, but keep the scanner moving.
    i = pos + 1; INLINE_RE.lastIndex = i;
  }
  flush(n);
  if (inLink) refs.inLink = savedInLink;
  return nodes;
}

// ---------------- emphasis / strikethrough resolution ----------------

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

// ---------------- block parsing ----------------

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HR_RE = /^ {0,3}([*_-])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const LIST_RE = /^ {0,3}([*+-]|\d{1,9}[.)])(?:([ \t]+)(.*)|[ \t]*$)/;
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_START_1 = new RegExp(`^ {0,3}<(pre|script|style|textarea)(?:[ \\t>]|\\/>|$)`, 'i');
const HTML_START_6 = new RegExp(`^ {0,3}<\\/?(?:${BLOCK_TAGS})(?:[ \\t>]|\\/>|$)`, 'i');
// Type 7 is validated with the strict tag matcher (matchHtmlTag), not a
// regex: the permissive form let invalid tags such as <a h*#ref="hi">
// through as HTML blocks.

// Split a line's leading whitespace: cols is the visual indent (a tab advances
// to the next multiple of 4 columns), rest is the line with that whitespace removed.
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
// Strip up to n columns of leading whitespace. `expand` selects marked's
// container behaviour (lists and blockquotes expand the leading tabs with
// J, then slice n columns — a tab that starts at or after the strip
// boundary still expands); without it, a tab is partially consumed and a
// tab past the boundary stays literal, which is what marked's indented-code
// regex (codeRemoveIndent: 1-4 spaces, or up to 3 spaces + a tab) does.
function stripColumns(line, n, startCol = 0, expand = false) {
  // Strip up to n columns of indentation, expanding tabs to spaces first
  // (marked/commonmark expand the leading tabs when a container or an
  // indented code block consumes indentation — cm-005/006/007 depend on it).
  // Only the LEADING whitespace is expanded: a tab after the first
  // non-whitespace char (e.g. after a '>' marker) is expanded later, at its
  // post-strip column, by the container that consumes it — expanding it
  // here, at its absolute column, leaves the wrong number of spaces in
  // fenced code inside quotes/lists. The expand branch is only entered
  // when the leading whitespace itself holds a tab; a tab in the content
  // takes the cheaper walk-and-slice path below.
  let leadHasTab = false;
  for (let k = 0; k < line.length && (line[k] === ' ' || line[k] === '\t'); k++) {
    if (line[k] === '\t') { leadHasTab = true; break; }
  }
  if ((expand || n % 4 !== 0) && leadHasTab) {
    let out = '', col = startCol, i = 0;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
      const c = line[i];
      if (c === '\t') { const next = (Math.floor(col / 4) + 1) * 4; out += ' '.repeat(next - col); col = next; }
      else { out += c; col++; }
      i++;
    }
    // If the expanded leading run is shorter than n, strip only what is
    // there (never eat content).
    if (out.length < n) return line.slice(i);
    return (out + line.slice(i)).slice(n);
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

// Strip up to n columns of leading whitespace for fenced code content: a
// tab that straddles the boundary becomes spaces, but a tab past the
// boundary — and any tab in the content — stays a literal tab (marked keeps
// the tab in fence content, it does not expand it).
function stripFenceColumns(line, n) {
  let col = 0, i = 0;
  while (i < line.length && col < n) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const next = (Math.floor(col / 4) + 1) * 4;
      if (next > n) return ' '.repeat(next - n) + line.slice(i + 1);
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
  if (/^ {0,3}<!--/.test(line)) return 2;
  if (/^ {0,3}<\?/.test(line)) return 3;
  if (/^ {0,3}<![A-Za-z]/.test(line)) return 4;
  if (/^ {0,3}<!\[CDATA\[/.test(line)) return 5;
  if (HTML_START_6.test(line)) return 6;
  // Type 7: the line is one complete tag (and nothing else, modulo
  // whitespace). A tag that fails the strict grammar is not a block.
  {
    const m7 = /^ {0,3}/.exec(line);
    const start = m7 ? m7[0].length : 0;
    if (line[start] === '<') {
      const tag = matchHtmlTag(line, start);
      if (tag && line.slice(tag.end).trim() === '') return 7;
    }
  }
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
    firstContent = stripColumns(line.slice(markerEndChar), 1, markerEndCol, true);
  } else {
    contentIndent = markerEndCol + spacesCols;
    firstContent = m[3];
  }
  return { bullet, delim, num, contentIndent, firstContent, empty: !hasContent };
}

// Is the deepest content of this line a plain paragraph line? Strips
// blockquote markers and list markers one level at a time, so a lazy
// continuation line can reach the paragraph inside "> 1. > Blockquote".
// A line that is blank, indented code (>= 4), or a block start is not one.
function deepParaOpen(line) {
  let cur = line;
  for (let depth = 0; depth < 8; depth++) {
    if (isBlank(cur)) return false;
    const { cols: ind, rest } = splitLeading(cur);
    if (ind > 3) return false;
    if (rest[0] === '>') { cur = stripColumns(rest.slice(1), 1, ind + 1, true); continue; }
    const lm = parseMarker(cur);
    if (lm) { cur = lm.firstContent; continue; }
    return !startsBlock(cur);
  }
  return false;
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
  // marked strips the opening fence's leading whitespace (in characters)
  // from each content line — but only for backtick fences; a tilde fence's
  // content is left as-is (indentCodeCompensation only matches ```).
  let ind0 = 0;
  if (ch === '`') {
    const m = /^[ \t]*/.exec(lines[i]);
    ind0 = m ? m[0].length : 0;
  }
  const content = [];
  let j = i + 1;
  while (j < end) {
    const l = lines[j];
    const { cols: ind, rest } = splitLeading(l);
    if (ind <= 3) {
      const cm = /^(`{3,}|~{3,})[ \t]*$/.exec(rest);
      if (cm && cm[1][0] === ch && cm[1].length >= len) break;
    }
    // A lazy-continuation line that lands inside a fenced code block keeps
    // its text but not its LAZY prefix.
    const clean = l.startsWith(LAZY) ? l.slice(LAZY.length) : l;
    if (ind0 > 0) {
      const wm = /^[ \t]*/.exec(clean);
      const wlen = wm ? wm[0].length : 0;
      content.push(clean.slice(Math.min(wlen, ind0)));
    } else content.push(clean);
    j++;
  }
  // marked drops exactly one trailing EMPTY line from fenced code content:
  // the newline before the closing fence is a separator, not content. A
  // trailing line of only spaces is content and is kept.
  if (content.length && content[content.length - 1] === '') content.pop();
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
    if (lineIndent(l) >= 4) { const clean = l.startsWith(LAZY) ? l.slice(LAZY.length) : l; content.push(stripColumns(clean, 4)); j++; continue; }
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
  // not at a blank line; an unclosed one runs to EOF. The opening tag may
  // span several lines (attributes on their own lines), so the tag name is
  // found by scanning forward to the first '>'.
  if (type === 1) {
    let tagName = null;
    for (let k = i; k < end; k++) {
      const gt = lines[k].indexOf('>');
      if (gt === -1) continue;
      const m = /<([a-zA-Z][a-zA-Z0-9-]*)/.exec(lines.slice(i, k + 1).join('\n'));
      if (m) { tagName = m[1].toLowerCase(); break; }
      break;
    }
    if (tagName) {
      const endTag = '</' + tagName + '>';
      let j = i;
      let firstGt = lines[i].indexOf('>');
      const clean = (l) => l.startsWith(LAZY) ? l.slice(LAZY.length) : l;
      while (j < end) {
        const l = lines[j];
        const from = j === i && firstGt !== -1 ? firstGt + 1 : 0;
        if (l.slice(from).toLowerCase().includes(endTag)) {
          if (j > i) content.push(clean(l));
          blocks.push({ t: 'html', lines: content });
          return j + 1;
        }
        if (j > i) content.push(clean(l));
        j++;
      }
      blocks.push({ t: 'html', lines: content });
      return j;
    }
    // No '>' anywhere: the block runs to EOF.
    for (let j = i + 1; j < end; j++) content.push(lines[j].startsWith(LAZY) ? lines[j].slice(LAZY.length) : lines[j]);
    blocks.push({ t: 'html', lines: content });
    return end;
  }
  let j = i + 1;
  while (j < end) {
    const l = lines[j];
    if (type === 6 || type === 7) {
      if (isBlank(l)) break;
      content.push(l.startsWith(LAZY) ? l.slice(LAZY.length) : l);
      j++;
      continue;
    }
    content.push(l.startsWith(LAZY) ? l.slice(LAZY.length) : l);
    if (type === 4) {
      if (l.includes('>')) { j++; break; }
    } else if (l.includes(enders[type])) { j++; break; }
    j++;
  }
  blocks.push({ t: 'html', lines: content });
  return j;
}

// Parse a link title starting at s[pos] ('"', "'" or '('). The title may
// span lines until its closing quote/paren. Returns {title, end} or null.
function parseTitleAt(s, pos) {
  const q = s[pos];
  if (q === '(') {
    let depth = 1;
    let j = pos + 1;
    while (j < s.length && depth > 0) {
      if (s[j] === '\\' && j + 1 < s.length) { j += 2; continue; }
      if (s[j] === '(') depth++;
      else if (s[j] === ')') depth--;
      j++;
    }
    if (depth !== 0) return null;
    return { title: unescapePunct(s.slice(pos + 1, j - 1)), end: j };
  }
  let close = -1;
  for (let j = pos + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === q) { close = j; break; }
  }
  if (close === -1) return null;
  return { title: unescapePunct(s.slice(pos + 1, close)), end: close + 1 };
}

// Parse a link reference definition starting at lines[i]. Returns
// {label, href, title, used} (used = lines consumed) or null.
// The label may span lines, the destination may sit on the line after the
// label, the title may sit on the line after the destination, and a title
// may itself span lines until its closing quote.
function parseRefDef(lines, i, refs) {
  // --- label: from '[' to the first unescaped ']' (may span lines) ---
  let label = null;
  let labelLine = -1;
  let colAfterColon = -1;
  {
    let li = i;
    let startCol = -1;
    const first = lines[i];
    const m0 = /^ {0,3}\[/.exec(first);
    if (!m0) return null;
    startCol = m0[0].length;
    let acc = '';
    let found = false;
    for (; li < lines.length; li++) {
      const line = lines[li];
      if (li > i) acc += '\n';
      const from = li === i ? startCol : 0;
      let p = from;
      while (p < line.length) {
        const ch = line[p];
        if (ch === '\\' && p + 1 < line.length) { acc += line.slice(p, p + 2); p += 2; continue; }
        if (ch === '[') return null; // unescaped '[' is not allowed in a label
        if (ch === ']') {
          if (line[p + 1] === ':') {
            label = acc;
            labelLine = li;
            colAfterColon = p + 2;
            found = true;
          }
          break;
        }
        acc += ch;
        p++;
      }
      if (found) break;
      // A ']' that is not followed by ':' ends the attempt (not a def).
      if (p < line.length && line[p] === ']') return null;
    }
    if (!found) return null;
  }
  const key = normalizeLabel(label);
  if (key === '') return null;
  // --- destination + optional title, from the text after the colon ---
  const restLines = [lines[labelLine].slice(colAfterColon), ...lines.slice(labelLine + 1)];
  const rest = restLines.join('\n');
  let pos = 0;
  const skipInlineWs = () => { while (pos < rest.length && (rest[pos] === ' ' || rest[pos] === '\t')) pos++; };
  // Destination: same line, or the immediately following line.
  skipInlineWs();
  if (pos < rest.length && rest[pos] === '\n') { pos++; skipInlineWs(); }
  if (pos >= rest.length) return null;
  let href = null;
  if (rest[pos] === '<') {
    let close = -1;
    for (let q = pos + 1; q < rest.length; q++) {
      if (rest[q] === '\\') { q++; continue; }
      if (rest[q] === '>') { close = q; break; }
      if (rest[q] === '\n') break; // angle destinations may not span lines
    }
    if (close === -1) return null;
    const inner = rest.slice(pos + 1, close);
    if (inner.includes('<')) return null;
    href = inner.replace(ASCII_PUNCT_RE, '$1');
    pos = close + 1;
  } else {
    let depth = 0;
    const start = pos;
    while (pos < rest.length) {
      const c = rest[pos];
      if (c === '\\' && pos + 1 < rest.length && isAsciiPunct(rest[pos + 1])) { pos += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      pos++;
    }
    if (pos === start) return null;
    href = rest.slice(start, pos).replace(ASCII_PUNCT_RE, '$1');
  }
  // --- title: same line, or the immediately following line; may span lines ---
  let title = null;
  let titleEnd = pos;
  const wsBeforeTitle = pos;
  skipInlineWs();
  const hadWs = pos > wsBeforeTitle;
  if (pos < rest.length && rest[pos] === '\n') {
    // A title may sit on the immediately following line.
    const save = pos;
    pos++;
    skipInlineWs();
    if (pos < rest.length && (rest[pos] === '"' || rest[pos] === "'" || rest[pos] === '(')) {
      const t = parseTitleAt(rest, pos);
      if (t !== null) {
        // After a title only whitespace may remain on its line.
        let q = t.end;
        while (q < rest.length && (rest[q] === ' ' || rest[q] === '\t')) q++;
        if (q >= rest.length || rest[q] === '\n') {
          title = t.title; titleEnd = t.end;
        }
      }
    }
    // A malformed title on the next line is simply not a title: the
    // definition stands without one and the line stays as text.
    if (title === null) pos = save;
  } else if (pos < rest.length && (rest[pos] === '"' || rest[pos] === "'" || rest[pos] === '(')) {
    // A title on the same line must be separated from the destination by
    // whitespace, and must be well-formed; otherwise the definition fails.
    if (!hadWs) return null;
    const t = parseTitleAt(rest, pos);
    if (t === null) return null;
    let q = t.end;
    while (q < rest.length && (rest[q] === ' ' || rest[q] === '\t')) q++;
    if (q < rest.length && rest[q] !== '\n') return null;
    title = t.title; titleEnd = t.end;
  } else if (pos < rest.length) {
    // Junk after the destination on its line: not a definition.
    return null;
  }
  // Lines consumed: label lines + newlines crossed while parsing dest/title.
  const usedRest = rest.slice(0, titleEnd).split('\n').length - 1;
  const used = (labelLine - i + 1) + usedRest;
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

// Whether a paragraph (after its leading ref defs) is a table: first line
// the header, second line a delimiter with the same cell count. Used by
// parseRange to keep table body lines that would otherwise end the
// paragraph (a whitespace-only line containing a tab, or a setext-looking
// line) as rows, matching marked's table body regex, whose blank check is
// /^ *$/ (spaces only) and whose block-start exclusions omit setext.
function tableCandidate(para, refs) {
  let k = 0;
  while (k < para.length) {
    const d = parseRefDef(para, k, refs);
    if (!d) break;
    k += d.used;
  }
  const rest = para.slice(k);
  if (rest.length >= 2 && lineIndent(rest[1]) <= 3) {
    const aligns = isTableDelim(rest[1]);
    if (aligns !== null && aligns.length === splitTableRow(rest[0]).length) return true;
  }
  return false;
}

function readQuote(lines, i, end, refs, blocks) {
  const inner = [];
  let paraOpen = false;
  // Whether the next lazy line opens a fresh chunk (a run of lazy lines
  // followed by '>' lines, in marked's terms). A setext-looking lazy line
  // is neutralized with four spaces unless it opens its chunk.
  let nextLazyOpensChunk = false;
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
      const content = stripColumns(rest.slice(1), 1, ind + 1, true);
      // A '>' line whose content is only spaces is paragraph text while a
      // paragraph is open (marked renders "> foo / >   " as "foo\n "), not
      // a blank line; an empty '>' line is a real blank line.
      inner.push(content !== '' && isBlank(content) && paraOpen ? LAZY + content : content);
      trackFence(content);
      paraOpen = fenceCh === null && deepParaOpen(content);
      nextLazyOpensChunk = true;
      j++;
      continue;
    }
    // A truly blank line (no '>') ends the blockquote; the next '>' line
    // starts a new one. (A '>' line with empty content is NOT blank here.)
    if (isBlank(line)) break;
    if (paraOpen && (!startsBlock(line) || (SETEXT_RE.test(line) && !HR_RE.test(line)))) {
      // Lazy continuation: strip 4 columns if the line is indented >= 4,
      // otherwise keep it verbatim. A whitespace-only lazy line is kept as
      // paragraph text (marked renders "> foo / >   " as "foo\n "). A
      // setext-looking lazy line is neutralized with four spaces unless it
      // opens its chunk (see nextLazyOpensChunk). A line that already
      // carries the LAZY prefix (lazy through an outer container) keeps a
      // single prefix.
      let raw = line.startsWith(LAZY) ? line.slice(LAZY.length) : line;
      let text = lineIndent(raw) >= 4 ? stripColumns(raw, 4) : raw;
      if (isBlank(text)) text = LAZY + text;
      else if (SETEXT_RE.test(text) && !nextLazyOpensChunk) text = LAZY + '    ' + text.replace(/^ {0,3}/, '');
      else text = LAZY + text;
      inner.push(text);
      nextLazyOpensChunk = false;
      j++; continue;
    }
    break;
  }
  const innerParsed = parseRange(inner, 0, inner.length, refs, false);
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
    let paraOpen = !m.empty && deepParaOpen(m.firstContent);
    let sawBlank = false;
    // An empty item followed by a blank line is closed: later lines are not
    // part of it (they belong to the enclosing context).
    let closedEmpty = false;
    let hasContent = !m.empty;
    j++;
    while (j < end) {
      const l = lines[j];
      if (isBlank(l)) {
        // Peek past the blank run: if the next line does not belong to this
        // item (indent below the content indent, and not a new item of this
        // list), the blank line ends the item's content. Leave the blank
        // for the enclosing parse, so a blank between two blocks of the
        // enclosing item is visible there (it loosens the enclosing list).
        let k = j;
        while (k < end && isBlank(lines[k])) k++;
        if (k < end) {
          const nl = lines[k];
          const nind = lineIndent(nl);
          const nm = parseMarker(nl);
          const isNewItem = nm && nm.bullet === first.bullet && nm.delim === first.delim && nind < m.contentIndent;
          if (!isNewItem && nind < m.contentIndent) break;
        }
        if (!hasContent) closedEmpty = true;
        itemLines.push('');
        sawBlank = true;
        paraOpen = false;
        j++;
        continue;
      }
      if (closedEmpty) {
        // An empty item followed by a blank line is closed, but a new item
        // of the same list still starts here — and the blank line between
        // the two items loosens the list.
        const nm0 = parseMarker(l);
        if (nm0 && nm0.bullet === first.bullet && nm0.delim === first.delim && lineIndent(l) < m.contentIndent) {
          if (sawBlank) loose = true;
        }
        break;
      }
      const ind = lineIndent(l);
      if (ind >= m.contentIndent) {
        const stripped = stripColumns(l, m.contentIndent, 0, true);
        itemLines.push(stripped);
        if (stripped !== '') { hasContent = true; sawBlank = false; }
        paraOpen = stripped !== '' && deepParaOpen(stripped);
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
      if (paraOpen && (!startsBlock(l) || (SETEXT_RE.test(l) && !HR_RE.test(l)))) {
        // Lazy continuation of the item's paragraph. A setext-looking lazy
        // line stays paragraph text as-is (the LAZY prefix keeps the inner
        // parse from turning it into a heading); other lazy lines are kept
        // verbatim (minus 4 columns when indented >= 4).
        let raw = l.startsWith(LAZY) ? l.slice(LAZY.length) : l;
        let text = lineIndent(raw) >= 4 ? stripColumns(raw, 4) : raw;
        itemLines.push(LAZY + text);
        j++; continue;
      }
      break;
    }
    // A blank line only loosens the list when it directly separates two
    // items. Blank lines inside a block (a fenced code block, a nested list
    // item) do not count: they are handled by the item's inner parse.
    // (sawBlank -> loose is applied above, at the next item marker.)
    while (itemLines.length && itemLines[itemLines.length - 1] === '') itemLines.pop();
    const inner = parseRange(itemLines, 0, itemLines.length, refs, true);
    if (inner.blankBetween) loose = true;
    items.push({ children: inner.blocks, startNum: m.num });
  }
  blocks.push({ t: 'list', ordered: first.bullet === null, bullet: first.bullet, delim: first.delim, start: first.num === null ? 1 : first.num, tight: !loose, children: items });
  return j;
}

// Parse lines[start..end) into blocks. Returns {blocks, blankBetween}.
// inItem is true when these lines are a list item's content: inside an item,
// an ordered list marker interrupts a paragraph for any start number (marked
// behaviour); at the top level and inside blockquotes only 1 does.
function parseRange(lines, start, end, refs, inItem) {
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
      const b = finalizeParagraph(para, refs);
      // A paragraph that turns out to be only reference definitions still
      // leaves a blank line behind it: in marked that blank line is a space
      // token, and it loosens the enclosing list just like a blank line
      // between two real blocks.
      if (!b && pendingBlank && blocks.length > 0) blankBetween = true;
      pushBlock(b);
      para = null;
    }
  };
  let i = start;
  while (i < end) {
    const line = lines[i];
    // A lazy-continuation line (LAZY prefix): paragraph text, even when it
    // looks like a block start ("- e", "==="). The prefix is stripped here.
    if (line.startsWith(LAZY)) {
      const text = line.slice(LAZY.length);
      if (para) para.push(text);
      else para = [text];
      i++;
      continue;
    }
    // A whitespace-only line ends a paragraph — except inside a table body,
    // where marked's blank check is /^ *$/ (spaces only): a line containing
    // a tab is a (blank) row, not a break.
    if (isBlank(line)) {
      if (para && !/^ *$/.test(line) && tableCandidate(para, refs)) { para.push(line); i++; continue; }
      flushPara(); pendingBlank = true; i++; continue;
    }
    const { cols: ind, rest: content } = splitLeading(line);
    if (para) {
      if (ind <= 3 && SETEXT_RE.test(line)) {
        let k = 0;
        while (k < para.length) {
          const d = parseRefDef(para, k, refs);
          if (!d) break;
          k += d.used;
        }
        const restLines = para.slice(k);
        // A setext-looking line inside a table body is a row (marked's table
        // body exclusions omit setext), not a heading.
        if (restLines.length >= 2 && lineIndent(restLines[1]) <= 3) {
          const aligns = isTableDelim(restLines[1]);
          if (aligns !== null && aligns.length === splitTableRow(restLines[0]).length) { para.push(line); i++; continue; }
        }
        para = null;
        if (restLines.length > 0) {
          // Heading text: first line's leading indent stripped, every line's
          // trailing whitespace stripped, continuation indents kept.
          const hlines = restLines.map((l, idx) => {
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
        // Trailing newline: types 1-5 keep it when the next line is not
        // truly empty (a whitespace-only line does not suppress it — their
        // regexes end with [^\n]*\n*); types 6-7 keep it only when the next
        // line is non-blank (their regexes end at a blank line).
        const hb = htmlBlockStart(line);
        if (hb >= 1 && hb <= 6) { flushPara(); if (pendingBlank && blocks.length > 0) blankBetween = true; i = readHtml(lines, i, end, hb, blocks); blocks[blocks.length - 1].addTrailingNL = i < end && (hb <= 5 ? lines[i].length > 0 : !isBlank(lines[i])); pendingBlank = false; continue; }
        const lm = parseMarker(line);
        if (lm && (lm.bullet !== null || lm.num === 1 || (inItem && lm.num !== null)) && !lm.empty) { flushPara(); if (pendingBlank && blocks.length > 0) blankBetween = true; i = readList(lines, i, end, refs, blocks); pendingBlank = false; continue; }
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
      if (hb > 0) { if (pendingBlank && blocks.length > 0) blankBetween = true; i = readHtml(lines, i, end, hb, blocks); blocks[blocks.length - 1].addTrailingNL = i < end && (hb <= 5 ? lines[i].length > 0 : !isBlank(lines[i])); pendingBlank = false; continue; }
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
  return parseRange(lines, 0, lines.length, refs, false);
}

// ---------------- rendering ----------------

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
    if (c.t === 'paragraph' && tight) {
      // In a tight list every paragraph renders without <p> wrappers,
      // not just the first one (marked's text tokens stay text tokens).
      inner += (k === 0 ? checkbox : '') + renderInline(c.lines.join('\n'), refs);
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
