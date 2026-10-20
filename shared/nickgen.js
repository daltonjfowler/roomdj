// Student nicknames are made, never typed (Dalton, 2026-10-14: "auto-generate with an adj and noun,
// school appropriate"): "Brave Otter". The page picks one (🎲 for another); the server takes only a
// name built from these two lists (isGeneratedNick), so no typed word ever reaches the room and no
// AI nickname check is needed. Pure JS: pages, the Worker and the Node tests.
//
// Picked so that NO pair reads badly: positive adjectives with no colors (a color + an animal can be
// a slur), nothing physical ("hot", "wet", "big", "thick"), nothing that insults ("slow", "crazy");
// nouns are animals, space, nature and food with no slang meaning (no monkey, pig, cow, beaver,
// muffin, pickle, nuts). test/nickgen.test.mjs runs every pair through the nickname word lists.

// Grown 2026-10-14 (Dalton: "way more variety"): about 170 x 190 (32,000+ names). Words are at most 10 + 9 letters so
// every pair fits NICK_MAX. Before adding one, say every pair out loud in a middle-school voice.
export const NICK_ADJECTIVES = Object.freeze([
  // the first 60
  'Brave', 'Bright', 'Breezy', 'Calm', 'Cheerful', 'Chill', 'Clever', 'Cosmic', 'Cozy', 'Curious',
  'Daring', 'Eager', 'Electric', 'Epic', 'Fearless', 'Friendly', 'Gentle', 'Golden', 'Groovy', 'Happy',
  'Helpful', 'Honest', 'Jazzy', 'Jolly', 'Kind', 'Lively', 'Lucky', 'Magic', 'Mellow', 'Mighty',
  'Neon', 'Noble', 'Patient', 'Polite', 'Proud', 'Quick', 'Quiet', 'Rapid', 'Royal', 'Shiny',
  'Silver', 'Smart', 'Snappy', 'Sparkly', 'Speedy', 'Steady', 'Stellar', 'Sunny', 'Super', 'Swift',
  'Tidy', 'Turbo', 'Upbeat', 'Vivid', 'Wise', 'Witty', 'Zippy', 'Atomic', 'Bold', 'Merry',
  // added
  'Agile', 'Amazing', 'Awesome', 'Brilliant', 'Bubbly', 'Busy', 'Candid', 'Careful', 'Caring', 'Charming',
  'Chipper', 'Classic', 'Clear', 'Cool', 'Crafty', 'Creative', 'Crisp', 'Dapper', 'Dazzling', 'Dandy',
  'Dreamy', 'Dynamic', 'Elegant', 'Energetic', 'Fancy', 'Fantastic', 'Festive', 'Fiery', 'Flying',
  'Focused', 'Fresh', 'Frosty', 'Funky', 'Gallant', 'Glowing', 'Grand', 'Grateful', 'Handy', 'Hearty',
  'Heroic', 'Hopeful', 'Humble', 'Icy', 'Jumpy', 'Keen', 'Laughing', 'Legendary', 'Loyal', 'Majestic',
  'Mindful', 'Modern', 'Mystic', 'Nifty', 'Nimble', 'Peppy', 'Playful', 'Plucky', 'Polished', 'Popular',
  'Positive', 'Powerful', 'Precise', 'Prime', 'Quirky', 'Radiant', 'Ready', 'Regal', 'Relaxed', 'Reliable',
  'Rustic', 'Savvy', 'Serene', 'Sharp', 'Sincere', 'Skillful', 'Sleek', 'Smiley', 'Snowy', 'Social',
  'Solar', 'Sonic', 'Sparky', 'Spirited', 'Splendid', 'Spry', 'Starry', 'Stormy', 'Strong', 'Stylish',
  'Supreme', 'Thoughtful', 'Timely', 'Tranquil', 'Trusty', 'Ultra', 'Unique', 'Valiant', 'Vibrant', 'Victorious',
  'Warm', 'Whimsical', 'Windy', 'Winning', 'Zany', 'Zesty', 'Zen', 'Wild', 'Bouncy', 'Toasty',
]);

