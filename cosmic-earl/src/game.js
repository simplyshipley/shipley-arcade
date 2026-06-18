/*
 * COSMIC EARL — canvas shell. Renders the cel-cartoon fortune-machine CABINET,
 * animates Cosmic Earl (idle sway / awake-riff / thinking beat), drives the
 * screens (attract → ask → thinking → card), paints the dispensed fortune CARD
 * (three zones + golden + deflection variants), tracks the deck counter, and
 * wires the on-screen <input> + popular-question chips + SAVE/COPY/AGAIN.
 *
 * ALL matching + card rules live in src/core.js (window.EarlCore) + the corpus
 * in src/fortunes.js (window.EarlFortunes). This file only renders the core's
 * verdict and feeds it the player's question. It NEVER re-derives the matcher,
 * the threshold, the safety-deflection routing, or the card numbering — it
 * calls EarlCore.match() → EarlCore.buildCard() and renders the card model.
 *
 * Loaded by the browser after fortunes.js + core.js, then touch-controls.js.
 * Exposes window.__EARL for the headless vm test harness (test/shell.test.js).
 *
 * Style: vanilla ES5, no build step, no dependencies. Browser globals
 * (EarlCore / EarlFortunes), but written defensively so the vm harness can boot
 * it with a stubbed window/document/canvas + a stub <input>. If the logic core
 * has not loaded yet (parallel build / standalone test), a tiny inline FALLBACK
 * mirrors the pinned seam EXACTLY (same globals, methods, fields, return
 * shapes) so the shell still boots and the shell test runs standalone — the
 * fallback is the seam contract restated, not a second implementation.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE SEAM the shell consumes (mirrored from core.js / fortunes.js headers):
 *
 *   window.EarlFortunes.FORTUNES : [ {                                 (corpus)
 *       id, keywords:[..], question, answer, earl, category,
 *       deflect:bool, golden?:bool, chip?:bool } , ... ]
 *   window.EarlFortunes.GOLDEN_CODE : String  (the placeholder discount code)
 *   window.EarlFortunes.chips()     → [entry,...]  (popular-question chips)
 *
 *   EarlCore.THRESHOLD          : Number  (min score for a real match)
 *   EarlCore.DECK_KEY           : String  (localStorage key, collected ids)
 *
 *   EarlCore.match(question, fortunes) → {
 *       entry,    // chosen corpus entry OR the deflection entry (NEVER null)
 *       deflect,  // true → deflection card. ALWAYS true for medical/dosing/
 *                 //   legal (the safety routing) AND when below threshold.
 *       reason,   // 'match' | 'low-score' | 'safety' | 'empty'
 *       score, query }
 *
 *   EarlCore.buildCard(result, fortunes) → {                       (card model)
 *       id, number, total, question, answer, earl, category,
 *       deflect:bool, golden:bool, code:String|null, lucky:[n,n,n], reason }
 *     A deflection card has golden:false + code:null + an answer with NO digits
 *     (no dose/amount leaked). The shell adds ONLY non-deflect cards to the deck.
 *
 *   EarlCore.cardNumber(entry, fortunes) → 1-based stable index (entry id order)
 *   EarlCore.luckyNumbers(entry)         → [n,n,n]
 *   EarlCore.formatDeck(deckIds, fortunes) → { collected, total, entries[] }
 *   EarlCore.addToDeck(deckIds, id)        → { deck:[ids], isNew:bool }
 *   EarlCore.shareText(card)               → String  (copy/share summary)
 *
 * The deck is a list of collected entry IDS, persisted as JSON under DECK_KEY.
 *
 * Art: Scooby-Doo x Bob's-Burgers cel-cartoon — flat fills, 3px #1d1d28
 * outlines, big friendly Earl, warm neon-arcade palette. Procedural.
 * ════════════════════════════════════════════════════════════════════════
 */
