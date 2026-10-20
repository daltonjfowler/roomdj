// Draws the RoomDJ icon: the family robot face and upload-arrow hat, wearing headphones (band
// over the head, a cup on each side) with two music notes floating beside it.
// The look (ink outline, hand-drawn wobble) lives in scripts/icon-kit.mjs, shared by all the sites.
// Usage: node scripts/make-icons.mjs web/public
import { circle, curve, inked, poly, rrect, tag, tile, writeIcons } from './icon-kit.mjs';

const OUT = process.argv[2] || '.';
// Family colours: grey face, deep tile of the site's colour, arrow in a brighter tint of it.
const BG = '#831843', FACE = '#AEB6C0', ARROW = '#F472B6', INK = '#3B0A1E';
const WHITE = '#FFFFFF', DARK = '#0F3D40';
const BAND = '#4B5563', CUP = '#DB2777', PAD = '#F9A8D4', NOTE = '#FCE7F3';

// A music note: head, stem and a little flag. Kept short so it floats, never hangs.
const note = (x, y, s) => [
  circle(x, y, 2.5 * s, NOTE),
  rrect(x + 1.5 * s, y - 8 * s, 1.4 * s, 8 * s, 0.4 * s, NOTE),
  curve(x + 2.2 * s, y - 7.6 * s, x + 5.6 * s, y - 6.4 * s, x + 5 * s, y - 3.4 * s, 1.4 * s, NOTE),
];

writeIcons(OUT, [
  tile(BG),
  // headphone band first, so the arrow hat and the face sit on top of it
  ...inked([curve(11.5, 27, 32, -6, 52.5, 27, 3.2, BAND)], INK),
  ...inked([poly([[32, 5], [23, 15], [41, 15]], ARROW), rrect(29, 14, 6, 7, 0, ARROW)], INK),
  ...inked([curve(19, 42, 10.5, 45, 14, 52.5, 3.6, FACE), curve(45, 42, 53.5, 44.5, 49, 52, 3.6, FACE)], INK),
  ...inked([rrect(14, 20, 36, 25, 7, FACE)], INK),
  // ear cups on the sides of the face
  ...tag('cups', [...inked([rrect(7.5, 24.5, 8.5, 15, 3.6, CUP), rrect(48, 24.5, 8.5, 15, 3.6, CUP)], INK),
    rrect(10.6, 27, 3, 10, 1.4, PAD), rrect(50.4, 27, 3, 10, 1.4, PAD)]),
  curve(27, 38, 32, 42.5, 37, 38, 2.6, DARK),
  ...tag('blink', [circle(25, 30, 3.6, DARK), circle(39, 30, 3.6, DARK), circle(26.2, 28.8, 1.1, WHITE), circle(40.2, 28.8, 1.1, WHITE)]),
  ...tag('note1', inked(note(52, 13, 1), INK)),
  ...tag('note2', inked(note(9.5, 14, 0.85), INK)),
], 'RoomDJ icon: the family robot wearing headphones, with music notes floating by.', `
  .note1 { animation: bob 1.6s ease-in-out infinite; }
  .note2 { animation: bob 1.6s ease-in-out -0.8s infinite; }
  @keyframes bob { 0%, 100% { transform: translate(0, 0) rotate(0deg); } 50% { transform: translate(0.6px, -2.4px) rotate(-8deg); } }
  .cups { animation: thump 0.8s ease-in-out infinite; }
  @keyframes thump { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }`);
