/*
 * COSMIC EARL — pure fortune logic, no DOM.
 * Loaded by the browser as window.EarlCore and by Node tests via require().
 *
 * Owns: question normalize/tokenize, keyword-overlap + light fuzzy scoring vs
 * the corpus (src/fortunes.js / window.EarlFortunes), a THRESHOLD that routes
 * weak matches to a mystical DEFLECTION card, a SAFETY GATE keyword pre-filter
 * that FORCES deflection for the medical/dosing/legal class regardless of score,
 * the card model (deterministic card number per entry, golden flag, deck /
 * collection formatting), and the share text.
 *
 * The matcher is deterministic + side-effect-free: same corpus + same question
 * always yields the same card. The shell only renders what match() returns.
 *
 * ── THE SEAM the shell consumes ───────────────────────────────────────────
 *   EarlCore.THRESHOLD                                 (min score to accept)
 *   EarlCore.normalize(text) / EarlCore.tokenize(text) (text → tokens)
 *   EarlCore.isSafetyQuestion(text) → bool             (the safety gate)
 *   EarlCore.score(tokens, entry) → number             (one entry's score)
 *   EarlCore.match(question, fortunes?) → {
 *       entry,            // the chosen corpus entry (or the deflection entry)
 *       deflect,          // true when this is a deflection card
 *       reason,           // 'match' | 'low-score' | 'safety' | 'empty'
 *       score,            // best raw score (0 when nothing scored)
 *       query             // the normalized query string
 *   }
 *   EarlCore.cardNumber(entry, fortunes) → 1-based stable index
 *   EarlCore.buildCard(result, fortunes) → full card model for the shell
 *   EarlCore.formatDeck(deckIds, fortunes) → { collected, total, entries[] }
 *   EarlCore.shareText(card) → string
 *   EarlCore.DECK_KEY                                  (localStorage key)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      typeof require === 'function' ? require('./fortunes.js') : null
    );
  } else {
    root.EarlCore = factory(root.EarlFortunes);
  }
})(typeof self !== 'undefined' ? self : this, function (Fortunes) {
  'use strict';

  // ── Constants ───────────────────────────────────────────────────────
  // Min score for match() to accept an entry. Below this → deflection.
  // Tuned so a single shared keyword can land a clear match, but pure
  // gibberish (no shared tokens) always falls through to the mystic card.
  var THRESHOLD = 1.0;
  var DECK_KEY = 'cosmic.earl.deck';     // localStorage key for collected ids
  var GOLDEN_CODE = (Fortunes && Fortunes.GOLDEN_CODE) || 'EARL420';
  var DEFLECT_CATEGORY = 'safety';

  // Fuzzy bonus: a query token that is a near-miss of a keyword (shared
  // prefix or one is a substring of the other) earns a partial point.
  var FUZZY_WEIGHT = 0.5;
  var EXACT_WEIGHT = 1.0;
  var MIN_FUZZY_LEN = 4;     // only fuzz tokens of real length (avoid 'a','to')

  // ── SAFETY GATE — the non-negotiable medical/dosing/legal pre-filter ──
  // ANY question whose tokens hit this class is FORCED to a deflection card,
  // regardless of keyword score. This is defense-in-depth on top of the
  // deflect:true entries in the corpus: even an unflagged near-miss
  // ("what dosage", "interact with my meds", "legal in my state") deflects.
  //
  // Two-tier:
  //   SAFETY_TERMS  — single tokens that alone signal the class
  //   SAFETY_PAIRS  — token pairs that only signal the class together
  //                   (e.g. "how much", "how many") so a benign "how do I
  //                   order" is NOT swept up by the bare word "how".
  var SAFETY_TERMS = [
    'dose', 'dosage', 'doses', 'dosing', 'milligram', 'milligrams', 'mg',
    'overdose', 'medical', 'medicine', 'medication', 'medications', 'meds',
    'prescription', 'pills', 'interaction', 'interactions', 'interact',
    'pregnant', 'pregnancy', 'breastfeeding', 'nursing',
    'legal', 'legally', 'illegal', 'legality', 'lawful',
    'overdid', 'greenout', 'drive', 'driving', 'impaired',
    // medical-symptom / health-claim class — "will this help my X"
    'anxiety', 'anxious', 'depression', 'depressed', 'insomnia', 'sleep',
    'pain', 'cure', 'heal', 'symptom', 'symptoms', 'condition',
    'diagnosis', 'treat', 'treatment', 'therapeutic', 'nausea', 'ptsd'
  ];
  var SAFETY_PAIRS = [
    ['how', 'much'], ['how', 'many'],
    ['too', 'much'],
    ['interact', 'with'], ['mix', 'with'],
    ['my', 'state'], ['my', 'meds'], ['my', 'medication'],
    ['fly', 'with'], ['travel', 'with'], ['carry', 'across']
  ];

  // ── Normalize / tokenize ────────────────────────────────────────────
  // Lowercase, strip punctuation to spaces (keeps numbers like 420 / 21),
  // collapse whitespace. Deterministic and ASCII-safe.
  function normalize(text) {
    if (text == null) return '';
    var s = String(text).toLowerCase();
    // Glue the cannabis-culture time "4:20" / "4 20" into one token "420"
    // BEFORE punctuation stripping, so the is-it-420 card matches it.
    s = s.replace(/\b4[:\s]?20\b/g, '420');
    // turn anything that's not a letter or digit into a space
    s = s.replace(/[^a-z0-9]+/g, ' ');
    // collapse + trim
    s = s.replace(/\s+/g, ' ').replace(/^ /, '').replace(/ $/, '');
    return s;
  }

  // Tiny stopword set so common filler doesn't dominate scoring. Kept
  // small on purpose: 'how', 'much', 'many', 'with', 'my' stay IN because
  // the safety pairs need them — scoring just weights real keywords higher.
  var STOPWORDS = {
    a: 1, an: 1, the: 1, is: 1, are: 1, am: 1, do: 1, does: 1, did: 1,
    i: 1, you: 1, it: 1, of: 1, on: 1, in: 1, at: 1, and: 1, or: 1,
    for: 1, this: 1, that: 1, be: 1, can: 1, will: 1
  };

  function tokenize(text) {
    var norm = normalize(text);
    if (!norm) return [];
    var raw = norm.split(' ');
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      if (raw[i] && !STOPWORDS[raw[i]]) out.push(raw[i]);
    }
    return out;
  }

  // ── Safety gate ─────────────────────────────────────────────────────
  // Returns true if the question belongs to the medical/dosing/legal class
  // and MUST deflect. Uses ALL normalized tokens (including stopwords) so
  // the pairs ("how much") still resolve.
  function rawTokens(text) {
    var norm = normalize(text);
    return norm ? norm.split(' ') : [];
  }
  function hasTerm(tokens, term) {
    for (var i = 0; i < tokens.length; i++) if (tokens[i] === term) return true;
    return false;
  }
  function hasPair(tokens, a, b) {
    var sawA = false, sawB = false;
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i] === a) sawA = true;
      if (tokens[i] === b) sawB = true;
    }
    return sawA && sawB;
  }
  function isSafetyQuestion(text) {
    var toks = rawTokens(text);
    if (!toks.length) return false;
    var i;
    for (i = 0; i < SAFETY_TERMS.length; i++) {
      if (hasTerm(toks, SAFETY_TERMS[i])) return true;
    }
    for (i = 0; i < SAFETY_PAIRS.length; i++) {
      if (hasPair(toks, SAFETY_PAIRS[i][0], SAFETY_PAIRS[i][1])) return true;
    }
    return false;
  }

  // ── Fuzzy token compare ─────────────────────────────────────────────
  // A cheap, deterministic near-miss check (no Levenshtein needed for v1):
  // either token contains the other, OR they share a >=4-char prefix.
  // Both must be reasonably long so short words don't fuzz into everything.
  function fuzzyMatch(a, b) {
    if (a === b) return false;             // exact handled separately
    if (a.length < MIN_FUZZY_LEN || b.length < MIN_FUZZY_LEN) return false;
    if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return true;
    var n = Math.min(a.length, b.length, 5);
    if (n < 4) return false;
    return a.slice(0, n) === b.slice(0, n);
  }

  // ── Score one entry against the query tokens ────────────────────────
  // Exact keyword overlap is worth EXACT_WEIGHT; a fuzzy near-miss is worth
  // FUZZY_WEIGHT. Each query token contributes at most once (its best hit),
  // so repeated words can't inflate a score. Deterministic, order-stable.
  function score(queryTokens, entry) {
    if (!entry || !entry.keywords || !entry.keywords.length) return 0;
    var kw = entry.keywords;
    var total = 0;
    for (var q = 0; q < queryTokens.length; q++) {
      var qt = queryTokens[q];
      var best = 0;
      for (var k = 0; k < kw.length; k++) {
        var key = kw[k];
        if (qt === key) { best = EXACT_WEIGHT; break; }
        if (fuzzyMatch(qt, key) && FUZZY_WEIGHT > best) best = FUZZY_WEIGHT;
      }
      total += best;
    }
    return total;
  }

  // Resolve the corpus to use: explicit arg → injected Fortunes → fail soft.
  function resolveCorpus(fortunes) {
    if (fortunes && fortunes.length) return fortunes;
    if (Fortunes && Fortunes.FORTUNES) return Fortunes.FORTUNES;
    return [];
  }

  // The deflection entry to fall back to. Prefer the generic dosing card
  // (id 'deflect-dosing'); otherwise the first deflect entry; otherwise a
  // synthesized mystic card so the shell never gets null.
  function deflectionEntry(corpus) {
    var i, preferred = null, firstDeflect = null;
    for (i = 0; i < corpus.length; i++) {
      if (corpus[i].deflect) {
        if (!firstDeflect) firstDeflect = corpus[i];
        if (corpus[i].id === 'deflect-dosing') preferred = corpus[i];
      }
    }
    if (preferred) return preferred;
    if (firstDeflect) return firstDeflect;
    return {
      id: 'deflect-mystic',
      keywords: [],
      question: 'The smoke is too thick on that one.',
      answer: 'Cosmic Earl can\'t read that one clearly, friend — the smoke\'s ' +
        'too thick. For a real answer, our budtenders are always here to help.',
      earl: 'Some questions drift past even me, friend — ask a budtender, they\'ve got clearer eyes than my crystal ball.',
      category: DEFLECT_CATEGORY,
      deflect: true
    };
  }

  // ── match(): the public matcher ─────────────────────────────────────
  // Returns { entry, deflect, reason, score, query }. NEVER null.
  //  reason: 'safety'    → forced by the medical/dosing/legal gate
  //          'empty'     → blank/no usable tokens → mystic deflection
  //          'low-score' → best score below THRESHOLD → mystic deflection
  //          'match'     → a real corpus entry won
  function match(question, fortunes) {
    var corpus = resolveCorpus(fortunes);
    var query = normalize(question);

    // SAFETY GATE FIRST — non-negotiable. Even a high-scoring benign-looking
    // phrasing deflects if it carries the dosing/medical/legal signal.
    if (isSafetyQuestion(question)) {
      // Pick the best-scoring DEFLECT entry so the card is on-topic
      // (dosing question → dosing card, legal question → legal card).
      var qTok = tokenize(question);
      var bestDef = null, bestDefScore = -1;
      for (var d = 0; d < corpus.length; d++) {
        if (!corpus[d].deflect) continue;
        var sc = score(qTok, corpus[d]);
        if (sc > bestDefScore) { bestDefScore = sc; bestDef = corpus[d]; }
      }
      return {
        entry: bestDef || deflectionEntry(corpus),
        deflect: true,
        reason: 'safety',
        score: bestDefScore < 0 ? 0 : bestDefScore,
        query: query
      };
    }

    var tokens = tokenize(question);
    if (!tokens.length) {
      return {
        entry: deflectionEntry(corpus),
        deflect: true,
        reason: 'empty',
        score: 0,
        query: query
      };
    }

    // Score every NON-deflect entry; deflect entries are reachable only via
    // the safety gate, never by ordinary matching (keeps them on-topic).
    var best = null, bestScore = -1;
    for (var i = 0; i < corpus.length; i++) {
      if (corpus[i].deflect) continue;
      var s = score(tokens, corpus[i]);
      // strictly-greater keeps the FIRST corpus entry on ties → deterministic
      if (s > bestScore) { bestScore = s; best = corpus[i]; }
    }

    if (!best || bestScore < THRESHOLD) {
      return {
        entry: deflectionEntry(corpus),
        deflect: true,
        reason: 'low-score',
        score: bestScore < 0 ? 0 : bestScore,
        query: query
      };
    }

    return {
      entry: best,
      deflect: !!best.deflect,
      reason: 'match',
      score: bestScore,
      query: query
    };
  }

  // ── Card model ──────────────────────────────────────────────────────
  // Deterministic 1-based card number = the entry's position in the corpus.
  // Stable as long as the corpus order is stable, so a collected deck stays
  // meaningful across sessions (deck stores ids, not numbers, anyway).
  function cardNumber(entry, fortunes) {
    var corpus = resolveCorpus(fortunes);
    if (!entry) return 0;
    for (var i = 0; i < corpus.length; i++) {
      if (corpus[i].id === entry.id) return i + 1;
    }
    return 0;
  }

  // Deterministic "lucky numbers" derived from the entry id — pure flavor,
  // stable per card so the same card always shows the same numbers. Three
  // numbers in 1..40 (no real-world meaning; the universe is into hydration).
  function luckyNumbers(entry) {
    var seed = 0, id = (entry && entry.id) || '';
    for (var i = 0; i < id.length; i++) {
      seed = (seed * 31 + id.charCodeAt(i)) % 1000000007;
    }
    var out = [];
    var s = seed || 7;
    while (out.length < 3) {
      s = (s * 16807 + 17) % 2147483647;
      var n = (s % 40) + 1;
      if (out.indexOf(n) === -1) out.push(n);
    }
    return out;
  }

  // Build the full card model the shell renders. Pure: derives everything
  // from the match result + corpus, no I/O.
  function buildCard(result, fortunes) {
    var corpus = resolveCorpus(fortunes);
    var entry = (result && result.entry) || deflectionEntry(corpus);
    var deflect = !!(result && result.deflect) || !!entry.deflect;
    var golden = !deflect && !!entry.golden;   // deflect cards are NEVER golden
    return {
      id: entry.id,
      number: cardNumber(entry, corpus),
      total: corpus.length,
      question: entry.question,
      answer: entry.answer,
      earl: entry.earl,
      category: entry.category,
      deflect: deflect,
      golden: golden,
      code: golden ? GOLDEN_CODE : null,
      lucky: luckyNumbers(entry),
      reason: (result && result.reason) || 'match'
    };
  }

  // ── Deck / collection model ─────────────────────────────────────────
  // The deck persists discovered card ids in localStorage (shell owns I/O;
  // core only formats + de-dupes). Deflection cards are collectible too, but
  // a shell may choose to exclude the synthesized mystic fallback.
  function formatDeck(deckIds, fortunes) {
    var corpus = resolveCorpus(fortunes);
    var have = {};
    var i;
    if (deckIds && deckIds.length) {
      for (i = 0; i < deckIds.length; i++) have[deckIds[i]] = true;
    }
    var entries = [];
    var collected = 0;
    for (i = 0; i < corpus.length; i++) {
      var e = corpus[i];
      var got = have[e.id] === true;
      if (got) collected += 1;
      entries.push({
        id: e.id,
        number: i + 1,
        question: e.question,
        category: e.category,
        golden: !!e.golden,
        deflect: !!e.deflect,
        collected: got
      });
    }
    return { collected: collected, total: corpus.length, entries: entries };
  }

  // Add an id to a deck array (de-duped, order-preserving). Returns the new
  // array + whether it was newly discovered — shell decides on persistence.
  function addToDeck(deckIds, id) {
    var list = (deckIds || []).slice();
    var isNew = list.indexOf(id) === -1;
    if (isNew) list.push(id);
    return { deck: list, isNew: isNew };
  }

  // ── Share text (copy-to-clipboard summary) ──────────────────────────
  function shareText(card) {
    card = card || {};
    var lines = ['🔮 COSMIC EARL says:'];
    if (card.question) lines.push('“' + card.question + '”');
    if (card.earl) lines.push('— ' + card.earl);
    if (card.golden && card.code) {
      lines.push('✨ GOLDEN CARD · code ' + card.code);
    }
    if (card.number && card.total) {
      lines.push('🃏 Card #' + card.number + '/' + card.total);
    }
    lines.push('Ask Cosmic Earl · onlinebudshop.com');
    return lines.join('\n');
  }

  // ── Corpus validation (used by tests + handy in shell dev) ──────────
  // Returns an array of human-readable problems; empty array = clean.
  function validateFortune(entry) {
    var errs = [];
    var where = (entry && entry.id) ? entry.id : '<no id>';
    function bad(msg) { errs.push(where + ': ' + msg); }
    if (!entry || typeof entry !== 'object') return ['fortune is not an object'];
    if (!entry.id || typeof entry.id !== 'string') bad('missing string id');
    if (!(entry.keywords instanceof Array) || entry.keywords.length === 0) {
      bad('keywords must be a non-empty array');
    } else {
      for (var k = 0; k < entry.keywords.length; k++) {
        if (typeof entry.keywords[k] !== 'string' || !entry.keywords[k]) {
          bad('keyword[' + k + '] must be a non-empty string');
        } else if (entry.keywords[k] !== entry.keywords[k].toLowerCase()) {
          bad('keyword "' + entry.keywords[k] + '" must be lowercase');
        }
      }
    }
    if (!entry.question || typeof entry.question !== 'string') bad('missing string question');
    if (!entry.answer || typeof entry.answer !== 'string') bad('missing string answer');
    if (!entry.earl || typeof entry.earl !== 'string') bad('missing string earl');
    if (entry.earl && entry.earl.length > 140) {
      bad('earl line over 140 chars (' + entry.earl.length + ')');
    }
    if (!entry.category || typeof entry.category !== 'string') bad('missing string category');
    if (typeof entry.deflect !== 'boolean') bad('deflect must be a boolean');
    if (entry.golden !== undefined && typeof entry.golden !== 'boolean') {
      bad('golden must be a boolean when present');
    }
    if (entry.deflect && entry.golden) bad('a deflect card must not be golden');
    return errs;
  }

  function validateCorpus(corpus) {
    var errs = [];
    if (!(corpus instanceof Array) || corpus.length === 0) {
      return ['corpus must be a non-empty array'];
    }
    var seen = {};
    for (var i = 0; i < corpus.length; i++) {
      var e = corpus[i];
      if (e && e.id) {
        if (seen[e.id]) errs.push('duplicate id "' + e.id + '"');
        seen[e.id] = true;
      }
      errs = errs.concat(validateFortune(e));
    }
    return errs;
  }

  return {
    // constants / seam
    THRESHOLD: THRESHOLD,
    DECK_KEY: DECK_KEY,
    GOLDEN_CODE: GOLDEN_CODE,
    DEFLECT_CATEGORY: DEFLECT_CATEGORY,
    FUZZY_WEIGHT: FUZZY_WEIGHT,
    EXACT_WEIGHT: EXACT_WEIGHT,
    SAFETY_TERMS: SAFETY_TERMS,
    SAFETY_PAIRS: SAFETY_PAIRS,
    // text
    normalize: normalize,
    tokenize: tokenize,
    rawTokens: rawTokens,
    // matching
    isSafetyQuestion: isSafetyQuestion,
    fuzzyMatch: fuzzyMatch,
    score: score,
    match: match,
    deflectionEntry: deflectionEntry,
    // card model
    cardNumber: cardNumber,
    luckyNumbers: luckyNumbers,
    buildCard: buildCard,
    // deck
    formatDeck: formatDeck,
    addToDeck: addToDeck,
    // share
    shareText: shareText,
    // validation
    validateFortune: validateFortune,
    validateCorpus: validateCorpus
  };
});
