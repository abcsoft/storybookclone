// Catalogue fixture (V2 Phase 2).
//
// WHAT THIS FILE IS NOW
// It is the LOCAL-DEV / FRESH-INSTALL fixture catalogue that
// `bootstrapLocalDefaults()` (src/index.tsx) inserts when `products` is empty.
// The CMS, collections, prices and reviews are NOT here any more — they live in
// the database (migrations 0020-0023 + src/cms.ts / src/catalog.ts /
// src/reviews.ts), so the storefront cannot drift back to hard-coded content.
//
// ORIGINAL CONTENT ONLY (SF-01, §12 Phase 2 item 1). Every title, tagline,
// description and story below was written for this project. Nothing is copied
// from the reference catalogue — no reference title, artwork, story text,
// review, statistic or endorsement appears here. The cover paths point at the
// project's own generated art (scripts/generate-original-art.mjs).
//
// TRUTHFULNESS: `reviews` and `rating` are 0 for every row. The previous
// fixture carried invented figures (1842 reviews, 4.9 stars) that had no review
// rows behind them; migration 0022 neutralises those columns and the storefront
// derives any aggregate from the real `reviews` table.

export type { Product } from './product'
import type { Product } from './product'

type CatalogueEntry = Omit<Product, 'id' | 'active' | 'traits'> & { traits: string[] }

