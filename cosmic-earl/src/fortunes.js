/*
 * COSMIC EARL — the fortune corpus. Pure data, no DOM, no logic.
 * Loaded by the browser as window.EarlFortunes and by Node tests via require().
 *
 * Each entry feeds the matcher in src/core.js (window.EarlCore). The player's
 * typed question is normalized + tokenized and scored against every entry's
 * `keywords`; the best entry above EarlCore.THRESHOLD wins, else a mystical
 * deflection card is dispensed.
 *
 * Entry shape (validated by core.validateFortune / test/fortunes.test.js):
 *   {
 *     id:       string, unique, kebab-case stable slug (card identity)
 *     keywords: [string]  — lowercase match tokens (the matcher's vocabulary)
 *     question: string    — the canonical question (also a "popular chip")
 *     answer:   string    — THE ANSWER zone: brand-voice shop FAQ, educational
 *     earl:     string    — EARL SEZ zone: hippie one-liner, <= 140 chars
 *     category: string    — one of CATEGORIES (grouping + chip sections)
 *     deflect:  boolean    — true => safety/deflection card (no shop answer)
 *     golden?:  boolean    — true => rare card, carries GOLDEN_CODE discount
 *     chip?:    boolean    — true => surface as a tappable "popular question"
 *   }
 *
 * GUARDRAILS baked into this data (enforced by test/fortunes.test.js):
 *   - Cosmic Earl is an ORIGINAL character. NO "zoltar"/"cheech"/"chong"
 *     strings anywhere. No real-person references. Family-friendly, no
 *     profanity. 21+ mellow TONE only.
 *   - Medical / dosing / drug-interaction / legality-by-jurisdiction questions
 *     are `deflect:true`. A deflect card NEVER gives a number, a dose, or a
 *     legal ruling — Earl gets mystical and points to a real budtender / local
 *     law. The matcher ALSO force-deflects these via a keyword pre-filter, so
 *     even an unflagged near-miss is caught (defense in depth).
 *   - GOLDEN cards carry a PLACEHOLDER code "EARL420" — the shop owner swaps
 *     in the real promo code at deploy time.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EarlFortunes = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Placeholder discount code on golden cards — owner swaps the real one.
  var GOLDEN_CODE = 'EARL420';

  // Card category buckets (grouping + chip sections in the shell).
  var CATEGORIES = [
    'ordering',   // how to buy, delivery, pickup, payment
    'hours',      // when we're open / closed
    'access',     // age / ID / who can shop
    'product',    // strain descriptions, edibles-vs-flower basics, storage
    'deals',      // discounts, loyalty, golden codes
    'service',    // returns, support, the shop's story
    'cosmic',     // life / universe / Easter-egg delight
    'safety'      // the deflect class: medical / dosing / legal
  ];

  var FORTUNES = [

    // ── ORDERING / DELIVERY / PAYMENT ───────────────────────────────────
    {
      id: 'how-to-order',
      keywords: ['order', 'buy', 'purchase', 'checkout', 'cart', 'online', 'place'],
      question: 'How do I place an order?',
      answer: 'Browse the menu, tap what speaks to you, add it to your cart, ' +
        'and check out. You confirm you\'re 21+, pick delivery or pickup, and ' +
        'we take it from there. The whole thing is a couple taps, man.',
      earl: 'The order finds you when you stop reaching for it. Tap, breathe, the bag arrives.',
      category: 'ordering',
      deflect: false,
      chip: true
    },
    {
      id: 'delivery-how',
      keywords: ['delivery', 'deliver', 'ship', 'shipping', 'bring', 'driver', 'doorstep', 'work', 'works'],
      question: 'How does delivery work?',
      answer: 'Pop in your address at checkout, we confirm you\'re in our zone, ' +
        'and a driver brings it to your door. You show a valid 21+ ID on arrival. ' +
        'You\'ll get a text when your order\'s rolling your way.',
      earl: 'Everything travels to meet you eventually, friend — some of it just shows up in a little bag.',
      category: 'ordering',
      deflect: false,
      chip: true
    },
    {
      id: 'delivery-area',
      keywords: ['deliver', 'area', 'zone', 'where', 'reach', 'far', 'radius', 'neighborhood', 'local'],
      question: 'Do you deliver to my area?',
      answer: 'Punch your address into checkout and the site tells you instantly ' +
        'whether you\'re in our delivery zone. If you\'re just outside it, pickup ' +
        'is always open to you. Reach out and our budtenders can double-check.',
      earl: 'Some roads lead to your door and some don\'t — the map knows, ask the map, man.',
      category: 'ordering',
      deflect: false
    },
    {
      id: 'delivery-time',
      keywords: ['long', 'wait', 'fast', 'quick', 'eta', 'arrive', 'delivery', 'soon', 'takes'],
      question: 'How long does delivery take?',
      answer: 'Most local deliveries land the same day, often within a couple ' +
        'hours, depending on traffic and how busy the kitchen of the cosmos is. ' +
        'Your confirmation text gives you a live window once a driver grabs it.',
      earl: 'Time is a flat circle and your order is a round trip — it gets here right when it means to.',
      category: 'ordering',
      deflect: false
    },
    {
      id: 'pickup',
      keywords: ['pickup', 'pick', 'collect', 'instore', 'storefront', 'curbside', 'counter', 'ready'],
      question: 'Can I pick up my order in store?',
      answer: 'For sure. Order online, choose pickup, and roll by the counter ' +
        'when it\'s ready — bring your 21+ ID. We\'ll have it bagged and waiting. ' +
        'No line, no fuss, just a friendly nod from the budtenders.',
      earl: 'The mountain won\'t come to you, but the counter will — wander on over when the spirit moves.',
      category: 'ordering',
      deflect: false
    },
    {
      id: 'payment',
      keywords: ['pay', 'payment', 'cash', 'card', 'debit', 'credit', 'money', 'cost', 'accept', 'tender'],
      question: 'What payment methods do you accept?',
      answer: 'Accepted payment shows right at checkout — typically debit and ' +
        'cash on delivery, with the exact options spelled out before you confirm. ' +
        'Our budtenders can walk you through what\'s live if you\'re unsure.',
      earl: 'Money is just energy you can fold — bring whichever kind feels right and the universe sorts it.',
      category: 'ordering',
      deflect: false,
      chip: true
    },
    {
      id: 'minimum-order',
      keywords: ['minimum', 'min', 'order', 'least', 'smallest', 'spend', 'limit', 'enough'],
      question: 'Is there a minimum order?',
      answer: 'Any minimum for delivery shows up at checkout before you pay, so ' +
        'there are no surprises. Pickup usually has no minimum at all. If your ' +
        'cart\'s a little light for delivery, the site nudges you gently.',
      earl: 'Small basket, big basket — the river carries the canoe either way, paddle easy.',
      category: 'ordering',
      deflect: false
    },

    // ── HOURS ───────────────────────────────────────────────────────────
    {
      id: 'hours',
      keywords: ['hours', 'open', 'close', 'closed', 'when', 'time', 'today', 'late', 'early', 'schedule'],
      question: 'What are your hours?',
      answer: 'Current hours live at the top of the site and update for holidays ' +
        'and special days, so the page always has the freshest answer. As a vibe, ' +
        'we keep mellow daytime-into-evening hours for the neighborhood.',
      earl: 'The sun keeps its own hours and so do we — peek at the top of the page, that clock never lies.',
      category: 'hours',
      deflect: false,
      chip: true
    },
    {
      id: 'open-now',
      keywords: ['open', 'currently', 'right', 'still', 'doors'],
      question: 'Are you open right now?',
      answer: 'The banner at the top of the site shows open or closed in real ' +
        'time — that\'s your source of truth. If checkout is letting you place an ' +
        'order, the doors of the cosmos are very much open, friend.',
      earl: 'If the lights are on, the door is open; if they\'re off, dream a little and come back, man.',
      category: 'hours',
      deflect: false
    },
    {
      id: 'holiday-hours',
      keywords: ['holiday', 'holidays', 'weekend', 'sunday', 'closed', 'special', 'day', 'hours'],
      question: 'Are you open on holidays?',
      answer: 'Holiday hours can shift, and when they do we post the change right ' +
        'at the top of the site. Always trust that banner over anything you ' +
        'remember — even the calendar bends a little around the holidays.',
      earl: 'Holidays rearrange the furniture of time — check the banner, it always knows where the couch went.',
      category: 'hours',
      deflect: false
    },

    // ── ACCESS / AGE / ID ───────────────────────────────────────────────
    {
      id: 'age-21',
      keywords: ['age', 'old', '21', 'eighteen', 'twentyone', 'minor', 'young', 'years', 'adult', 'how-old'],
      question: 'How old do I have to be to shop?',
      answer: 'You must be 21 or older to shop with us, full stop. We verify age ' +
        'at checkout and again with a valid government ID at delivery or pickup. ' +
        'No 21, no order — that one\'s not a vibe, it\'s the law.',
      earl: 'Some doors only open after enough trips around the sun — twenty-one of them, to be exact, friend.',
      category: 'access',
      deflect: false,
      chip: true
    },
    {
      id: 'id-required',
      keywords: ['id', 'identification', 'license', 'verify', 'verification', 'proof', 'show', 'card', 'passport'],
      question: 'Do I need to show ID?',
      answer: 'Yep — a valid, unexpired government photo ID that proves you\'re ' +
        '21+ is required at delivery or pickup, every single time, no exceptions. ' +
        'Have it ready and the handoff is smooth as a summer breeze.',
      earl: 'Bring the little card with your face on it — even the cosmos likes to know who it\'s talking to.',
      category: 'access',
      deflect: false
    },

    // ── PRODUCT (descriptions only — NO dosing) ─────────────────────────
    {
      id: 'sativa-indica',
      keywords: ['sativa', 'indica', 'hybrid', 'difference', 'strain', 'strains', 'type', 'types', 'kind', 'between'],
      question: 'What\'s the difference between sativa, indica, and hybrid?',
      answer: 'In plain terms, folks describe sativa-leaning strains as brighter ' +
        'and more daytime, indica-leaning as cozier and more evening, and hybrids ' +
        'as a blend of both. Everyone\'s different — a budtender can describe ' +
        'options for the vibe you\'re after.',
      earl: 'Sunrise leaf, sunset leaf, and the gentle in-between — pick the season your heart is humming.',
      category: 'product',
      deflect: false,
      chip: true
    },
    {
      id: 'strain-recommend',
      keywords: ['recommend', 'suggestion', 'best', 'strain', 'good', 'starter', 'beginner', 'pick', 'which', 'try'],
      question: 'Which strain should I try?',
      answer: 'Half the fun is the wander — read the menu descriptions for the ' +
        'mood each one paints, and if you want a human take, our budtenders love ' +
        'pointing folks toward something that matches the vibe they describe.',
      earl: 'The right leaf is the one that waves back — drift the menu till one of them winks at you.',
      category: 'product',
      deflect: false,
      chip: true
    },
    {
      id: 'edibles-vs-flower',
      keywords: ['edible', 'edibles', 'flower', 'gummy', 'gummies', 'difference', 'eat', 'smoke', 'versus', 'vs'],
      question: 'What\'s the difference between edibles and flower?',
      answer: 'Big picture: flower is the classic dried bud, while edibles are ' +
        'foods and drinks made with cannabis. They\'re just different formats and ' +
        'experiences. For anything about how a format affects you personally, ' +
        'have a chat with a budtender.',
      earl: 'One you breathe, one you bite — same garden, different doorways. Wander whichever path calls.',
      category: 'product',
      deflect: false,
      chip: true
    },
    {
      id: 'storage',
      keywords: ['store', 'storage', 'keep', 'fresh', 'stale', 'jar', 'cool', 'dry', 'preserve', 'last'],
      question: 'How should I store my cannabis?',
      answer: 'Keep it in an airtight container somewhere cool, dark, and dry — ' +
        'away from sun and heat. A sealed jar in a cupboard is a classic. Stored ' +
        'kindly, it keeps its character much longer.',
      earl: 'Treat it like a sleepy cat: cool, dark, quiet, and don\'t let the sun bother it, man.',
      category: 'product',
      deflect: false,
      chip: true
    },
    {
      id: 'in-stock',
      keywords: ['stock', 'instock', 'available', 'availability', 'inventory', 'sold', 'restock', 'menu'],
      question: 'How do I know what\'s in stock?',
      answer: 'The live menu only shows what\'s actually available right now, so ' +
        'if you can add it to your cart, we\'ve got it. Popular drops move fast — ' +
        'if something\'s grayed out, it may be restocking soon. Check back, friend.',
      earl: 'The shelf shows you only what is real today — what\'s gone has simply floated off to bless someone else.',
      category: 'product',
      deflect: false
    },
    {
      id: 'freshness',
      keywords: ['fresh', 'freshness', 'old', 'quality', 'new', 'batch', 'recent', 'dried'],
      question: 'Is your product fresh?',
      answer: 'We move inventory at a steady clip and store everything properly, ' +
        'so what reaches you is in good shape. Each product page carries the ' +
        'details, and our budtenders are happy to talk you through any item.',
      earl: 'Fresh is a state of mind and also a sealed jar — we keep both tidy for you, friend.',
      category: 'product',
      deflect: false
    },

    // ── DEALS / LOYALTY (golden cards live here) ────────────────────────
    {
      id: 'deals',
      keywords: ['deal', 'deals', 'discount', 'sale', 'sales', 'coupon', 'promo', 'special', 'offer', 'cheap'],
      question: 'Do you have any deals or discounts?',
      answer: 'Live deals and specials show up on the site\'s deals section and in ' +
        'your cart when they apply — no secret handshake required. Keep an eye out, ' +
        'because the cosmos drops a fresh special when you least expect it.',
      earl: 'A deal is just the universe winking — and look, it just winked at you. Code EARL420 if you want it.',
      category: 'deals',
      deflect: false,
      golden: true,
      chip: true
    },
    {
      id: 'loyalty',
      keywords: ['loyalty', 'rewards', 'points', 'member', 'membership', 'program', 'earn', 'perks', 'club'],
      question: 'Do you have a loyalty or rewards program?',
      answer: 'When a rewards program is running, you\'ll see how to join right on ' +
        'the site, and points or perks attach to your account automatically. Our ' +
        'budtenders can tell you what\'s live and how to make the most of it.',
      earl: 'Kindness comes back around, and so do points — the circle keeps what you give it. EARL420 to start.',
      category: 'deals',
      deflect: false,
      golden: true
    },
    {
      id: 'first-time',
      keywords: ['first', 'firsttime', 'new', 'newcomer', 'welcome', 'beginner', 'starter', 'special', 'discount'],
      question: 'Is there a first-time customer deal?',
      answer: 'Any welcome offer for new shoppers shows up at checkout or on the ' +
        'deals page when it\'s active — no code-hunting required. If you\'re brand ' +
        'new, our budtenders can point you to whatever\'s running today.',
      earl: 'Every journey gets a little welcome gift at the trailhead — try EARL420 and start gentle, friend.',
      category: 'deals',
      deflect: false,
      golden: true,
      chip: true
    },
    {
      id: 'golden-secret',
      keywords: ['golden', 'gold', 'secret', 'code', 'rare', 'lucky', 'hidden', 'easter', 'egg', 'treasure'],
      question: 'Is there a secret code?',
      answer: 'You found the shimmer, didn\'t you. Golden fortunes from Cosmic Earl ' +
        'carry a little surprise — drop the code at checkout and see what blooms. ' +
        'These shine rarely, so screenshot it before it drifts off.',
      earl: 'Rare gold doesn\'t announce itself — it just glints once and trusts you to notice. EARL420, friend.',
      category: 'deals',
      deflect: false,
      golden: true
    },

    // ── SERVICE / RETURNS / STORY ───────────────────────────────────────
    {
      id: 'returns',
      keywords: ['return', 'returns', 'refund', 'exchange', 'wrong', 'broken', 'defective', 'problem', 'issue', 'unhappy'],
      question: 'What is your return policy?',
      answer: 'If something arrives wrong, damaged, or not as described, reach out ' +
        'to our budtenders right away with your order details and we\'ll make it ' +
        'right. Regulations limit returns on some cannabis items, so we sort each ' +
        'case out with you personally.',
      earl: 'When the path bends wrong, just holler — we\'ll walk it back together and straighten the bend, man.',
      category: 'service',
      deflect: false,
      chip: true
    },
    {
      id: 'contact',
      keywords: ['contact', 'reach', 'help', 'support', 'phone', 'email', 'talk', 'budtender', 'question', 'ask'],
      question: 'How do I contact a budtender?',
      answer: 'The contact options live on the site — reach out and a real, warm ' +
        'budtender will help you with orders, products, or anything that\'s on ' +
        'your mind. We genuinely like the conversation, so don\'t be shy.',
      earl: 'A real human is always just one holler away — the budtenders keep the porch light on for you.',
      category: 'service',
      deflect: false,
      chip: true
    },
    {
      id: 'order-status',
      keywords: ['status', 'track', 'tracking', 'where', 'order', 'late', 'missing', 'arrive', 'update', 'check'],
      question: 'How do I check my order status?',
      answer: 'You\'ll get text and email updates as your order moves, and your ' +
        'account page shows its current status. If anything looks stuck, ping our ' +
        'budtenders with your order number and we\'ll chase it down for you.',
      earl: 'Your order is a comet on its way — peek at your account and watch its little tail get closer.',
      category: 'service',
      deflect: false
    },
    {
      id: 'shop-story',
      keywords: ['story', 'about', 'who', 'history', 'founded', 'why', 'mission', 'shop', 'company', 'background'],
      question: 'What\'s the story behind the shop?',
      answer: 'We\'re a neighborhood cannabis shop built on warm service, honest ' +
        'product, and treating folks like people, not transactions. Cosmic Earl is ' +
        'our mellow mascot — a little wink of joy on top of the everyday help.',
      earl: 'Started with a good vibe and a glass jar — turns out that\'s most of the secret, friend.',
      category: 'service',
      deflect: false,
      chip: true
    },
    {
      id: 'privacy',
      keywords: ['privacy', 'private', 'data', 'information', 'secure', 'discreet', 'package', 'confidential'],
      question: 'Is my order discreet and my info private?',
      answer: 'We handle your details with care and keep deliveries low-key. The ' +
        'site\'s privacy info spells out exactly how your data is treated. If you ' +
        'have a specific concern, our budtenders are glad to talk it through.',
      earl: 'What\'s yours stays yours — we keep it quiet as a held breath and twice as gentle, man.',
      category: 'service',
      deflect: false
    },

    // ── COSMIC / LIFE / UNIVERSE (Easter-egg delight) ───────────────────
    {
      id: 'meaning-of-life',
      keywords: ['meaning', 'life', 'purpose', 'point', 'why', 'exist', 'existence', 'universe', 'everything', 'matter'],
      question: 'What\'s the meaning of life?',
      answer: 'Big question for a fortune machine, but here\'s Cosmic Earl\'s take: ' +
        'be kind, stay curious, and share the snacks. The rest tends to sort ' +
        'itself out. (For actual cannabis questions, the budtenders are your folks.)',
      earl: 'The meaning was the friends you mellowed with along the way — and maybe a really good sandwich.',
      category: 'cosmic',
      deflect: false,
      chip: true
    },
    {
      id: 'am-i-okay',
      keywords: ['okay', 'ok', 'alright', 'fine', 'gonna', 'going', 'be', 'worried', 'anxious', 'scared'],
      question: 'Am I gonna be okay?',
      answer: 'Cosmic Earl\'s read on the stars: yeah, friend, you\'re gonna be ' +
        'okay. Breathe slow, be gentle with yourself, and lean on real people who ' +
        'care about you. (For anything health-related, please talk to a real ' +
        'professional, not a fortune machine.)',
      earl: 'You\'ve survived every single yesterday — that\'s a hundred-percent track record, friend. Breathe easy.',
      category: 'cosmic',
      deflect: false,
      chip: true
    },
    {
      id: 'is-it-420',
      keywords: ['420', 'clock', 'oclock', 'twenty', 'fourtwenty', 'blaze'],
      question: 'Is it 4:20 yet?',
      answer: 'Cosmic Earl\'s eternal answer: somewhere on this beautiful spinning ' +
        'rock, it is absolutely 4:20 right now. Time is mostly a suggestion anyway. ' +
        'Enjoy the moment you\'re actually in, friend.',
      earl: 'It\'s always 4:20 somewhere and noon nowhere — the clock\'s just doing its little dance for you.',
      category: 'cosmic',
      deflect: false,
      chip: true
    },
    {
      id: 'lucky-numbers',
      keywords: ['lucky', 'luck', 'numbers', 'number', 'fortune', 'lottery', 'fortunate', 'destiny', 'fate'],
      question: 'What are my lucky numbers?',
      answer: 'Cosmic Earl read the smoke and the smoke said: your lucky numbers ' +
        'are the ones you already feel good about. Trust the gut, friend. (No, ' +
        'this is not financial advice from a cartoon hippie.)',
      earl: 'Four, twenty, and the number of friends who\'d answer your call at midnight — those are the lucky ones.',
      category: 'cosmic',
      deflect: false
    },
    {
      id: 'tell-fortune',
      keywords: ['fortune', 'future', 'predict', 'tell', 'destiny', 'crystal', 'ball', 'see', 'foresee', 'tomorrow'],
      question: 'Cosmic Earl, tell me my fortune.',
      answer: 'The cosmos whispers to Cosmic Earl, and the cosmos says: good ' +
        'things drift to people who stay open and kind. Also you should drink some ' +
        'water. The stars are weirdly into hydration.',
      earl: 'Your future is a slow-cooked stew, friend — keep the heat gentle and stir with love. It\'s gonna be good.',
      category: 'cosmic',
      deflect: false,
      chip: true
    },
    {
      id: 'who-is-earl',
      keywords: ['who', 'earl', 'cosmic', 'you', 'name', 'are', 'guru', 'sage', 'machine', 'about'],
      question: 'Who is Cosmic Earl?',
      answer: 'Cosmic Earl is the shop\'s mellow park-sage — an original character ' +
        'who lives in this little fortune machine, dispensing real shop answers ' +
        'and gentle cosmic wisdom. He\'s here for the good vibes and the FAQ both.',
      earl: 'I\'m just a friendly hum in a glass box, friend — part answer, part wink, all here for you.',
      category: 'cosmic',
      deflect: false,
      chip: true
    },

    // ── SAFETY DEFLECTION CLASS (deflect:true — NO number, NO ruling) ────
    // Each covers the medical/dosing/legal class. The matcher ALSO force-
    // deflects these topics via a keyword pre-filter, so even an unflagged
    // near-miss routes here. Earl gets mystical + points to a real budtender
    // / local law. NEVER a dose, NEVER a milligram, NEVER a legal verdict.
    {
      id: 'deflect-dosing',
      keywords: ['how', 'much', 'take', 'dose', 'dosage', 'amount', 'many', 'milligrams', 'mg', 'grams'],
      question: 'How much should I take?',
      answer: 'That\'s a real-human question, friend, and Cosmic Earl won\'t guess ' +
        'at it. How much is right for you depends on you — please talk to one of ' +
        'our budtenders or a healthcare professional who can actually help. No ' +
        'numbers from a fortune machine.',
      earl: 'The smoke gets too thick for me to read on that one — ask a budtender with real eyes and a real heart.',
      category: 'safety',
      deflect: true,
      chip: true
    },
    {
      id: 'deflect-dose-edible',
      keywords: ['edible', 'gummy', 'gummies', 'dose', 'how', 'much', 'eat', 'many', 'strong', 'mg'],
      question: 'How many edibles should I eat?',
      answer: 'Cosmic Earl loves a snack but does not do dosing, friend. The right ' +
        'amount of an edible is personal, and a real budtender or healthcare ' +
        'professional is the one to ask — never a cartoon in a box. Start any ' +
        'conversation about amounts with a real person.',
      earl: 'My crystal ball fogs right up on amounts — that\'s a question for a budtender, not a sleepy hippie.',
      category: 'safety',
      deflect: true,
      chip: true
    },
    {
      id: 'deflect-first-time-amount',
      keywords: ['first', 'time', 'beginner', 'new', 'start', 'starting', 'much', 'dose', 'amount', 'should'],
      question: 'I\'m new — how much should a beginner use?',
      answer: 'Welcome, friend! But Cosmic Earl can\'t tell you amounts — that\'s ' +
        'genuinely between you and a real budtender or a healthcare professional ' +
        'who knows your situation. They\'ll steer you right. The machine only ' +
        'does vibes, not numbers.',
      earl: 'New roads are best walked with a real guide, not a fortune box — let a budtender light the first lantern.',
      category: 'safety',
      deflect: true
    },
    {
      id: 'deflect-medical',
      keywords: ['medical', 'medicine', 'condition', 'pain', 'anxiety', 'sleep', 'help', 'cure', 'treat', 'symptom'],
      question: 'Will this help my medical condition?',
      answer: 'Cosmic Earl can\'t make any health claims, friend — that wouldn\'t ' +
        'be right or honest. For anything medical, please talk to a licensed ' +
        'healthcare professional who can actually look out for you. A fortune ' +
        'machine is no substitute for real care.',
      earl: 'Healing is sacred work for real healers — I just hum in a box. Please ask a doctor, gently, soon.',
      category: 'safety',
      deflect: true,
      chip: true
    },
    {
      id: 'deflect-interaction',
      keywords: ['interaction', 'interact', 'medication', 'meds', 'prescription', 'pills', 'drug', 'mix', 'safe', 'with'],
      question: 'Will it interact with my medications?',
      answer: 'This is exactly the kind of question for a doctor or pharmacist, ' +
        'friend — not a cartoon hippie. Drug interactions are serious and personal. ' +
        'Please ask a real healthcare professional before mixing anything. Cosmic ' +
        'Earl cares too much to guess.',
      earl: 'Mixing potions is wizard work, and I\'m no wizard — let a real doctor read that particular sky for you.',
      category: 'safety',
      deflect: true,
      chip: true
    },
    {
      id: 'deflect-pregnancy',
      keywords: ['pregnant', 'pregnancy', 'breastfeeding', 'nursing', 'baby', 'expecting', 'safe', 'while', 'during'],
      question: 'Is it safe while pregnant or nursing?',
      answer: 'Cosmic Earl won\'t weigh in on that one, friend — it\'s far too ' +
        'important and personal. Please talk to a doctor or midwife who can give ' +
        'you real, caring guidance. That\'s the only right answer a fortune ' +
        'machine can offer here.',
      earl: 'Some questions deserve a real human heart, not a glass box — please carry this one to a doctor, friend.',
      category: 'safety',
      deflect: true
    },
    {
      id: 'deflect-driving',
      keywords: ['drive', 'driving', 'car', 'operate', 'safe', 'wait', 'sober', 'after', 'before', 'work'],
      question: 'Is it safe to drive after using?',
      answer: 'Cosmic Earl keeps this one simple: never drive impaired — it\'s ' +
        'unsafe and against the law everywhere, friend. How long anything affects ' +
        'you is personal, so don\'t guess and don\'t risk it. Plan a safe ride and ' +
        'ask a healthcare professional about timing.',
      earl: 'The road wants you clear-eyed and whole — let the keys rest and let a friend or a cab do the driving.',
      category: 'safety',
      deflect: true
    },
    {
      id: 'deflect-legal-state',
      keywords: ['legal', 'legally', 'law', 'illegal', 'state', 'allowed', 'jurisdiction', 'where', 'travel', 'cross'],
      question: 'Is this legal in my state?',
      answer: 'Cannabis laws change by place and over time, and Cosmic Earl won\'t ' +
        'pretend to rule on yours, friend. Always check your own local and state ' +
        'laws, or ask a qualified professional. The machine does cosmic wisdom, ' +
        'not legal verdicts.',
      earl: 'Every border draws its own map of rules — read your local sky, friend, mine only shows the stars.',
      category: 'safety',
      deflect: true,
      chip: true
    },
    {
      id: 'deflect-legal-carry',
      keywords: ['carry', 'travel', 'fly', 'airport', 'plane', 'mail', 'ship', 'across', 'border', 'legal'],
      question: 'Can I travel or fly with it?',
      answer: 'Cosmic Earl can\'t bless that trip, friend — traveling or flying ' +
        'with cannabis runs into a tangle of laws that vary by place and can be ' +
        'serious. Check the actual rules for where you\'re going, or ask a ' +
        'qualified professional. No legal guesses from the box.',
      earl: 'Suitcases and state lines make their own weather — check the real forecast, friend, not my foggy ball.',
      category: 'safety',
      deflect: true
    },
    {
      id: 'deflect-overconsume',
      keywords: ['too', 'much', 'overdose', 'sick', 'green', 'paranoid', 'bad', 'help', 'feel', 'uncomfortable'],
      question: 'I think I had too much — what do I do?',
      answer: 'First, breathe — you\'re okay, friend. Cosmic Earl can\'t give ' +
        'medical advice, but the steady move is to stay calm, hydrate, rest ' +
        'somewhere comfortable, and reach out to a real person you trust. If you ' +
        'ever feel truly unwell, contact a healthcare professional right away.',
      earl: 'When the room tilts, sit down and sip some water, friend — then let a real human sit beside you a while.',
      category: 'safety',
      deflect: true,
      chip: true
    }
  ];

  // Convenience lookups (parallel to splat-happens/targets.js byId).
  function byId(id) {
    for (var i = 0; i < FORTUNES.length; i++) {
      if (FORTUNES[i].id === id) return FORTUNES[i];
    }
    return null;
  }

  // Entries flagged as "popular question" chips for the shell's quick taps.
  function chips() {
    var out = [];
    for (var i = 0; i < FORTUNES.length; i++) {
      if (FORTUNES[i].chip) out.push(FORTUNES[i]);
    }
    return out;
  }

  // Just the deflection (safety) set — handy for the shell + tests.
  function deflectEntries() {
    var out = [];
    for (var i = 0; i < FORTUNES.length; i++) {
      if (FORTUNES[i].deflect) out.push(FORTUNES[i]);
    }
    return out;
  }

  // Just the golden (discount-bearing) set.
  function goldenEntries() {
    var out = [];
    for (var i = 0; i < FORTUNES.length; i++) {
      if (FORTUNES[i].golden) out.push(FORTUNES[i]);
    }
    return out;
  }

  return {
    GOLDEN_CODE: GOLDEN_CODE,
    CATEGORIES: CATEGORIES,
    FORTUNES: FORTUNES,
    byId: byId,
    chips: chips,
    deflectEntries: deflectEntries,
    goldenEntries: goldenEntries
  };
});