(function (root) {
  'use strict';

  // ════════════════════════════════════════════════════════════════════
  //  FALLBACK CORPUS — mirrors window.EarlFortunes. Used ONLY when the real
  //  src/fortunes.js has not defined it (parallel build / standalone test).
  //  A tiny brand-safe slice; the real ~40-entry corpus lives in fortunes.js.
  //  EVERY string here obeys the guardrails: no profanity, no real-person
  //  names, no dosing/medical advice. Deflect entries carry NO answer digits.
  // ════════════════════════════════════════════════════════════════════
  function buildFallbackFortunes() {
    var GOLDEN_CODE = 'EARL420';
    var FORTUNES = [
      { id: 'how-to-order', keywords: ['order', 'buy', 'purchase', 'checkout', 'cart', 'shop', 'online'],
        question: 'How do I place an order?',
        answer: 'Browse the menu, tap what speaks to you, add it to your cart, and check out — we confirm and get it moving.',
        earl: 'The order finds you when you stop reaching for it, friend. Tap, breathe, the little bag arrives.',
        category: 'ordering', deflect: false, chip: true },
      { id: 'delivery-how', keywords: ['delivery', 'deliver', 'ship', 'shipping', 'bring', 'driver', 'doorstep', 'work', 'works'],
        question: 'How does delivery work?',
        answer: 'Pop in your address at checkout — if you are in our zone, a driver brings it to your door. Have a 21+ ID ready.',
        earl: 'Everything travels to meet you eventually, man — some of it just shows up in a little bag.',
        category: 'ordering', deflect: false, chip: true },
      { id: 'payment', keywords: ['pay', 'payment', 'cash', 'card', 'credit', 'debit', 'money'],
        question: 'What payment methods do you accept?',
        answer: 'Cash and the debit options shown at checkout. Bring a little extra for your driver — they earn it.',
        earl: 'Money is just energy passing through, friend... the shop smiles either way.',
        category: 'ordering', deflect: false, chip: true },
      { id: 'hours', keywords: ['hours', 'open', 'close', 'closing', 'when', 'time'],
        question: 'What are your hours?',
        answer: 'Open daily — check onlinebudshop.com for the exact hours in your area, they shift a little by location.',
        earl: 'Time is a river, friend... the shop opens when the sun says howdy and rests when the moon winks.',
        category: 'store', deflect: false, chip: true },
      { id: 'age-21', keywords: ['age', 'old', '21', 'id', 'identification', 'minor', 'young'],
        question: 'How old do I have to be to shop?',
        answer: 'Twenty-one and up, always. Keep a valid government photo ID handy for every order and handoff.',
        earl: 'Patience, young traveler — the mountain waits twenty-one summers before it shares its smoke.',
        category: 'store', deflect: false, chip: true },
      { id: 'sativa-indica', keywords: ['sativa', 'indica', 'hybrid', 'strain', 'difference', 'energizing'],
        question: 'What is the difference between sativa, indica, and hybrid?',
        answer: 'Folks describe sativas as brighter daytime, indicas as cozier, hybrids in between. A budtender can match your vibe.',
        earl: 'Sativa is the sunrise, indica is the hammock, and the hybrid is the porch in between, man.',
        category: 'product', deflect: false, chip: true },
      { id: 'meaning', keywords: ['meaning', 'life', 'universe', 'purpose', 'point', 'everything'],
        question: 'What is the meaning of life?',
        answer: 'Be kind, stay curious, and water your plants. That is most of it, honestly.',
        earl: 'The meaning, friend, is the looking. Really it is just being here, breathing slow.',
        category: 'fun', deflect: false },
      { id: 'deals', keywords: ['deal', 'deals', 'discount', 'sale', 'coupon', 'loyalty', 'cheap', 'code'],
        question: 'Do you have any deals?',
        answer: 'We run rotating specials and a loyalty perk — check onlinebudshop.com for what is live this week.',
        earl: 'The universe loves a giver, friend... a little luck just floated your way.',
        category: 'store', deflect: false, golden: true },
      // ── DEFLECT class: medical / dosing / legal → ALWAYS a deflection ──
      // Deflect answers carry NO digits (no dose/amount can leak).
      { id: 'deflect-dosing', keywords: ['dose', 'dosage', 'much', 'take', 'amount', 'strong', 'many'],
        question: 'How much should I take?',
        answer: 'Cosmic Earl cannot read that one clearly, friend — the smoke is too thick. Ask a real budtender at onlinebudshop.com; they will steer you right.',
        earl: 'Some roads I cannot read in the haze, man... walk that one to a budtender who knows your sky.',
        category: 'safety', deflect: true },
      { id: 'deflect-medical', keywords: ['medical', 'medicine', 'doctor', 'health', 'cure', 'pain', 'sleep', 'anxiety', 'help', 'treat', 'condition'],
        question: 'Can this help with how I feel?',
        answer: 'That is beyond Earl, friend. For anything about how you feel or your health, talk to a real budtender or your doctor.',
        earl: 'My crystal ball stays out of the doctor business, man — kinder folks than me are made for that.',
        category: 'safety', deflect: true },
      { id: 'deflect-legal', keywords: ['legal', 'law', 'illegal', 'arrest', 'cops', 'travel', 'fly', 'state', 'border', 'allowed'],
        question: 'Is it legal where I am?',
        answer: 'The law shifts from place to place, friend — Earl will not guess it. Check your local rules and ask a budtender.',
        earl: 'Every sky has its own weather, man... read your local one before you wander.',
        category: 'safety', deflect: true }
    ];
    function byId(id) { for (var i = 0; i < FORTUNES.length; i++) if (FORTUNES[i].id === id) return FORTUNES[i]; return null; }
    function chips() { var o = []; for (var i = 0; i < FORTUNES.length; i++) if (FORTUNES[i].chip) o.push(FORTUNES[i]); return o; }
    function deflectEntries() { var o = []; for (var i = 0; i < FORTUNES.length; i++) if (FORTUNES[i].deflect) o.push(FORTUNES[i]); return o; }
    function goldenEntries() { var o = []; for (var i = 0; i < FORTUNES.length; i++) if (FORTUNES[i].golden) o.push(FORTUNES[i]); return o; }
    return {
      GOLDEN_CODE: GOLDEN_CODE, CATEGORIES: ['ordering', 'store', 'product', 'fun', 'safety'],
      FORTUNES: FORTUNES, byId: byId, chips: chips,
      deflectEntries: deflectEntries, goldenEntries: goldenEntries
    };
  }

  // ════════════════════════════════════════════════════════════════════
  //  FALLBACK LOGIC CORE — mirrors window.EarlCore EXACTLY. Same method
  //  names, fields, return shapes. The threshold + safety routing + card
  //  model here is the seam contract restated; the real implementation lives
  //  in src/core.js. match() ALWAYS returns a non-null entry; the safety gate
  //  forces deflection for the medical/dosing/legal class regardless of score.
  // ════════════════════════════════════════════════════════════════════
  function buildFallbackCore(Fortunes) {
    var THRESHOLD = 1.0;
    var DECK_KEY = 'cosmic.earl.deck';
    var GOLDEN_CODE = (Fortunes && Fortunes.GOLDEN_CODE) || 'EARL420';
    var DEFLECT_CATEGORY = 'safety';
    // Safety gate: ANY of these tokens (or a dose-asking phrase) forces a
    // deflection, even on a strong benign-looking match.
    var SAFETY_TERMS = {
      'dose': 1, 'dosage': 1, 'doses': 1, 'mg': 1, 'milligram': 1, 'milligrams': 1,
      'overdose': 1, 'medical': 1, 'medicine': 1, 'doctor': 1, 'prescription': 1,
      'cure': 1, 'cures': 1, 'treat': 1, 'treatment': 1, 'diagnose': 1, 'disease': 1,
      'illness': 1, 'condition': 1, 'interaction': 1, 'interactions': 1, 'pregnant': 1,
      'legal': 1, 'illegal': 1, 'arrest': 1, 'arrested': 1, 'law': 1, 'laws': 1, 'lawyer': 1
    };
    // Accept a raw array OR the { FORTUNES } wrapper (mirrors core.js exactly).
    function resolveCorpus(fortunes) {
      if (fortunes && fortunes.length) return fortunes;
      if (Fortunes && Fortunes.FORTUNES) return Fortunes.FORTUNES;
      return [];
    }
    var STOP = { 'the': 1, 'a': 1, 'an': 1, 'is': 1, 'are': 1, 'do': 1, 'does': 1,
      'i': 1, 'you': 1, 'to': 1, 'of': 1, 'and': 1, 'my': 1, 'me': 1, 'it': 1,
      'in': 1, 'on': 1, 'for': 1, 'can': 1, 'be': 1, 'at': 1, 'your': 1 };
    function normalize(str) {
      return String(str == null ? '' : str).toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    }
    function rawTokens(str) { var n = normalize(str); return n ? n.split(' ') : []; }
    function tokenize(str) {
      var raw = rawTokens(str), out = [];
      for (var i = 0; i < raw.length; i++) if (raw[i] && !STOP[raw[i]]) out.push(raw[i]);
      return out;
    }
    function isSafetyQuestion(question) {
      var norm = normalize(question);
      if (/\bhow much\b/.test(norm) || /\bhow many\b/.test(norm) ||
          /\bhow strong\b/.test(norm) || /\bshould i take\b/.test(norm)) return true;
      var toks = rawTokens(question);
      for (var i = 0; i < toks.length; i++) if (SAFETY_TERMS[toks[i]]) return true;
      return false;
    }
    function fuzzyMatch(a, b) {
      if (a === b) return true;
      if (a.length < 4 || b.length < 4) return false;
      return a.indexOf(b) !== -1 || b.indexOf(a) !== -1;
    }
    function score(tokens, entry) {
      var kw = entry.keywords || [], total = 0;
      for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i], hit = 0;
        for (var j = 0; j < kw.length; j++) {
          if (t === kw[j]) { hit = 1.0; break; }
          if (fuzzyMatch(t, kw[j])) hit = Math.max(hit, 0.5);
        }
        total += hit;
      }
      return total;
    }
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
      return { id: 'deflect-mystic', keywords: [], question: 'The smoke is too thick on that one.',
        answer: 'Cosmic Earl cannot read that one clearly, friend — ask a budtender at onlinebudshop.com.',
        earl: 'Some questions drift past even me, friend — ask a budtender, they have clearer eyes than my crystal ball.',
        category: DEFLECT_CATEGORY, deflect: true };
    }
    function match(question, fortunes) {
      var corpus = resolveCorpus(fortunes);
      var query = normalize(question);
      if (isSafetyQuestion(question)) {
        var qTok = tokenize(question), bestDef = null, bestDefScore = -1;
        for (var d = 0; d < corpus.length; d++) {
          if (!corpus[d].deflect) continue;
          var sc = score(qTok, corpus[d]);
          if (sc > bestDefScore) { bestDefScore = sc; bestDef = corpus[d]; }
        }
        return { entry: bestDef || deflectionEntry(corpus), deflect: true, reason: 'safety',
          score: bestDefScore < 0 ? 0 : bestDefScore, query: query };
      }
      var tokens = tokenize(question);
      if (!tokens.length) {
        return { entry: deflectionEntry(corpus), deflect: true, reason: 'empty', score: 0, query: query };
      }
      var best = null, bestScore = -1;
      for (var i = 0; i < corpus.length; i++) {
        if (corpus[i].deflect) continue;
        var s = score(tokens, corpus[i]);
        if (s > bestScore) { bestScore = s; best = corpus[i]; }
      }
      if (!best || bestScore < THRESHOLD) {
        return { entry: deflectionEntry(corpus), deflect: true, reason: 'low-score',
          score: bestScore < 0 ? 0 : bestScore, query: query };
      }
      return { entry: best, deflect: !!best.deflect, reason: 'match', score: bestScore, query: query };
    }
    function cardNumber(entry, fortunes) {
      var corpus = resolveCorpus(fortunes);
      if (!entry) return 0;
      for (var i = 0; i < corpus.length; i++) if (corpus[i].id === entry.id) return i + 1;
      return 0;
    }
    function luckyNumbers(entry) {
      var seed = 0, id = (entry && entry.id) || '';
      for (var i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) % 1000000007;
      var out = [], s = seed || 7;
      while (out.length < 3) {
        s = (s * 16807 + 17) % 2147483647;
        var n = (s % 40) + 1;
        if (out.indexOf(n) === -1) out.push(n);
      }
      return out;
    }
    function buildCard(result, fortunes) {
      var corpus = resolveCorpus(fortunes);
      var entry = (result && result.entry) || deflectionEntry(corpus);
      var deflect = !!(result && result.deflect) || !!entry.deflect;
      var golden = !deflect && !!entry.golden;
      return { id: entry.id, number: cardNumber(entry, corpus), total: corpus.length,
        question: entry.question, answer: entry.answer, earl: entry.earl, category: entry.category,
        deflect: deflect, golden: golden, code: golden ? GOLDEN_CODE : null,
        lucky: luckyNumbers(entry), reason: (result && result.reason) || 'match' };
    }
    function formatDeck(deckIds, fortunes) {
      var corpus = resolveCorpus(fortunes), have = {}, i;
      if (deckIds && deckIds.length) for (i = 0; i < deckIds.length; i++) have[deckIds[i]] = true;
      var entries = [], collected = 0;
      for (i = 0; i < corpus.length; i++) {
        var e = corpus[i], got = have[e.id] === true;
        if (got) collected += 1;
        entries.push({ id: e.id, number: i + 1, question: e.question, category: e.category,
          golden: !!e.golden, deflect: !!e.deflect, collected: got });
      }
      return { collected: collected, total: corpus.length, entries: entries };
    }
    function addToDeck(deckIds, id) {
      var list = (deckIds || []).slice(), isNew = list.indexOf(id) === -1;
      if (isNew) list.push(id);
      return { deck: list, isNew: isNew };
    }
    function shareText(card) {
      card = card || {};
      var lines = ['🔮 COSMIC EARL says:'];
      if (card.question) lines.push('“' + card.question + '”');
      if (card.earl) lines.push('— ' + card.earl);
      if (card.golden && card.code) lines.push('✨ GOLDEN CARD · code ' + card.code);
      if (card.number && card.total) lines.push('🃏 Card #' + card.number + '/' + card.total);
      lines.push('Ask Cosmic Earl · onlinebudshop.com');
      return lines.join('\n');
    }
    return {
      THRESHOLD: THRESHOLD, DECK_KEY: DECK_KEY, GOLDEN_CODE: GOLDEN_CODE,
      DEFLECT_CATEGORY: DEFLECT_CATEGORY,
      normalize: normalize, tokenize: tokenize, rawTokens: rawTokens,
      isSafetyQuestion: isSafetyQuestion, fuzzyMatch: fuzzyMatch, score: score, match: match,
      deflectionEntry: deflectionEntry, cardNumber: cardNumber, luckyNumbers: luckyNumbers,
      buildCard: buildCard, formatDeck: formatDeck, addToDeck: addToDeck, shareText: shareText
    };
  }

  var Fortunes = root.EarlFortunes || buildFallbackFortunes();
  var Core = root.EarlCore || buildFallbackCore(Fortunes);

  // ── Canvas layout ─────────────────────────────────────────────────────
  var W = 720, H = 560;     // cabinet footprint (index.html pins it)

  // ── Palette (cel-cartoon: flat fills, one ink colour, warm neon arcade) ─
  var INK = '#1d1d28';
  var OUTLINE = 3;
  var BG_TOP = '#3a1f5c';
  var BG_BOTTOM = '#1a1030';
  var CAB_BODY = '#7a3fa0';
  var CAB_DARK = '#5e2e80';
  var CAB_TRIM = '#ffce4a';
  var GLASS = '#241a3a';
  var GLASS_GLOW = '#5a3f8a';
  var MARQUEE = '#ff5fa2';
  var MARQUEE_DARK = '#c83f7e';
  var NEON_CYAN = '#4fe0d8';
  var NEON_LIME = '#9ad86a';
  var SKIN = '#e6b88a';
  var BEARD = '#cfc4b8';
  var BANDANA = '#e0453e';
  var BANDANA_DOT = '#ffd24a';
  var TIE1 = '#ff7a3e';
  var TIE2 = '#4fc1e0';
  var TIE3 = '#ffd24a';
  var TIE4 = '#9ad86a';
  var SHADE = '#2a2a38';
  var SMOKE = 'rgba(210,230,210,0.5)';
  var CARD_BG = '#fff7e6';
  var CARD_GOLD = '#fff0bf';
  var CARD_DEFLECT = '#e8e0ff';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function normKey(k) {
    if (!k) return '';
    if (k === ' ' || k === 'Spacebar' || k === 'Space') return ' ';
    return k.toLowerCase();
  }

  // ── Cel-cartoon primitives ───────────────────────────────────────────
  function celBox(ctx, x, y, w, h, fill, r, noStroke) {
    r = r == null ? 8 : r;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (!noStroke) { ctx.lineWidth = OUTLINE; ctx.strokeStyle = INK; ctx.stroke(); }
  }
  function celCircle(ctx, x, y, r, fill, noStroke) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (!noStroke) { ctx.lineWidth = OUTLINE; ctx.strokeStyle = INK; ctx.stroke(); }
  }

  // ════════════════════════════════════════════════════════════════════
  //  Game
  // ════════════════════════════════════════════════════════════════════
  function Game(canvas, input) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.input = input || null;        // the on-screen <input> element
    this.screen = 'attract';           // attract → ask → thinking → card
    this.now = 0;
    this.crashMsg = '';
    this.thinkTimer = 0;
    this.cardSlide = 0;                // 0..1 card-dispense animation
    this.riff = 0;                     // 0..1 Earl awake/lean-in
    this.riffLine = '';
    this.pendingQuestion = '';
    this.card = null;                  // the dispensed card model (from Core)
    this._buttons = [];                // active card buttons (hit-tested)
    this._chips = [];                  // popular-question chips (hit-tested)
    this.storage = null;
    try { this.storage = root.localStorage || null; } catch (e) { this.storage = null; }
    this.deckIds = this.loadDeck();    // list of collected entry IDS
    this.total = (Fortunes.FORTUNES && Fortunes.FORTUNES.length) || 0;
    this.buildChips();
  }

  // ── Deck (collected entry IDS, localStorage-persisted) ────────────────
  Game.prototype.loadDeck = function () {
    try {
      if (this.storage) {
        var raw = this.storage.getItem(Core.DECK_KEY);
        if (raw) {
          var arr = JSON.parse(raw);
          if (arr && arr.length) return arr.slice();
        }
      }
    } catch (e) {}
    return [];
  };
  Game.prototype.saveDeck = function () {
    try { if (this.storage) this.storage.setItem(Core.DECK_KEY, JSON.stringify(this.deckIds)); } catch (e) {}
  };
  Game.prototype.deckCount = function () {
    // Count only collected COLLECTIBLE entries (Core.formatDeck never counts
    // anything not in the corpus; deflect ids are never added in the first place).
    return Core.formatDeck(this.deckIds, Fortunes).collected;
  };

  // ── Popular-question chips: first few corpus chips (guaranteed good) ───
  Game.prototype.buildChips = function () {
    var all = (Fortunes.chips ? Fortunes.chips() : []) || [];
    var picks = [];
    for (var i = 0; i < all.length && picks.length < 4; i++) {
      if (!all[i].deflect) picks.push(all[i]);
    }
    // Fallback: if no chip-flagged entries, take the first non-deflect entries.
    if (!picks.length) {
      var f = Fortunes.FORTUNES || [];
      for (var j = 0; j < f.length && picks.length < 4; j++) if (!f[j].deflect) picks.push(f[j]);
    }
    this.chipEntries = picks;
  };

  // ════════════════════════════════════════════════════════════════════
  //  Flow: ask a question → riff → thinking → card
  // ════════════════════════════════════════════════════════════════════
  // Submit a typed question. Empty input is a gentle no-op (never crashes).
  Game.prototype.submitQuestion = function (text) {
    var q = (text == null && this.input) ? (this.input.value || '') : (text || '');
    q = String(q).replace(/\s+/g, ' ').trim();
    if (!q) return false;
    this.pendingQuestion = q;
    this.riffLine = this.pickRiff(q);
    this.screen = 'thinking';
    this.thinkTimer = 0;
    this.riff = 0;
    this.cardSlide = 0;
    this.card = null;
    if (this.input) { try { this.input.value = ''; this.input.blur && this.input.blur(); } catch (e) {} }
    this.syncInput();
    return true;
  };
  // Tap a popular-question chip: guaranteed-good answer for that entry.
  Game.prototype.askChip = function (index) {
    var entry = this.chipEntries && this.chipEntries[index];
    if (!entry) return false;
    return this.submitQuestion(entry.question);
  };
  Game.prototype.pickRiff = function (q) {
    var lines = [
      'mmmmm... let me feel that one out, friend...',
      'oh, far out... the smoke is swirlin\'...',
      'hold up, the cosmos is buzzin\'...',
      'ahh, a good one... lemme consult the haze...'
    ];
    var h = 0;
    for (var i = 0; i < q.length; i++) h = (h * 31 + q.charCodeAt(i)) >>> 0;
    return lines[h % lines.length];
  };

  // Resolve the pending question through the core → a card model. The shell
  // never re-derives the match; it renders Core.buildCard()'s output. Only
  // NON-deflect cards get collected into the deck.
  Game.prototype.resolve = function () {
    var verdict = Core.match(this.pendingQuestion, Fortunes);
    var card = Core.buildCard(verdict, Fortunes);
    this.card = card;
    if (!card.deflect && card.id) {
      var res = Core.addToDeck(this.deckIds, card.id);
      this.deckIds = res.deck;
      if (res.isNew) this.saveDeck();
    }
    this.screen = 'card';
    this.cardSlide = 0;
  };

  // ASK AGAIN → back to the ask screen, ready for the next question.
  Game.prototype.askAgain = function () {
    this.screen = 'ask';
    this.card = null;
    this.pendingQuestion = '';
    this.riffLine = '';
    this.thinkTimer = 0;
    this.cardSlide = 0;
    this.riff = 0;
    this.syncInput();
  };
  // Attract → ask (press / tap to begin).
  Game.prototype.begin = function () {
    if (this.screen === 'attract') { this.screen = 'ask'; this.syncInput(); }
  };
  // Show/hide the real <input> depending on the screen (ask screen only).
  Game.prototype.syncInput = function () {
    if (!this.input || !this.input.style) return;
    try { this.input.style.display = (this.screen === 'ask' || this.screen === 'attract') ? '' : 'none'; } catch (e) {}
  };

  // ── Input routing ─────────────────────────────────────────────────────
  Game.prototype.onKeyDown = function (k, repeat) {
    var key = normKey(k);
    if (key === '') return;
    if (key === 'enter' && !repeat) {
      if (this.screen === 'attract') { this.begin(); return; }
      if (this.screen === 'ask') { this.submitQuestion(null); return; }
      if (this.screen === 'card') { this.askAgain(); return; }
      return;
    }
    if (this.screen === 'attract' && (key === ' ' || key === 'enter') && !this.inputFocused()) {
      this.begin();
    }
  };
  Game.prototype.inputFocused = function () {
    try {
      var doc = root.document;
      return !!(this.input && doc && doc.activeElement === this.input);
    } catch (e) { return false; }
  };

  // ── Per-frame update (crash-proof; never advances on a bad dt) ─────────
  Game.prototype.update = function (dt) {
    if (!(dt >= 0)) dt = 0;
    this.now += dt;
    if (this.screen === 'thinking') {
      this.thinkTimer += dt;
      this.riff = clamp(this.riff + dt * 4, 0, 1);   // Earl leans in
      if (this.thinkTimer >= 1.5) this.resolve();    // ~1.5s thinking beat
    } else if (this.screen === 'card') {
      this.cardSlide = clamp(this.cardSlide + dt * 2.2, 0, 1);  // card slides out
      this.riff = clamp(this.riff - dt * 2, 0, 1);
    } else {
      this.riff = clamp(this.riff - dt * 3, 0, 1);
    }
  };

  // ════════════════════════════════════════════════════════════════════
  //  RENDER
  // ════════════════════════════════════════════════════════════════════
  Game.prototype.draw = function () {
    var ctx = this.ctx;
    ctx.save();
    this.drawBackground(ctx);
    this.drawCabinet(ctx);
    this.drawEarl(ctx);
    this.drawMarquee(ctx);
    if (this.screen === 'attract') this.drawAttract(ctx);
    else if (this.screen === 'ask') this.drawAsk(ctx);
    else if (this.screen === 'thinking') this.drawThinking(ctx);
    else if (this.screen === 'card') this.drawCard(ctx);
    this.drawDeckCounter(ctx);
    ctx.restore();
  };

  Game.prototype.drawBackground = function (ctx) {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, BG_TOP);
    g.addColorStop(1, BG_BOTTOM);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (var i = 0; i < 36; i++) {
      var sx = (i * 97 % W), sy = ((i * 53) % (H * 0.6));
      var tw = (Math.sin(this.now * 2 + i) + 1) * 0.5;
      ctx.globalAlpha = 0.2 + tw * 0.5;
      ctx.fillRect(sx, sy, 2, 2);
    }
    ctx.globalAlpha = 1;
  };

  // The coin-op cabinet: body, glass booth, neon tubes.
  Game.prototype.drawCabinet = function (ctx) {
    var cx = W / 2;
    celBox(ctx, cx - 230, 70, 460, H - 110, CAB_BODY, 26);
    celBox(ctx, cx - 230, H - 150, 460, 92, CAB_DARK, 26);
    ctx.strokeStyle = NEON_CYAN; ctx.lineWidth = 4; ctx.globalAlpha = 0.8;
    ctx.beginPath(); ctx.moveTo(cx - 214, 110); ctx.lineTo(cx - 214, H - 170); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 214, 110); ctx.lineTo(cx + 214, H - 170); ctx.stroke();
    ctx.globalAlpha = 1;
    var glow = (Math.sin(this.now * 1.6) + 1) * 0.5;
    celBox(ctx, cx - 180, 118, 360, 270, GLASS, 18);
    ctx.save();
    ctx.globalAlpha = 0.35 + glow * 0.25;
    celBox(ctx, cx - 172, 126, 344, 254, GLASS_GLOW, 14, true);
    ctx.restore();
  };

  // Cosmic Earl — ORIGINAL mellow hippie: bandana, round shades, beard,
  // tie-dye. Idle sway + smoke wisps; leans in + blinks when riffing.
  Game.prototype.drawEarl = function (ctx) {
    var cx = W / 2;
    var baseY = 300;
    var sway = Math.sin(this.now * 1.1) * 6;
    var lean = this.riff * 14;
    var ex = cx + sway * (1 - this.riff);
    var ey = baseY - lean;

    this.drawSmoke(ctx, cx + 70, 250);
    this.drawSmoke(ctx, cx - 78, 240);

    ctx.save();
    ctx.translate(ex, ey);
    ctx.translate(0, Math.sin(this.now * 1.1) * 2);

    // Tie-dye torso (concentric arcs, clipped to a rounded box).
    var tw = 150, th = 120, topY = 18;
    celBox(ctx, -tw / 2, topY, tw, th, TIE1, 22);
    ctx.save();
    ctx.beginPath(); celBoxPath(ctx, -tw / 2, topY, tw, th, 22); ctx.clip();
    var rings = [TIE2, TIE3, TIE4, TIE1];
    for (var r = 0; r < rings.length; r++) {
      ctx.fillStyle = rings[r];
      ctx.beginPath(); ctx.arc(0, topY + th * 0.55, 70 - r * 16, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    celBoxPathStroke(ctx, -tw / 2, topY, tw, th, 22);

    // Neck + head.
    celBox(ctx, -16, topY - 18, 32, 24, SKIN, 8);
    var headR = 52;
    celCircle(ctx, 0, topY - 52, headR, SKIN);

    // Beard.
    ctx.fillStyle = BEARD;
    ctx.beginPath();
    ctx.moveTo(-headR * 0.78, topY - 60);
    ctx.quadraticCurveTo(-headR * 0.5, topY + 28, 0, topY + 30);
    ctx.quadraticCurveTo(headR * 0.5, topY + 28, headR * 0.78, topY - 60);
    ctx.quadraticCurveTo(0, topY - 36, -headR * 0.78, topY - 60);
    ctx.closePath(); ctx.fill(); ctx.lineWidth = OUTLINE; ctx.strokeStyle = INK; ctx.stroke();

    // Bandana.
    ctx.fillStyle = BANDANA;
    ctx.beginPath();
    ctx.moveTo(-headR, topY - 78);
    ctx.quadraticCurveTo(0, topY - 104, headR, topY - 78);
    ctx.lineTo(headR, topY - 64);
    ctx.quadraticCurveTo(0, topY - 84, -headR, topY - 64);
    ctx.closePath(); ctx.fill(); ctx.lineWidth = OUTLINE; ctx.strokeStyle = INK; ctx.stroke();
    for (var d = -1; d <= 1; d++) celCircle(ctx, d * 22, topY - 80, 3, BANDANA_DOT, true);

    // Round shades.
    var blink = (Math.floor(this.now * 1.4) % 7 === 0) && this.riff < 0.5;
    var lensY = topY - 56;
    ctx.strokeStyle = INK; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-22, lensY); ctx.lineTo(22, lensY); ctx.stroke();
    celCircle(ctx, -24, lensY, 15, SHADE);
    celCircle(ctx, 24, lensY, 15, SHADE);
    if (this.riff > 0.5) {
      celCircle(ctx, -24, lensY, 5, '#fff', true);
      celCircle(ctx, 24, lensY, 5, '#fff', true);
    } else if (!blink) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillRect(-30, lensY - 6, 5, 5);
      ctx.fillRect(18, lensY - 6, 5, 5);
    }

    // Mellow smile.
    ctx.strokeStyle = INK; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, topY - 30, 14, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
    ctx.restore();

    if (this.riff > 0.35 && (this.screen === 'thinking' || this.screen === 'card')) {
      this.drawSpeech(ctx, cx + 90, ey - 86, this.riffLine);
    }
  };

  Game.prototype.drawSmoke = function (ctx, x, y) {
    ctx.save();
    for (var i = 0; i < 3; i++) {
      var t = (this.now * 0.5 + i * 0.6) % 1.8;
      var puffY = y - t * 70;
      var puffX = x + Math.sin(this.now * 1.5 + i) * 12;
      var rr = 6 + t * 7;
      ctx.globalAlpha = clamp(0.45 - t * 0.22, 0, 0.45);
      ctx.fillStyle = SMOKE;
      ctx.beginPath(); ctx.arc(puffX, puffY, rr, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  };

  Game.prototype.drawSpeech = function (ctx, x, y, text) {
    var w = 168, h = 44;
    celBox(ctx, x, y, w, h, '#fffdf5', 12);
    ctx.beginPath();
    ctx.moveTo(x + 18, y + h); ctx.lineTo(x + 8, y + h + 16); ctx.lineTo(x + 34, y + h);
    ctx.closePath(); ctx.fillStyle = '#fffdf5'; ctx.fill();
    ctx.lineWidth = OUTLINE; ctx.strokeStyle = INK; ctx.stroke();
    ctx.fillStyle = INK;
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'left';
    wrapText(ctx, text, x + 12, y + 18, w - 24, 14, 2);
  };

  // The blinking marquee at the top: "ASK COSMIC EARL".
  Game.prototype.drawMarquee = function (ctx) {
    var cx = W / 2;
    var blink = Math.floor(this.now * 2) % 2 === 0;
    celBox(ctx, cx - 210, 18, 420, 56, blink ? MARQUEE : MARQUEE_DARK, 16);
    for (var i = 0; i < 14; i++) {
      var bx = cx - 196 + i * 30;
      celCircle(ctx, bx, 24, 3, blink ? '#ffe7a0' : '#9a7a3a', true);
      celCircle(ctx, bx, 68, 3, blink ? '#ffe7a0' : '#9a7a3a', true);
    }
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 30px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('ASK COSMIC EARL', cx, 56);
    ctx.textAlign = 'left';
  };

  Game.prototype.drawDeckCounter = function (ctx) {
    ctx.fillStyle = NEON_LIME;
    ctx.font = 'bold 15px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('🃏 DECK ' + this.deckCount() + '/' + this.total, 16, H - 18);
    ctx.textAlign = 'left';
  };

  // ── Screen overlays ───────────────────────────────────────────────────
  Game.prototype.drawAttract = function (ctx) {
    var cx = W / 2;
    var pulse = (Math.sin(this.now * 3) + 1) * 0.5;
    ctx.textAlign = 'center';
    ctx.fillStyle = CAB_TRIM;
    ctx.font = 'bold 20px ui-monospace, monospace';
    ctx.globalAlpha = 0.55 + pulse * 0.45;
    ctx.fillText('▸ PRESS / TAP TO ASK ◂', cx, H - 92);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#e8def5';
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillText('Earl reads your question + dispenses a fortune card', cx, H - 66);
    ctx.textAlign = 'left';
  };

  Game.prototype.drawAsk = function (ctx) {
    var cx = W / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px ui-monospace, monospace';
    ctx.fillText('Type your question above — or tap one:', cx, H - 150);
    ctx.textAlign = 'left';

    this._chips = [];
    var cols = 2, cw = 200, chh = 32, gap = 14;
    var gridW = cols * cw + (cols - 1) * gap;
    var x0 = cx - gridW / 2, y0 = H - 128;
    for (var i = 0; i < this.chipEntries.length; i++) {
      var col = i % cols, rowi = Math.floor(i / cols);
      var bx = x0 + col * (cw + gap), by = y0 + rowi * (chh + 10);
      celBox(ctx, bx, by, cw, chh, '#2a7fa7', 10);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(truncate(this.chipEntries[i].question, 26), bx + cw / 2, by + 21);
      this._chips.push({ index: i, x: bx, y: by, w: cw, h: chh });
    }
    ctx.textAlign = 'left';
  };

  Game.prototype.drawThinking = function (ctx) {
    var cx = W / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = CAB_TRIM;
    ctx.font = 'bold 18px ui-monospace, monospace';
    var dots = '.'.repeat((Math.floor(this.now * 3) % 3) + 1);
    ctx.fillText('EARL IS DIVINING' + dots, cx, H - 96);
    var feed = clamp(this.thinkTimer / 1.5, 0, 1);
    celBox(ctx, cx - 60, H - 78 + (1 - feed) * 10, 120, 8 + feed * 6, CARD_BG, 3);
    ctx.textAlign = 'left';
  };

  // The dispensed fortune CARD: three zones (THE ANSWER / EARL SEZ /
  // collectible flourishes) + GOLDEN + DEFLECTION variants. Slides up.
  Game.prototype.drawCard = function (ctx) {
    var c = this.card;
    if (!c) return;
    var cw = 440, ch = 360;
    var cx = (W - cw) / 2;
    var rest = (H - ch) / 2 + 6;
    var cy = rest + (1 - this.cardSlide) * (H - rest + 20);

    var bg = c.deflect ? CARD_DEFLECT : (c.golden ? CARD_GOLD : CARD_BG);

    ctx.fillStyle = 'rgba(12,8,24,0.72)';
    ctx.fillRect(0, 0, W, H);

    if (c.golden) {
      ctx.save();
      ctx.shadowColor = 'rgba(255,206,74,0.9)';
      ctx.shadowBlur = 26;
      celBox(ctx, cx, cy, cw, ch, bg, 18);
      ctx.restore();
    } else {
      celBox(ctx, cx, cy, cw, ch, bg, 18);
    }

    ctx.textAlign = 'center';
    var headColor = c.deflect ? '#6a4fae' : (c.golden ? '#c89a2a' : '#7a3fa0');
    celBox(ctx, cx + 14, cy + 14, cw - 28, 36, headColor, 10);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px ui-monospace, monospace';
    ctx.fillText(c.deflect ? '🌫  EARL GETS MYSTICAL' : (c.golden ? '✨  GOLDEN FORTUNE  ✨' : '🔮  COSMIC FORTUNE'), W / 2, cy + 38);

    var y = cy + 74;
    ctx.textAlign = 'left';

    // Zone 1 — THE ANSWER.
    ctx.fillStyle = headColor;
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.fillText(c.deflect ? 'EARL SAYS' : 'THE ANSWER', cx + 26, y);
    y += 18;
    ctx.fillStyle = INK;
    ctx.font = '13px ui-monospace, monospace';
    y = wrapText(ctx, c.answer, cx + 26, y, cw - 52, 17, 5) + 8;

    // Zone 2 — EARL SEZ (the hippie one-liner).
    ctx.fillStyle = headColor;
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.fillText('🌿 EARL SEZ', cx + 26, y);
    y += 18;
    ctx.fillStyle = '#4a3a2a';
    ctx.font = 'italic 13px ui-monospace, monospace';
    y = wrapText(ctx, '"' + c.earl + '"', cx + 26, y, cw - 52, 17, 4) + 10;

    // Zone 3 — collectible flourishes (only on real cards).
    if (!c.deflect) {
      ctx.strokeStyle = 'rgba(122,63,160,0.4)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx + 26, y); ctx.lineTo(cx + cw - 26, y); ctx.stroke();
      y += 18;
      this.drawMiniEarl(ctx, cx + 44, y + 8);
      ctx.fillStyle = INK;
      ctx.font = 'bold 13px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('CARD #' + c.number + ' / ' + c.total, cx + 78, y + 2);
      ctx.fillStyle = '#5e2e80';
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText('🍀 Lucky: ' + (c.lucky || []).join('  '), cx + 78, y + 22);
      if (c.golden && c.code) {
        ctx.fillStyle = '#b8860b';
        ctx.font = 'bold 13px ui-monospace, monospace';
        ctx.fillText('✨ CODE: ' + c.code, cx + 78, y + 42);
      }
    } else {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#6a4fae';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('(ask a budtender for the real deal)', W / 2, y + 4);
      ctx.textAlign = 'left';
    }

    // Buttons: SAVE / COPY / ASK AGAIN.
    var bw = (cw - 52 - 16) / 3, bh = 34, by = cy + ch - bh - 16, bx = cx + 26;
    this._buttons = [
      { id: 'save', label: 'SAVE', x: bx, y: by, w: bw, h: bh, color: '#5fae3e' },
      { id: 'copy', label: 'COPY', x: bx + bw + 8, y: by, w: bw, h: bh, color: '#2a7fa7' },
      { id: 'again', label: 'ASK AGAIN', x: bx + (bw + 8) * 2, y: by, w: bw, h: bh, color: '#c83f7e' }
    ];
    for (var b = 0; b < this._buttons.length; b++) {
      var btn = this._buttons[b];
      celBox(ctx, btn.x, btn.y, btn.w, btn.h, btn.color, 9);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(btn.label, btn.x + btn.w / 2, btn.y + 22);
    }
    ctx.textAlign = 'left';
  };

  Game.prototype.drawMiniEarl = function (ctx, x, y) {
    celCircle(ctx, x, y, 13, SKIN);
    ctx.fillStyle = BANDANA;
    ctx.beginPath();
    ctx.moveTo(x - 13, y - 4); ctx.quadraticCurveTo(x, y - 18, x + 13, y - 4);
    ctx.lineTo(x + 13, y - 1); ctx.quadraticCurveTo(x, y - 9, x - 13, y - 1);
    ctx.closePath(); ctx.fill();
    celCircle(ctx, x - 5, y + 1, 3.5, SHADE);
    celCircle(ctx, x + 5, y + 1, 3.5, SHADE);
    ctx.fillStyle = BEARD;
    ctx.beginPath(); ctx.arc(x, y + 8, 7, 0, Math.PI); ctx.fill();
  };

  // ════════════════════════════════════════════════════════════════════
  //  Share text + card PNG (clipboard + toBlob), pointer handling
  // ════════════════════════════════════════════════════════════════════
  Game.prototype.shareText = function () { return Core.shareText(this.card || {}); };
  Game.prototype.copyResult = function () {
    var txt = this.shareText();
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
      try { root.navigator.clipboard.writeText(txt); } catch (e) {}
    }
    return txt;
  };
  Game.prototype.saveCard = function () {
    var doc = root.document;
    var c = doc && doc.createElement ? doc.createElement('canvas') : null;
    if (!c || !c.getContext) return false;
    c.width = 540; c.height = 720;
    var x = c.getContext('2d');
    this.paintShareCard(x, c.width, c.height);
    if (!c.toBlob) return false;
    c.toBlob(function (blob) {
      if (!blob || !root.URL || !root.URL.createObjectURL) return;
      var url = root.URL.createObjectURL(blob);
      var a = doc.createElement('a');
      a.href = url; a.download = 'cosmic-earl-card.png';
      if (doc.body) doc.body.appendChild(a);
      if (a.click) a.click();
      if (a.remove) a.remove();
      if (root.URL.revokeObjectURL) root.URL.revokeObjectURL(url);
    });
    return true;
  };
  Game.prototype.paintShareCard = function (ctx, w, h) {
    var c = this.card || {};
    var bg = c.deflect ? '#2a2150' : (c.golden ? '#3a2e10' : '#1a1030');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    var inner = c.deflect ? CARD_DEFLECT : (c.golden ? CARD_GOLD : CARD_BG);
    celBox(ctx, 28, 28, w - 56, h - 56, inner, 22);
    ctx.textAlign = 'center';
    ctx.fillStyle = c.golden ? '#c89a2a' : '#7a3fa0';
    ctx.font = 'bold 30px ui-monospace, monospace';
    ctx.fillText('COSMIC EARL', w / 2, 92);
    ctx.fillStyle = '#5e2e80';
    ctx.font = '15px ui-monospace, monospace';
    ctx.fillText(c.deflect ? 'a mystical deflection' : ('CARD #' + (c.number || '?') + ' / ' + (c.total || '?')), w / 2, 120);
    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    ctx.font = '17px ui-monospace, monospace';
    var y = wrapText(ctx, c.answer || '', 56, 176, w - 112, 24, 8) + 24;
    ctx.fillStyle = '#4a3a2a';
    ctx.font = 'italic 17px ui-monospace, monospace';
    y = wrapText(ctx, '"' + (c.earl || '') + '"', 56, y, w - 112, 24, 6) + 24;
    if (!c.deflect) {
      ctx.fillStyle = '#5e2e80';
      ctx.font = '16px ui-monospace, monospace';
      ctx.fillText('🍀 Lucky: ' + (c.lucky || []).join('  '), 56, y);
      if (c.golden && c.code) {
        ctx.fillStyle = '#b8860b';
        ctx.font = 'bold 18px ui-monospace, monospace';
        ctx.fillText('✨ CODE: ' + c.code, 56, y + 30);
      }
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#7a3fa0';
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillText('onlinebudshop.com', w / 2, h - 52);
    ctx.textAlign = 'left';
  };

  // Pointer / tap. Routes to the chips, the card buttons, or "begin".
  Game.prototype.handlePoint = function (px, py) {
    if (this.screen === 'attract') { this.begin(); return; }
    if (this.screen === 'ask') {
      for (var i = 0; i < this._chips.length; i++) {
        var ch = this._chips[i];
        if (px >= ch.x && px <= ch.x + ch.w && py >= ch.y && py <= ch.y + ch.h) { this.askChip(ch.index); return; }
      }
      return;
    }
    if (this.screen === 'card') {
      for (var b = 0; b < this._buttons.length; b++) {
        var bt = this._buttons[b];
        if (px >= bt.x && px <= bt.x + bt.w && py >= bt.y && py <= bt.y + bt.h) {
          if (bt.id === 'save') this.saveCard();
          else if (bt.id === 'copy') this.copyResult();
          else if (bt.id === 'again') this.askAgain();
          return;
        }
      }
      return;
    }
  };

  // ── Text helpers ──────────────────────────────────────────────────────
  function wrapText(ctx, text, x, y, maxWidth, lineH, maxLines) {
    text = String(text == null ? '' : text);
    var words = text.split(' '), line = '', lines = [];
    for (var i = 0; i < words.length; i++) {
      var test = line ? (line + ' ' + words[i]) : words[i];
      var w = ctx.measureText ? ctx.measureText(test).width : test.length * 7;
      if (w > maxWidth && line) { lines.push(line); line = words[i]; }
      else line = test;
    }
    if (line) lines.push(line);
    if (maxLines && lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[maxLines - 1] = lines[maxLines - 1].replace(/\s+\S*$/, '') + '…';
    }
    for (var j = 0; j < lines.length; j++) ctx.fillText(lines[j], x, y + j * lineH);
    return y + lines.length * lineH;
  }
  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function celBoxPath(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function celBoxPathStroke(ctx, x, y, w, h, r) {
    ctx.beginPath(); celBoxPath(ctx, x, y, w, h, r);
    ctx.lineWidth = OUTLINE; ctx.strokeStyle = INK; ctx.stroke();
  }

  // ════════════════════════════════════════════════════════════════════
  //  Boot
  // ════════════════════════════════════════════════════════════════════
  function boot() {
    var doc = root.document;
    var canvas = doc && doc.getElementById ? doc.getElementById('stage') : null;
    if (!canvas) return;
    canvas.width = W; canvas.height = H;
    var input = doc && doc.getElementById ? doc.getElementById('ask') : null;
    var game = new Game(canvas, input);
    game.syncInput();

    root.addEventListener('keydown', function (e) { game.onKeyDown(e.key, e.repeat); });

    if (input && input.addEventListener) {
      input.addEventListener('keydown', function (e) {
        var key = normKey(e.key);
        if (key === 'enter') {
          if (e.preventDefault) e.preventDefault();
          game.submitQuestion(input.value);
        }
      });
      input.addEventListener('focus', function () { try { if (doc.body) doc.body.classList.add('kb-up'); } catch (er) {} });
      input.addEventListener('blur', function () { try { if (doc.body) doc.body.classList.remove('kb-up'); } catch (er) {} });
    }

    var askBtn = doc && doc.getElementById ? doc.getElementById('ask-go') : null;
    if (askBtn && askBtn.addEventListener) {
      askBtn.addEventListener('click', function () { game.submitQuestion(input ? input.value : ''); });
    }

    if (canvas.addEventListener) {
      var pointAt = function (clientX, clientY) {
        var r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: W, height: H };
        var scaleX = W / (r.width || W), scaleY = H / (r.height || H);
        game.handlePoint((clientX - r.left) * scaleX, (clientY - r.top) * scaleY);
      };
      canvas.addEventListener('click', function (e) { pointAt(e.clientX, e.clientY); });
      canvas.addEventListener('touchend', function (e) {
        var t = e.changedTouches && e.changedTouches[0];
        if (t) pointAt(t.clientX, t.clientY);
        if (e.preventDefault) e.preventDefault();
      }, { passive: false });
    }

    // rAF loop wrapped in try/catch → crash card, never a freeze.
    var last = 0;
    function frame(ts) {
      var dt = last ? Math.min(0.05, (ts - last) / 1000) : 0;
      last = ts;
      try {
        game.update(dt);
        game.draw();
      } catch (err) {
        game.screen = 'crash';
        game.crashMsg = (err && err.message) ? err.message : String(err);
        try { drawCrashCard(game.ctx, game.crashMsg); } catch (e2) {}
      }
      root.requestAnimationFrame(frame);
    }
    root.requestAnimationFrame(frame);

    // Test hook (mirrors splat's window.__SPLAT / budrun's window.__BUDRUN).
    root.__EARL = {
      getScreen: function () { return game.screen; },
      getGame: function () { return game; },
      getCard: function () { return game.card; },
      ask: function (q) { return game.submitQuestion(q); },
      askChip: function (i) { return game.askChip(i); },
      Core: Core,
      Fortunes: Fortunes
    };
  }

  function drawCrashCard(ctx, msg) {
    ctx.fillStyle = '#15110e'; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e08a6a';
    ctx.font = 'bold 22px ui-monospace, monospace';
    ctx.fillText('COSMIC EARL HICCUPED', W / 2, H / 2 - 12);
    ctx.fillStyle = '#d8c8a8';
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillText((msg || 'unexpected haze').slice(0, 64), W / 2, H / 2 + 14);
    ctx.fillStyle = '#e0c84a';
    ctx.font = 'bold 15px ui-monospace, monospace';
    ctx.fillText('refresh to ask again', W / 2, H / 2 + 48);
    ctx.textAlign = 'left';
  }

  if (root.addEventListener) root.addEventListener('load', boot);

  if (typeof module === 'object' && module.exports) {
    module.exports = {
      Game: Game, normKey: normKey, boot: boot,
      buildFallbackCore: buildFallbackCore, buildFallbackFortunes: buildFallbackFortunes
    };
  }
})(typeof self !== 'undefined' ? self : this);
