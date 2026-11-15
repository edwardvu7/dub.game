'use strict';
// Text the fast speech model reads correctly. ElevenLabs turns text normalization off for Flash to
// keep it fast, so "Dr.", "3:45" or "$20" can come out wrong. Plain rules, no AI: well under a
// millisecond per line. Only the text sent to Flash changes; the cache key keeps the original line.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0..999999 in words ("one hundred twenty-three"); larger numbers are left as digits. */
function words(n) {
  if (!Number.isInteger(n) || n < 0 || n > 999999) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + words(n % 100) : '');
  return words(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + words(n % 1000) : '');
}

const ORDINAL = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
function ordinal(n) {
  const w = words(n);
  const last = w.split(/[ -]/).pop();
  const head = w.slice(0, w.length - last.length);
  if (ORDINAL[last]) return head + ORDINAL[last];
  if (last.endsWith('y')) return head + last.slice(0, -1) + 'ieth';
  return w + 'th';
}

const TITLES = { 'Dr.': 'Doctor', 'Mr.': 'Mister', 'Mrs.': 'Missus', 'Ms.': 'Miz', 'Prof.': 'Professor',
  'Jr.': 'Junior', 'Sr.': 'Senior', 'vs.': 'versus', 'etc.': 'et cetera', 'e.g.': 'for example', 'i.e.': 'that is' };

function speakable(text) {
  let t = String(text);
  for (const [abbr, full] of Object.entries(TITLES)) {
    t = t.replace(new RegExp('(^|[\\s(])' + abbr.replace(/\./g, '\\.') + '(?=\\s|$)', 'g'), '$1' + full);
  }
  // 3:45 -> three forty-five; 3:05 -> three oh five; 3:00 -> three o'clock (am/pm kept as letters)
  t = t.replace(/\b(\d{1,2}):(\d{2})\b/g, (m, h, mm) => {
    const H = Number(h), M = Number(mm);
    if (H > 24 || M > 59) return m;
    return words(H) + (M === 0 ? " o'clock" : M < 10 ? ' oh ' + words(M) : ' ' + words(M));
  });
  t = t.replace(/\b([ap])\.?m\.?(?=\W|$)/gi, (m, x) => x.toUpperCase() + ' M');
  // $20 -> twenty dollars; $1.50 -> one dollar fifty
  t = t.replace(/\$(\d{1,6})(?:\.(\d{2}))?\b/g, (m, d, c) => {
    const D = Number(d);
    const out = words(D) + (D === 1 ? ' dollar' : ' dollars');
    return c && Number(c) ? out + ' ' + words(Number(c)) : out;
  });
  t = t.replace(/\b(\d{1,6})%/g, (m, n) => words(Number(n)) + ' percent');
  t = t.replace(/\b(\d{1,6})(st|nd|rd|th)\b/gi, (m, n) => ordinal(Number(n)));
  t = t.replace(/(\s)&(\s)/g, '$1and$2');
  // Plain whole numbers. Years like 1999 read better as "nineteen ninety-nine".
  t = t.replace(/\b\d{1,6}\b/g, (m) => {
    const n = Number(m);
    if (m.length === 4 && n >= 1100 && n <= 1999) return words(Math.floor(n / 100)) + ' ' + (n % 100 ? (n % 100 < 10 ? 'oh ' : '') + words(n % 100) : 'hundred');
    if (m.length > 1 && m[0] === '0') return m.split('').map((d) => ONES[Number(d)]).join(' '); // codes like 007
    return words(n);
  });
  return t;
}

module.exports = { speakable, words, ordinal };