export const NICK_NOUNS = Object.freeze([
  // the first 60
  'Otter', 'Falcon', 'Panda', 'Koala', 'Dolphin', 'Penguin', 'Fox', 'Owl', 'Tiger', 'Lion',
  'Eagle', 'Hawk', 'Turtle', 'Squirrel', 'Hedgehog', 'Llama', 'Alpaca', 'Moose', 'Bison', 'Puffin',
  'Parrot', 'Toucan', 'Lynx', 'Badger', 'Raccoon', 'Walrus', 'Narwhal', 'Orca', 'Gecko', 'Iguana',
  'Comet', 'Rocket', 'Planet', 'Meteor', 'Galaxy', 'Nebula', 'Robot', 'Wizard', 'Ranger', 'Voyager',
  'Maple', 'Cactus', 'Acorn', 'Pebble', 'Thunder', 'Tornado', 'Volcano', 'Glacier', 'River', 'Canyon',
  'Waffle', 'Pancake', 'Pretzel', 'Taco', 'Mango', 'Cookie', 'Donut', 'Biscuit', 'Kiwi', 'Quokka',
  // added: animals
  'Jaguar', 'Cheetah', 'Leopard', 'Bobcat', 'Wolf', 'Coyote', 'Rhino', 'Zebra', 'Giraffe', 'Elephant',
  'Kangaroo', 'Wombat', 'Platypus', 'Lemur', 'Meerkat', 'Ferret', 'Chipmunk', 'Corgi', 'Beagle', 'Collie',
  'Robin', 'Sparrow', 'Finch', 'Cardinal', 'Pelican', 'Flamingo', 'Heron', 'Crane', 'Condor', 'Osprey',
  'Kestrel', 'Raven', 'Magpie', 'Macaw', 'Octopus', 'Squid', 'Seahorse', 'Stingray', 'Manatee',
  'Beluga', 'Marlin', 'Lobster', 'Tortoise', 'Chameleon', 'Firefly', 'Beetle', 'Cricket', 'Butterfly', 'Dragonfly',
  // space, nature
  'Asteroid', 'Orbit', 'Quasar', 'Pulsar', 'Saturn', 'Jupiter', 'Neptune', 'Eclipse', 'Aurora', 'Starship',
  'Astronaut', 'Mountain', 'Summit', 'Meadow', 'Forest', 'Island', 'Lagoon', 'Geyser', 'Boulder', 'Breeze',
  'Blizzard', 'Cyclone', 'Avalanche', 'Sequoia', 'Willow', 'Cedar', 'Fern', 'Clover', 'Sunflower', 'Tulip',
  'Lotus', 'Bamboo', 'Coral', 'Prism',
  // music (it's RoomDJ), things, legends
  'Melody', 'Rhythm', 'Tempo', 'Chorus', 'Encore', 'Echo', 'Remix', 'Vinyl', 'Jukebox', 'Banjo',
  'Cello', 'Violin', 'Ukulele', 'Saxophone', 'Piano', 'Guitar', 'Pixel', 'Gadget', 'Laser', 'Lantern',
  'Anchor', 'Kite', 'Dragon', 'Phoenix', 'Griffin', 'Unicorn', 'Yeti', 'Kraken', 'Pegasus', 'Sphinx',
  'Titan', 'Knight', 'Ninja', 'Pirate', 'Viking',
  // food with no slang meaning
  'Bagel', 'Burrito', 'Dumpling', 'Nacho', 'Popcorn', 'Pizza', 'Cupcake', 'Smoothie', 'Sprinkle', 'Avocado',
  'Ramen', 'Sushi', 'Churro', 'Nugget',
]);

const ADJ = new Set(NICK_ADJECTIVES);
const NOUN = new Set(NICK_NOUNS);

/** A random "Adjective Noun". `random()` → [0, 1). */
export function generateNick(random = Math.random) {
  const pick = (list) => list[Math.floor(random() * list.length) % list.length];
  return `${pick(NICK_ADJECTIVES)} ${pick(NICK_NOUNS)}`;
}

/** True only for a name generateNick can make (exactly; spacing already collapsed). */
export function isGeneratedNick(nick) {
  const parts = String(nick ?? '').split(' ');
  return parts.length === 2 && ADJ.has(parts[0]) && NOUN.has(parts[1]);
}
