/** Which icon an output device gets, guessed from its Windows name (which follows the Windows language). Headphones first, so "Headset Earphone" is not a speaker. */
export function outputIcon(name: string): "headphones" | "speaker-hifi" | "speaker" {
  const n = name.toLowerCase();
  if (/headphone|headset|earphone|earbud|buds|airpods|kopfh|casque|écouteur|cuffie|auricular|fones? de ouvido/.test(n)) return "headphones";
  if (/speaker|lautsprecher|haut-parleur|altoparlant|altavo|alto-falante/.test(n)) return "speaker-hifi";
  return "speaker";
}
