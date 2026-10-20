// The class code for the day (like uploadmymodel's class phrase, shared/slicing.js there). The
// teacher opens a room with a code on the board; students type it once to join. Pure JS, no DOM:
// the pages, the Worker, the Room and the Node tests all use it. The numbers live in protocol.js.
//
// The code is the only lock on a room, so it must be too many to guess. The Worker allows
// JOIN_RATE_IP (60) tries a minute from one address (a school shares one, so never fewer than a
// class needs), and on top of that a device is locked out after 5 wrong tries in a row
// (src/lockout.js). A suggested code is one of CODE_COUNT (about 450 million, over 2^28): one
// address trying all day (a room lives at most OPEN_MAX_MS, 24 hours) gets 60 x 60 x 24 = 86,400
// tries, about a 1 in 5,200 chance. A teacher's own code may be anything with a letter or number
// (Dalton's choice): a short one is guessable from outside the class, which the rate limit and
// lockout only slow down. The page still offers a strong suggestion.

import { CLASS_PERIOD_MIN, CODE_MAX, CODE_MIN_CHARS, CODE_MIN_PARTS, OPEN_MAX_MS, OPEN_MIN_MS } from './protocol.js';

/** "Blue Robot  Pancake 42" -> "blue-robot-pancake-42". Case, spaces and dashes do not matter. */
export function normalizeCode(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s_-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** "golden-walrus-lantern-42" -> "golden walrus lantern 42" (how the board shows it). */
export function displayCode(code) {
  return normalizeCode(code).replace(/-/g, ' ');
}

// The same word lists as uploadmymodel (copied, kid-safe, checked there): plain words a class can
// read off a whiteboard and type: a describing word, an animal, a thing. Left out on purpose: names,
// body words, words with a second meaning kids would giggle at, and spellings kids trip on.
// Removed 2026-10-05 (Dalton): pancake and waffle ("blue pancake" / "blue waffle"), starfish (slang),
// brown (brown + a food word). Add
// words freely; remove one only while CODE_COUNT stays at 2^28 or more (test/code.test.mjs).
export const CODE_WORDS = [
  [
    'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'silver', 'golden', 'bronze',
    'copper', 'indigo', 'teal', 'navy', 'lime', 'crimson', 'maroon', 'tiny', 'mini',
    'round', 'square', 'curly', 'spiky', 'fluffy', 'fuzzy', 'bumpy', 'shiny', 'sparkly', 'glowing',
    'frosty', 'snowy', 'rainy', 'windy', 'cloudy', 'foggy', 'icy', 'chilly', 'warm', 'crispy',
    'crunchy', 'smooth', 'silky', 'velvet', 'striped', 'spotted', 'dotted', 'plaid', 'happy',
    'sleepy', 'jolly', 'brave', 'calm', 'quiet', 'clever', 'gentle', 'kind', 'proud', 'lucky',
    'merry', 'friendly', 'cheerful', 'curious', 'eager', 'bold', 'noble', 'wise', 'polite',
    'patient', 'busy', 'silly', 'zany', 'bouncy', 'jumpy', 'grumpy', 'sneaky', 'speedy', 'rapid',
    'swift', 'quick', 'nimble', 'sturdy', 'steady', 'wooden', 'paper', 'plastic', 'metal', 'steel',
    'iron', 'glass', 'stone', 'marble', 'cotton', 'denim', 'modern', 'royal', 'secret', 'magic',
    'cosmic', 'atomic', 'ocean', 'polar', 'tropical', 'lunar', 'solar', 'electric', 'turbo',
    'super', 'mega', 'ultra', 'laser', 'pixel', 'digital', 'robotic', 'sour', 'tangy', 'minty',
    'cheesy', 'toasty', 'buttery', 'loud', 'humming', 'famous', 'fancy', 'fearless', 'hidden',
    'honest', 'humble', 'neat', 'nifty', 'plain', 'rare', 'snappy', 'tidy', 'tricky', 'trusty',
    'twisty', 'zippy', 'breezy', 'bright', 'crisp', 'epic', 'frozen', 'glossy', 'grand', 'handy',
    'lively', 'mellow', 'peppy', 'plucky', 'puffy', 'quirky', 'radiant', 'sleek', 'stellar',
    'upbeat', 'vivid', 'wacky',
  ],
  [
    'ant', 'bear', 'beetle', 'bison', 'buffalo', 'camel', 'canary', 'caribou', 'cheetah',
    'chipmunk', 'cobra', 'condor', 'coyote', 'crab', 'crane', 'cricket', 'crow', 'deer', 'dingo',
    'dolphin', 'dove', 'dragonfly', 'duck', 'eagle', 'eel', 'elk', 'emu', 'falcon', 'ferret',
    'finch', 'flamingo', 'fox', 'frog', 'gazelle', 'gecko', 'gerbil', 'gibbon', 'giraffe', 'goat',
    'goldfish', 'goose', 'gopher', 'gorilla', 'hamster', 'hare', 'hawk', 'hedgehog', 'heron',
    'hippo', 'hornet', 'horse', 'hyena', 'ibis', 'iguana', 'impala', 'jackal', 'jaguar',
    'jellyfish', 'kangaroo', 'kiwi', 'koala', 'lemur', 'lion', 'lizard', 'llama', 'lobster', 'lynx',
    'macaw', 'magpie', 'manatee', 'marmot', 'meerkat', 'mongoose', 'moose', 'moth', 'mouse',
    'narwhal', 'newt', 'ocelot', 'octopus', 'orca', 'ostrich', 'otter', 'owl', 'panda', 'panther',
    'parrot', 'pelican', 'penguin', 'pigeon', 'pony', 'poodle', 'porcupine', 'puffin', 'puma',
    'python', 'quail', 'rabbit', 'reindeer', 'rhino', 'salmon', 'seal', 'shark', 'sheep', 'sloth',
    'snail', 'sparrow', 'spider', 'squid', 'stingray', 'stork', 'swan', 'tapir', 'tiger', 'toad',
    'toucan', 'trout', 'tuna', 'turtle', 'viper', 'vulture', 'walrus', 'wasp', 'whale', 'wolf',
    'wombat', 'yak', 'zebra', 'alpaca', 'badger', 'beagle', 'bulldog', 'collie', 'terrier', 'corgi',
    'lamb', 'bunny', 'kitten', 'puppy', 'duckling', 'cub', 'fawn', 'foal', 'ladybug',
    'bumblebee', 'firefly', 'grasshopper', 'caterpillar', 'termite', 'scorpion', 'tarantula',
    'armadillo', 'anteater', 'hummingbird', 'kingfisher', 'osprey', 'albatross', 'cardinal',
    'parakeet', 'platypus', 'wallaby', 'salamander', 'crocodile', 'alligator', 'marlin',
    'swordfish', 'pufferfish', 'clownfish', 'sardine', 'oyster', 'clam', 'beluga', 'unicorn',
    'dragon', 'yeti', 'hen', 'mammoth',
  ],
  [
    'comet', 'planet', 'meteor', 'galaxy', 'rocket', 'star', 'orbit', 'nebula', 'asteroid',
    'satellite', 'crater', 'rainbow', 'thunder', 'cloud', 'breeze', 'blizzard', 'tornado',
    'volcano', 'glacier', 'canyon', 'island', 'meadow', 'forest', 'river', 'lagoon', 'valley',
    'mountain', 'pebble', 'boulder', 'waterfall', 'puddle', 'iceberg', 'acorn', 'pinecone', 'maple',
    'cactus', 'fern', 'tulip', 'clover', 'sunflower', 'seashell', 'pretzel',
    'bagel', 'noodle', 'pizza', 'cookie', 'cupcake', 'popcorn', 'pumpkin', 'apple', 'lemon',
    'mango', 'grape', 'pear', 'potato', 'tomato', 'pasta', 'burrito', 'sandwich', 'toast',
    'cereal', 'oatmeal', 'jelly', 'cheese', 'butter', 'smoothie', 'lemonade', 'cocoa', 'gumdrop',
    'lollipop', 'jellybean', 'pudding', 'dumpling', 'lantern', 'castle', 'bridge', 'tower',
    'anchor', 'arrow', 'backpack', 'balloon', 'basket', 'bell', 'bicycle', 'blanket', 'bucket',
    'button', 'camera', 'candle', 'compass', 'crayon', 'drum', 'feather', 'flag', 'flute', 'guitar',
    'hammock', 'helmet', 'kettle', 'kite', 'ladder', 'magnet', 'mitten', 'mirror', 'notebook',
    'paddle', 'parachute', 'pencil', 'piano', 'pillow', 'puzzle', 'radio', 'ribbon', 'sailboat',
    'scooter', 'shovel', 'skateboard', 'sled', 'spoon', 'teapot', 'telescope', 'tent', 'ticket',
    'trumpet', 'tractor', 'trophy', 'umbrella', 'violin', 'wagon', 'whistle', 'windmill', 'zipper',
    'domino', 'trampoline', 'igloo', 'lighthouse', 'submarine', 'train', 'canoe', 'kayak',
    'jetpack', 'glider', 'blimp', 'tugboat', 'airship', 'eraser', 'marker', 'sticker', 'envelope',
    'postcard', 'clock', 'gadget', 'gizmo', 'widget', 'lamp', 'bench', 'toolbox', 'wrench', 'gear',
    'pulley', 'lever', 'battery', 'keyboard', 'printer', 'antenna', 'sensor', 'beacon', 'banner',
    'crown', 'treasure', 'coin', 'medal', 'map', 'globe', 'atlas', 'robot',
  ],
];
// Then a number from 10 to 99 (no leading zero to get wrong).
const NUMBERS = 90;

export const CODE_COUNT = CODE_WORDS.reduce((n, list) => n * list.length, NUMBERS);

// crypto, not Math.random: one code must say nothing about the next.
function cryptoRandom() {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}

/** Three easy words and a number for the board, e.g. "golden-walrus-lantern-42". */
export function generateCode(random = cryptoRandom) {
  const words = CODE_WORDS.map((list) => list[Math.floor(random() * list.length)]);
  return [...words, 10 + Math.floor(random() * NUMBERS)].join('-');
}

/** A class code the teacher typed (or took from the suggestion): { ok, code } or { ok: false, error, message }. */
export function validateCode(text) {
  const code = normalizeCode(text);
  if (!code) return { ok: false, error: 'code', message: 'Type a class code, or use the suggestion.' };
  if (code.length > CODE_MAX) return { ok: false, error: 'code', message: `That class code is too long. Use up to ${CODE_MAX} letters and numbers.` };
  const parts = code.split('-');
  if (parts.length < CODE_MIN_PARTS || parts.join('').length < CODE_MIN_CHARS) {
    return { ok: false, error: 'code', message: 'Type a class code with at least one letter or number.' };
  }
  return { ok: true, code };
}

/** When a room opened now should close: the teacher's `until`, if it is a time we allow. */
export function validateUntil(until, now = Date.now()) {
  return Number.isSafeInteger(until) && until >= now + OPEN_MIN_MS && until <= now + OPEN_MAX_MS;
}

/**
 * The host page's "Open until" choices as absolute times (the teacher's own clock and time zone):
 * 'period' = one class period from now, 'day' = the end of today (local midnight). The end of
 * today is never less than one period away, so a room opened late in the day still lasts a class.
 */
export function untilFor(choice, now = new Date()) {
  const period = now.getTime() + CLASS_PERIOD_MIN * 60_000;
  if (choice === 'period') return period;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - 1000;
  return Math.max(period, Math.min(midnight, now.getTime() + OPEN_MAX_MS));
}
