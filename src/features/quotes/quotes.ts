// Short lines for the hard hours. All public domain: authors dead for centuries, translations published before 1929.

export interface Quote { text: string; author: string; source: string }

export const QUOTES: Quote[] = [
  { text: "Very little indeed is necessary for living a happy life.", author: "Marcus Aurelius", source: "Meditations VII, tr. George Long" },
  { text: "Such as are thy habitual thoughts, such also will be the character of thy mind.", author: "Marcus Aurelius", source: "Meditations V, tr. George Long" },
  { text: "No longer talk at all about the kind of man that a good man ought to be, but be such.", author: "Marcus Aurelius", source: "Meditations X, tr. George Long" },
  { text: "While we are postponing, life speeds by.", author: "Seneca", source: "Letters to Lucilius I, tr. R. M. Gummere" },
  { text: "Men are disturbed not by the things which happen, but by the opinions about the things.", author: "Epictetus", source: "Enchiridion 5, tr. George Long" },
  { text: "First say to yourself what you would be; and then do what you have to do.", author: "Epictetus", source: "Discourses III, tr. George Long" },
  { text: "Our life is frittered away by detail. Simplify, simplify.", author: "Henry David Thoreau", source: "Walden" },
  { text: "It is not enough to be industrious; so are the ants. What are you industrious about?", author: "Henry David Thoreau", source: "Letter to H. G. O. Blake, 1857" },
  { text: "Nothing great was ever achieved without enthusiasm.", author: "Ralph Waldo Emerson", source: "Circles" },
  { text: "Lost time is never found again.", author: "Benjamin Franklin", source: "Poor Richard's Almanack" },
  { text: "Well done is better than well said.", author: "Benjamin Franklin", source: "Poor Richard's Almanack" },
  { text: "The superior man is modest in his speech, but exceeds in his actions.", author: "Confucius", source: "Analects XIV, tr. James Legge" },
  { text: "A journey of a thousand miles begins with a single step.", author: "Lao Tzu", source: "Tao Te Ching 64" },
];

/** The quote for a day (same all day, a different one tomorrow), moved on by `skip` presses of Next. */
export function quoteIndex(now: number, skip: number, count = QUOTES.length): number {
  const d = new Date(now);
  const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
  return (((day + skip) % count) + count) % count;
}