export const products: CatalogueEntry[] = [
  {
    slug: 'the-lantern-and-the-long-night',
    title: 'The Lantern and the Long Night',
    tagline: 'A small light carried a long way home',
    description: 'A child sets out before dawn with one lantern and a list of neighbours to check on.',
    story: 'The night is longer than it should be, and the path home keeps folding back on itself. One lantern, one careful step at a time, and a village that is still awake when the morning finally comes.',
    price: 34.99,
    image: '/static/img/art/cover-the-lantern-and-the-long-night.svg',
    gender: 'girl',
    category: 'book',
    ages: '4–8',
    ageMin: 4,
    ageMax: 8,
    pages: 32,
    reviews: 0,
    rating: 0,
    bestseller: true,
    traits: ['A quiet bravery story', '32 illustrated pages', 'Review every page before ordering']
  },
  {
    slug: 'captain-of-the-cardboard-sea',
    title: 'Captain of the Cardboard Sea',
    tagline: 'One box, one ocean, one very serious captain',
    description: 'A cardboard box becomes a ship, and the living room becomes open water.',
    story: 'The box arrived on Tuesday. By Wednesday it was a ship with a flag, a crew of one, and a horizon that ran from the sofa to the kitchen door.',
    price: 34.99,
    image: '/static/img/art/cover-captain-of-the-cardboard-sea.svg',
    gender: 'unisex',
    category: 'book',
    ages: '3–7',
    ageMin: 3,
    ageMax: 7,
    pages: 28,
    reviews: 0,
    rating: 0,
    bestseller: true,
    traits: ['Play and imagination', '28 illustrated pages', 'Name and age written into the text']
  },
  {
    slug: 'the-quiet-drum',
    title: 'The Quiet Drum',
    tagline: 'The loudest sound is the one you keep inside',
    description: 'A child who is told to be quieter finds a way to be heard anyway.',
    story: 'Everyone says the drum is too loud for the house. So it is practised in secret, softly, until the day the whole street needs a rhythm to walk to.',
    price: 34.99,
    image: '/static/img/art/cover-the-quiet-drum.svg',
    gender: 'unisex',
    category: 'book',
    ages: '4–9',
    ageMin: 4,
    ageMax: 9,
    pages: 32,
    reviews: 0,
    rating: 0,
    traits: ['Feelings and self-expression', '32 illustrated pages', 'Dedication page included']
  },
  {
    slug: 'the-moon-garden',
    title: 'The Moon Garden',
    tagline: 'Some flowers only open at night',
    description: 'A garden that blooms after dark, and the child who learns to wait for it.',
    story: 'By day the garden looks like nothing at all. But when the house is quiet and the moon is up, the white flowers open one by one, and they only open for someone who waits.',
    price: 34.99,
    image: '/static/img/art/cover-the-moon-garden.svg',
    gender: 'girl',
    category: 'book',
    ages: '4–9',
    ageMin: 4,
    ageMax: 9,
    pages: 32,
    reviews: 0,
    rating: 0,
    newRelease: true,
    traits: ['Patience and wonder', '32 illustrated pages', 'A bedtime pacing that slows down']
  },
  {
    slug: 'the-paper-aeroplane-race',
    title: 'The Paper Aeroplane Race',
    tagline: 'Fold, aim, and hope the wind agrees',
    description: 'Three folds, one throw, and a race across the whole playground.',
    story: 'The rules are simple: one sheet of paper, no throwing twice, and whoever lands furthest wins. The wind has other ideas.',
    price: 29.99,
    compareAt: 34.99,
    image: '/static/img/art/cover-the-paper-aeroplane-race.svg',
    gender: 'boy',
    category: 'book',
    ages: '5–10',
    ageMin: 5,
    ageMax: 10,
    pages: 32,
    reviews: 0,
    rating: 0,
    traits: ['Trying again after losing', '32 illustrated pages', 'Age range written for 5–10']
  },
  {
    slug: 'the-snow-fox',
    title: 'The Snow Fox',
    tagline: 'White on white, and a trail worth following',
    description: 'A fox crosses a snowfield, and a child follows the tracks to see where they end.',
    story: 'The tracks start at the fence and keep going. Behind the ridge the snow is deeper, the air is quieter, and the fox has been waiting to see who was curious enough to follow.',
    price: 34.99,
    image: '/static/img/art/cover-the-snow-fox.svg',
    gender: 'girl',
    category: 'book',
    ages: '3–8',
    ageMin: 3,
    ageMax: 8,
    pages: 28,
    reviews: 0,
    rating: 0,
    traits: ['Animals and seasons', '28 illustrated pages', 'Short lines for younger readers']
  },
  {
    slug: 'the-puddle-who-met-the-sea',
    title: 'The Puddle Who Met the Sea',
    tagline: 'A very small amount of water with very large plans',
    description: 'A puddle in a gutter is certain it is on its way to the ocean.',
    story: 'It rains all morning and the gutter fills. The puddle has heard about the sea from a passing gull, and it is not going to let a drain get in the way.',
    price: 29.99,
    image: '/static/img/art/cover-the-puddle-who-met-the-sea.svg',
    gender: 'unisex',
    category: 'book',
    ages: '3–7',
    ageMin: 3,
    ageMax: 7,
    pages: 28,
    reviews: 0,
    rating: 0,
    traits: ['Water and weather', '28 illustrated pages', 'Repetition for early readers']
  },
  {
    slug: 'the-brave-little-baker',
    title: 'The Brave Little Baker',
    tagline: 'The first batch never works. The second one might.',
    description: 'A child bakes alone for the first time, and learns what to do when it goes wrong.',
    story: 'Flour on the floor, a flat cake, and one more try. The recipe does not mention what to do when your hands are shaking, so the baker works that part out alone.',
    price: 29.99,
    image: '/static/img/art/cover-the-brave-little-baker.svg',
    gender: 'unisex',
    category: 'book',
    ages: '2–5',
    ageMin: 2,
    ageMax: 5,
    pages: 24,
    reviews: 0,
    rating: 0,
    traits: ['First attempts and mistakes', '24 illustrated pages', 'Very short sentences']
  },
  {
    slug: 'the-star-collector',
    title: 'The Star Collector',
    tagline: 'A jar, a ladder, and the night sky',
    description: 'A child decides to catch a star, and finds out what they are actually made of.',
    story: 'The ladder is not tall enough and the jar is not wide enough, so the collector builds a rocket out of an old kettle and a lot of patience.',
    price: 39.99,
    image: '/static/img/art/cover-the-star-collector.svg',
    gender: 'boy',
    category: 'book',
    ages: '5–10',
    ageMin: 5,
    ageMax: 10,
    pages: 36,
    reviews: 0,
    rating: 0,
    newRelease: true,
    traits: ['Space and curiosity', '36 illustrated pages', 'Longer story arc for 5–10']
  },
  {
    slug: 'the-forest-that-sang',
    title: 'The Forest That Sang',
    tagline: 'Every tree kept a different note',
    description: 'A forest loses its rhythm, and one child puts it back together.',
    story: 'The wind used to move through the trees in order: low, then high, then low again. Something has changed, and the forest needs someone to listen carefully enough to fix it.',
    price: 34.99,
    image: '/static/img/art/cover-the-forest-that-sang.svg',
    gender: 'girl',
    category: 'book',
    ages: '4–8',
    ageMin: 4,
    ageMax: 8,
    pages: 32,
    reviews: 0,
    rating: 0,
    traits: ['Listening and attention', '32 illustrated pages', 'Nature and music themes']
  },
  {
    slug: 'the-lost-little-dinosaur',
    title: 'The Lost Little Dinosaur',
    tagline: 'Everyone else is bigger. That is not the point.',
    description: 'A very small dinosaur is separated from the herd and has to find the way back.',
    story: 'The valley is wide and the ferns are tall, and from down here everything looks the same. Being small turns out to be useful when the path is narrow.',
    price: 29.99,
    image: '/static/img/art/cover-the-lost-little-dinosaur.svg',
    gender: 'boy',
    category: 'book',
    ages: '2–6',
    ageMin: 2,
    ageMax: 6,
    pages: 24,
    reviews: 0,
    rating: 0,
    traits: ['Being small and capable', '24 illustrated pages', 'Simple, repeating refrain']
  },
  {
    slug: 'the-great-paper-boat-race',
    title: 'The Great Paper Boat Race',
    tagline: 'Down the stream, past the stones, to the bridge',
    description: 'Two paper boats race a whole stream, and only one of them is folded well.',
    story: 'The stream runs behind the houses and under the bridge. Getting there means surviving the stones, the weeds and one very large puddle.',
    price: 29.99,
    image: '/static/img/art/cover-the-great-paper-boat-race.svg',
    gender: 'unisex',
    category: 'book',
    ages: '4–8',
    ageMin: 4,
    ageMax: 8,
    pages: 28,
    reviews: 0,
    rating: 0,
    traits: ['Competition and fairness', '28 illustrated pages', 'Follows a single day']
  },
  {
    slug: 'the-kind-vet',
    title: 'The Kind Vet',
    tagline: 'The animals cannot say what is wrong. So you look closer.',
    description: 'A day in a small animal clinic, told from the vet’s own point of view.',
    story: 'A nervous dog, a guinea pig with a bad paw, and a cat who has opinions. The work is mostly watching, and then deciding what to do next.',
    price: 34.99,
    image: '/static/img/art/cover-the-kind-vet.svg',
    gender: 'unisex',
    category: 'book',
    ages: '4–9',
    ageMin: 4,
    ageMax: 9,
    pages: 32,
    reviews: 0,
    rating: 0,
    career: true,
    traits: ['A job shown as real tasks', '32 illustrated pages', 'Caring for animals']
  },
  {
    slug: 'the-little-fire-crew',
    title: 'The Little Fire Crew',
    tagline: 'Everyone has a job, and the job has a checklist',
    description: 'A small fire crew answers three calls in one day, and each one is different.',
    story: 'A cat in a tree is not the same as smoke in a kitchen. The crew checks the list, checks each other, and goes.',
    price: 34.99,
    image: '/static/img/art/cover-the-little-fire-crew.svg',
    gender: 'unisex',
    category: 'book',
    ages: '3–7',
    ageMin: 3,
    ageMax: 7,
    pages: 28,
    reviews: 0,
    rating: 0,
    career: true,
    traits: ['Teamwork and safety', '28 illustrated pages', 'A real day in the job']
  },
  {
    slug: 'up-in-the-clouds',
    title: 'Up in the Clouds',
    tagline: 'Checklists first. Then the sky.',
    description: 'A pilot walks through a full day: checks, take-off, weather, landing.',
    story: 'There is a list for everything, and the list is not boring — it is the reason the plane is allowed to leave the ground at all.',
    price: 34.99,
    image: '/static/img/art/cover-up-in-the-clouds.svg',
    gender: 'unisex',
    category: 'book',
    ages: '5–10',
    ageMin: 5,
    ageMax: 10,
    pages: 32,
    reviews: 0,
    rating: 0,
    career: true,
    traits: ['Preparation and focus', '32 illustrated pages', 'Weather and flight basics']
  },
  {
    slug: 'the-helping-hands-clinic',
    title: 'The Helping Hands Clinic',
    tagline: 'A clinic where everyone has a different job',
    description: 'A child visits a clinic and meets the people who make it work.',
    story: 'Reception, records, the nurse who takes the temperature, and the doctor who explains what happens next. Nobody does it alone.',
    price: 34.99,
    image: '/static/img/art/cover-the-helping-hands-clinic.svg',
    gender: 'girl',
    category: 'book',
    ages: '4–9',
    ageMin: 4,
    ageMax: 9,
    pages: 32,
    reviews: 0,
    rating: 0,
    career: true,
    traits: ['Many roles in one place', '32 illustrated pages', 'Explains a visit step by step']
  },
  {
    slug: 'the-bridge-builders',
    title: 'The Bridge Builders',
    tagline: 'Measure twice. Then measure again.',
    description: 'A team builds a footbridge over a stream, from first sketch to first crossing.',
    story: 'The plans are wrong twice before they are right. The bridge does not care about the plans — only about the measurements.',
    price: 39.99,
    image: '/static/img/art/cover-the-bridge-builders.svg',
    gender: 'unisex',
    category: 'book',
    ages: '6–11',
    ageMin: 6,
    ageMax: 11,
    pages: 36,
    reviews: 0,
    rating: 0,
    career: true,
    traits: ['Engineering and planning', '36 illustrated pages', 'An older, longer read']
  },
  {
    slug: 'the-curious-scientist',
    title: 'The Curious Scientist',
    tagline: 'A question, a guess, and a test that proves you wrong',
    description: 'A child runs three small experiments and reports what actually happened.',
    story: 'The guess is the easy part. The test is where the work is, and the answer is allowed to be no.',
    price: 39.99,
    image: '/static/img/art/cover-the-curious-scientist.svg',
    gender: 'unisex',
    category: 'book',
    ages: '5–10',
    ageMin: 5,
    ageMax: 10,
    pages: 32,
    reviews: 0,
    rating: 0,
    career: true,
    newRelease: true,
    traits: ['Method and honesty', '32 illustrated pages', 'Safe experiments to try at home']
  },
  {
    slug: 'the-birthday-balloon',
    title: 'The Birthday Balloon',
    tagline: 'One balloon, one gust of wind, one long chase',
    description: 'A birthday balloon escapes, and the whole street helps bring it back.',
    story: 'It was tied to the gate. Then it was not. Following it means meeting every neighbour on the hill.',
    price: 29.99,
    image: '/static/img/art/cover-the-birthday-balloon.svg',
    gender: 'girl',
    category: 'book',
    ages: '2–6',
    ageMin: 2,
    ageMax: 6,
    pages: 24,
    reviews: 0,
    rating: 0,
    traits: ['Birthday story', '24 illustrated pages', 'Short and rhythmic']
  },
  {
    slug: 'the-snowy-night-parade',
    title: 'The Snowy Night Parade',
    tagline: 'Lanterns, boots, and a very slow walk',
    description: 'A village walks through the snow together, one lantern at the front.',
    story: 'Nobody hurries. The lanterns go first, the boots follow, and the whole street ends up at the same warm doorway.',
    price: 34.99,
    image: '/static/img/art/cover-the-snowy-night-parade.svg',
    gender: 'boy',
    category: 'book',
    ages: '3–8',
    ageMin: 3,
    ageMax: 8,
    pages: 28,
    reviews: 0,
    rating: 0,
    traits: ['Community and winter', '28 illustrated pages', 'Calm, slow pacing']
  },
  {
    slug: 'the-sunrise-kite-club',
    title: 'The Sunrise Kite Club',
    tagline: 'Up before the wind, out before the sun',
    description: 'A kite club meets at dawn, and the newest member has never flown one.',
    story: 'The hill is cold at six in the morning and the kite is not interested. It takes three people, one broken string and a lot of running.',
    price: 29.99,
    image: '/static/img/art/cover-the-sunrise-kite-club.svg',
    gender: 'unisex',
    category: 'book',
    ages: '4–8',
    ageMin: 4,
    ageMax: 8,
    pages: 28,
    reviews: 0,
    rating: 0,
    traits: ['Perseverance', '28 illustrated pages', 'Wind and weather']
  },
  {
    slug: 'the-moonlight-parade',
    title: 'The Moonlight Parade',
    tagline: 'The best things happen after bedtime',
    description: 'A child who cannot sleep finds a parade going past the window.',
    story: 'The drums are very quiet and the lanterns are very small, but the parade is definitely real, and it is definitely waiting for one more marcher.',
    price: 34.99,
    image: '/static/img/art/cover-the-moonlight-parade.svg',
    gender: 'girl',
    category: 'book',
    ages: '3–7',
    ageMin: 3,
    ageMax: 7,
    pages: 28,
    reviews: 0,
    rating: 0,
    traits: ['Bedtime and imagination', '28 illustrated pages', 'Ends on a quiet note']
  },
  {
    slug: 'the-little-explorer',
    title: 'The Little Explorer',
    tagline: 'A map drawn from memory, and a woods that keeps changing',
    description: 'A child draws a map of the woods and then has to trust it.',
    story: 'The path looked simple on paper. In the woods there are three fallen trees, two wrong turns and one very good view.',
    price: 29.99,
    image: '/static/img/art/cover-the-little-explorer.svg',
    gender: 'boy',
    category: 'book',
    ages: '4–8',
    ageMin: 4,
    ageMax: 8,
    pages: 28,
    reviews: 0,
    rating: 0,
    traits: ['Maps and navigation', '28 illustrated pages', 'Encourages outdoor play']
  },
  // ---- sticker packs ----
  {
    slug: 'star-sticker-sheet',
    title: 'Star Sticker Sheet',
    tagline: 'A whole sheet of stars, with their name on it',
    description: 'One sheet of star and sparkle stickers personalised with your child’s name.',
    story: 'Twelve stickers on one sheet: stars, bursts and little sparkles, all labelled with the name you chose.',
    price: 14.99,
    compareAt: 19.99,
    image: '/static/img/art/cover-star-sticker-sheet.svg',
    gender: 'unisex',
    category: 'sticker',
    ages: '2–10',
    ageMin: 2,
    ageMax: 10,
    pages: 1,
    reviews: 0,
    rating: 0,
    traits: ['One sheet, twelve stickers', 'Name printed on the sheet', 'Matte finish']
  },
  {
    slug: 'meadow-sticker-sheet',
    title: 'Meadow Sticker Sheet',
    tagline: 'Leaves, flowers and small green things',
    description: 'One sheet of plant and meadow stickers personalised with your child’s name.',
    story: 'Leaves, petals, seed heads and one very determined weed, arranged across a single sheet.',
    price: 14.99,
    image: '/static/img/art/cover-meadow-sticker-sheet.svg',
    gender: 'unisex',
    category: 'sticker',
    ages: '2–10',
    ageMin: 2,
    ageMax: 10,
    pages: 1,
    reviews: 0,
    rating: 0,
    traits: ['One sheet, twelve stickers', 'Name printed on the sheet', 'Matte finish']
  },
  {
    slug: 'space-sticker-sheet',
    title: 'Space Sticker Sheet',
    tagline: 'Rockets, planets and one quiet moon',
    description: 'One sheet of space stickers personalised with your child’s name.',
    story: 'A rocket, three planets, a comet and a moon, all on one sheet with their name across the top.',
    price: 14.99,
    image: '/static/img/art/cover-space-sticker-sheet.svg',
    gender: 'unisex',
    category: 'sticker',
    ages: '2–10',
    ageMin: 2,
    ageMax: 10,
    pages: 1,
    reviews: 0,
    rating: 0,
    traits: ['One sheet, twelve stickers', 'Name printed on the sheet', 'Matte finish']
  },
  {
    slug: 'ocean-sticker-sheet',
    title: 'Ocean Sticker Sheet',
    tagline: 'Waves, shells and something with fins',
    description: 'One sheet of ocean stickers personalised with your child’s name.',
    story: 'Waves, shells, a whale and a shoal of small fish, arranged across a single sheet.',
    price: 14.99,
    image: '/static/img/art/cover-ocean-sticker-sheet.svg',
    gender: 'unisex',
    category: 'sticker',
    ages: '2–10',
    ageMin: 2,
    ageMax: 10,
    pages: 1,
    reviews: 0,
    rating: 0,
    traits: ['One sheet, twelve stickers', 'Name printed on the sheet', 'Matte finish']
  }
]

export function getProduct(slug: string) {
  return products.find((p) => p.slug === slug)
}

export function booksOnly() {
  return products.filter((p) => p.category === 'book')
}

export function stickersOnly() {
  return products.filter((p) => p.category === 'sticker')
}

export function bestsellers() {
  return products.filter((p) => p.bestseller)
}

export function newReleases() {
  return products.filter((p) => p.newRelease)
}

export function byGender(g: 'girl' | 'boy') {
  return products.filter((p) => p.category === 'book' && (p.gender === g || p.gender === 'unisex'))
}

export function byAge(min: number, max: number) {
  return products.filter((p) => p.category === 'book' && p.ageMin <= max && p.ageMax >= min)
}

export function careers() {
  return products.filter((p) => p.career)
}

