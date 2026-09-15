// Canonical Product type lives in src/product.ts (one declaration, not two —
// see that file's comment for why this matters).
export type { Product } from './product'
import type { Product } from './product'
import { brand } from './brand'

export const products: Product[] = [
  {
    slug: 'girls-sticker-pack',
    title: "Girl's Sticker Pack",
    tagline: 'Personalized sticker packs for your little girl',
    description: 'Stickers that celebrate your child’s big dreams — unicorns, rainbows, and her own illustrated face on every sheet.',
    story: 'A treasure box of 40+ custom stickers starring your little girl. From unicorns to rainbows, every sheet is illustrated just for her.',
    price: 14.99,
    compareAt: 29.99,
    image: '/static/img/stickers-girl.webp',
    gender: 'girl',
    category: 'sticker',
    ages: '2–10',
    ageMin: 2,
    ageMax: 10,
    pages: 6,
    reviews: 1842,
    rating: 4.9,
    bestseller: true,
    traits: ['40+ custom stickers', 'Her face on every sheet', 'Premium vinyl']
  },
  {
    slug: 'boys-sticker-pack',
    title: "Boy's Sticker Pack",
    tagline: 'Personalized sticker packs for your little boy',
    description: 'Rockets, dinosaurs, soccer stars — and your boy as the hero of every sticker.',
    story: 'A high-energy pack of 40+ custom stickers starring your little boy. Rockets, dinos, race cars, and superheroes — all with his face.',
    price: 14.99,
    compareAt: 29.99,
    image: '/static/img/stickers-boy.webp',
    gender: 'boy',
    category: 'sticker',
    ages: '2–10',
    ageMin: 2,
    ageMax: 10,
    pages: 6,
    reviews: 1604,
    rating: 4.8,
    bestseller: true,
    traits: ['40+ custom stickers', 'His face on every sheet', 'Premium vinyl']
  },
  {
    slug: 'the-portugals-new-legend',
    title: "The Portugal’s New Legend",
    tagline: 'For champions with red and green at heart 🇵🇹',
    description: 'Months of sweat and practice in the wind and rain have led to this single moment, the Grand Final for A Seleção das Quinas.',
    story: 'Months of sweat and practice in the wind and rain have led to this single moment, the Grand Final for A Seleção das Quinas. Today, with the red and green on their back and the heart of a champion, history is waiting to be made. The whistle is about to blow. Força Portugal! Give them the moment they’ve always dreamed of.',
    price: 44.99,
    image: '/static/img/cover-portugal.webp',
    gender: 'boy',
    category: 'book',
    ages: '6–12',
    ageMin: 6,
    ageMax: 12,
    pages: 32,
    reviews: 2924,
    rating: 4.9,
    bestseller: true,
    newRelease: true,
    traits: ['Teaches resilience & courage', 'Upload your favorite photo', 'Preview before ordering']
  },
  {
    slug: 'princess-girl-the-one-we-all-needed',
    title: 'Princess Girl, the One We All Needed',
    tagline: 'A magical journey of kindness and courage',
    description: 'When kindness calls, even the smallest acts can change everything.',
    story: 'When kindness calls, even the smallest acts can change everything. In this enchanting personalized tale, a Princess follows a glowing guide through gardens, lakes, and stormy skies, helping new friends discover their true strength. Along the way, she learns that bravery and compassion are the brightest magic of all.',
    price: 34.99,
    image: '/static/img/cover-princess.webp',
    gender: 'girl',
    category: 'book',
    ages: '4–10',
    ageMin: 4,
    ageMax: 10,
    pages: 32,
    reviews: 2565,
    rating: 4.9,
    bestseller: true,
    newRelease: true,
    traits: ['Inspires empathy, courage, and self-belief', '32 beautifully illustrated pages', 'Preview before ordering']
  },
  {
    slug: 'happy-birthday-girl',
    title: 'Happy Birthday Girl',
    tagline: 'The perfect birthday gift for your little girl',
    description: 'A sparkling birthday adventure where she is the guest of honour — cake, confetti, and a wish that comes true.',
    story: 'Today is the most magical day of the year. In this joyful tale, your little girl is the star of her own birthday celebration, complete with friends, cake, and a wish that lights up the sky.',
    price: 34.99,
    image: '/static/img/cover-birthday-girl.webp',
    gender: 'girl',
    category: 'book',
    ages: '2–8',
    ageMin: 2,
    ageMax: 8,
    pages: 32,
    reviews: 1180,
    rating: 4.8,
    traits: ['Perfect birthday keepsake', 'Name on every page', 'Preview before ordering']
  },
  {
    slug: 'happy-birthday-boy',
    title: 'Happy Birthday Boy',
    tagline: 'The perfect birthday gift for your little boy',
    description: 'Balloons, cake, and a hero’s birthday quest — starring your little boy.',
    story: 'The candles are lit and the adventure begins. Your little boy is the birthday hero, racing through a day of surprises, friends, and a wish that comes true.',
    price: 34.99,
    image: '/static/img/cover-birthday-boy.webp',
    gender: 'boy',
    category: 'book',
    ages: '2–8',
    ageMin: 2,
    ageMax: 8,
    pages: 32,
    reviews: 980,
    rating: 4.8,
    traits: ['Perfect birthday keepsake', 'Name on every page', 'Preview before ordering']
  },
  {
    slug: 'super-boy-and-the-dragon',
    title: 'Super Boy and the Dragon',
    tagline: 'Kindness turns a scary dragon into a true friend',
    description: 'A cape, a roar, and a surprising friendship that proves the bravest heroes lead with kindness.',
    story: 'When a lonely dragon frightens the village, Super Boy doesn’t fight — he listens. Together they discover that the bravest magic of all is kindness.',
    price: 34.99,
    image: '/static/img/cover-dragon.webp',
    gender: 'boy',
    category: 'book',
    ages: '4–10',
    ageMin: 4,
    ageMax: 10,
    pages: 32,
    reviews: 1432,
    rating: 4.9,
    newRelease: true,
    traits: ['Teaches kindness & courage', '32 illustrated pages', 'Preview before ordering']
  },
  {
    slug: 'the-boy-and-the-cosmic-journey',
    title: 'The Boy and the Cosmic Journey',
    tagline: 'Discovering courage in an adventure to the stars',
    description: 'A bedtime voyage through planets, constellations, and the biggest dream of all.',
    story: 'One night a lost star winks at your little boy. He climbs aboard a silver rocket and sails the cosmos, learning that curiosity and courage can light the darkest sky.',
    price: 34.99,
    image: '/static/img/cover-cosmic.webp',
    gender: 'boy',
    category: 'book',
    ages: '4–10',
    ageMin: 4,
    ageMax: 10,
    pages: 32,
    reviews: 1210,
    rating: 4.8,
    newRelease: true,
    traits: ['Sparks curiosity', '32 illustrated pages', 'Preview before ordering']
  },
  {
    slug: 'princess-and-the-glowing-flower',
    title: 'Princess and the Glowing Flower',
    tagline: 'A luminous quest through an enchanted forest',
    description: 'A princess follows a petal of light to restore wonder to a fading woodland.',
    story: 'Deep in an enchanted forest, a single flower still glows. Your little princess follows its light, helping woodland friends and discovering that hope is something you can carry.',
    price: 34.99,
    image: '/static/img/cover-flower.webp',
    gender: 'girl',
    category: 'book',
    ages: '4–10',
    ageMin: 4,
    ageMax: 10,
    pages: 32,
    reviews: 990,
    rating: 4.8,
    traits: ['Inspires hope & wonder', '32 illustrated pages', 'Preview before ordering']
  },
  {
    slug: 'girl-counts-with-the-forest-friends',
    title: 'Girl Counts with the Forest Friends',
    tagline: 'A gentle counting adventure among woodland animals',
    description: 'Rabbits, birds, and foxes help her count from one to ten on a sun-dappled trail.',
    story: 'On a walk through the woods, your little girl meets forest friends who need her help counting. One rabbit, two birds, three foxes — every number is a new friend.',
    price: 34.99,
    image: '/static/img/cover-forest.webp',
    gender: 'girl',
    category: 'book',
    ages: '2–6',
    ageMin: 2,
    ageMax: 6,
    pages: 28,
    reviews: 760,
    rating: 4.7,
    traits: ['Early learning', 'Counting 1–10', 'Preview before ordering']
  },
  {
    slug: 'boy-the-dinos-need-you',
    title: 'Boy, the Dinos Need You',
    tagline: 'A prehistoric rescue powered by a brave little heart',
    description: 'Friendly dinosaurs need a clever helper — and your boy is just the hero.',
    story: 'When the dinosaurs lose their favourite valley, your little boy leads a prehistoric rescue. Along the way he learns that even the smallest helper can change everything.',
    price: 34.99,
    image: '/static/img/cover-dinos.webp',
    gender: 'boy',
    category: 'book',
    ages: '2–6',
    ageMin: 2,
    ageMax: 6,
    pages: 28,
    reviews: 842,
    rating: 4.8,
    traits: ['Dino adventure', 'Teaches helping others', 'Preview before ordering']
  },
  {
    slug: 'the-girl-and-the-christmas-express',
    title: 'The Girl and the Christmas Express',
    tagline: 'A snowy ride to the North Pole — starring her',
    description: 'A glittering steam train, falling snow, and a Christmas wish that needs a conductor.',
    story: 'On Christmas Eve a golden train stops at her window. Your little girl becomes the conductor of the Christmas Express, delivering wonder to every snowy village along the way.',
    price: 34.99,
    image: '/static/img/cover-christmas.webp',
    gender: 'girl',
    category: 'book',
    ages: '3–8',
    ageMin: 3,
    ageMax: 8,
    pages: 32,
    reviews: 1104,
    rating: 4.9,
    traits: ['Holiday keepsake', '32 illustrated pages', 'Preview before ordering']
  },
  {
    slug: 'the-boy-and-the-christmas-express',
    title: 'The Boy and the Christmas Express',
    tagline: 'All aboard a snowy Christmas adventure',
    description: 'Your little boy takes the whistle of a magical holiday train.',
    story: 'A crimson locomotive puffs to his door on Christmas Eve. Your little boy is invited to drive the Christmas Express and discover that giving is the greatest gift.',
    price: 34.99,
    image: '/static/img/cover-christmas.webp',
    gender: 'boy',
    category: 'book',
    ages: '3–8',
    ageMin: 3,
    ageMax: 8,
    pages: 32,
    reviews: 1011,
    rating: 4.8,
    traits: ['Holiday keepsake', '32 illustrated pages', 'Preview before ordering']
  },
  {
    slug: 'boy-explores-the-zoo',
    title: 'Boy Explores the Zoo',
    tagline: 'Wild zoo adventure: meet & learn with animals',
    description: 'Giraffes, lions, and penguins — a day at the zoo with your boy as the explorer.',
    story: 'A golden ticket, a map, and a day of wonder. Your little boy meets the animals of the zoo and learns that every creature has a story — including him.',
    price: 34.99,
    image: '/static/img/cover-zoo.webp',
    gender: 'boy',
    category: 'book',
    ages: '3–8',
    ageMin: 3,
    ageMax: 8,
    pages: 32,
    reviews: 688,
    rating: 4.7,
    traits: ['Animal learning', '32 illustrated pages', 'Preview before ordering']
  },
  {
    slug: 'girl-explores-the-zoo',
    title: 'Girl Explores the Zoo',
    tagline: 'Wild zoo adventure: meet & learn with animals',
    description: 'A curious girl spends a magical day meeting the animals of the zoo.',
    story: 'With a sketchbook and a brave heart, your little girl explores the zoo, making friends from the savannah to the arctic exhibit.',
    price: 34.99,
    image: '/static/img/cover-zoo.webp',
    gender: 'girl',
    category: 'book',
    ages: '3–8',
    ageMin: 3,
    ageMax: 8,
    pages: 32,
    reviews: 654,
    rating: 4.7,
    traits: ['Animal learning', '32 illustrated pages', 'Preview before ordering']
  },
  {
    slug: 'girl-saves-the-arctic-kingdom',
    title: 'Girl Saves the Arctic Kingdom',
    tagline: 'An icy adventure powered by care and courage',
    description: 'Polar bears, penguins, and a melting kingdom that needs a kind-hearted hero.',
    story: 'Far to the north, the Arctic Kingdom is losing its glow. Your little girl sets out across the ice, helping polar friends and proving that care can warm even the coldest world.',
    price: 34.99,
    image: '/static/img/cover-arctic.webp',
    gender: 'girl',
    category: 'book',
    ages: '4–10',
    ageMin: 4,
    ageMax: 10,
    pages: 32,
    reviews: 577,
    rating: 4.8,
    traits: ['Care & courage', '32 illustrated pages', 'Preview before ordering']
  },
  {
    slug: 'vroom-vroom-the-boy-wins-the-race',
    title: 'Vroom Vroom, The Boy Wins the Race',
    tagline: 'A high-speed tale of practice, patience, and victory',
    description: 'Helmets on — your little boy is the champion of the grand prix.',
    story: 'Practice, patience, and a roaring engine. Your little boy lines up at the starting grid and learns that winning is about never giving up — and cheering for friends too.',
    price: 34.99,
    image: '/static/img/cover-race.webp',
    gender: 'boy',
    category: 'book',
    ages: '3–8',
    ageMin: 3,
    ageMax: 8,
    pages: 32,
    reviews: 720,
    rating: 4.8,
    traits: ['Sportsmanship', '32 illustrated pages', 'Preview before ordering']
  },
  {
    slug: 'boys-smile',
    title: "Boy's Smile",
    tagline: 'Discover how a smile can light up every day',
    description: 'A gentle story about the superpower hiding in a little boy’s grin.',
    story: 'One bright smile can change a rainy morning, a shy friend, and a whole town. Your little boy discovers that kindness starts with the smallest, sunniest thing he owns.',
    price: 34.99,
    image: '/static/img/cover-smile.webp',
    gender: 'boy',
    category: 'book',
    ages: '2–6',
    ageMin: 2,
    ageMax: 6,
    pages: 28,
    reviews: 540,
    rating: 4.9,
    traits: ['Kindness & joy', '28 illustrated pages', 'Preview before ordering']
  },
  {
    slug: 'princess-weve-been-waiting-for-you',
    title: "Princess! We've Been Waiting for You",
    tagline: 'A fairytale welcome written just for her',
    description: 'The kingdom has been waiting — and she is the princess they needed all along.',
    story: 'Bells ring across the kingdom. Your little girl is the princess they’ve been waiting for, and every page is a celebration of who she already is.',
    price: 34.99,
    image: '/static/img/cover-princess.webp',
    gender: 'girl',
    category: 'book',
    ages: '4–10',
    ageMin: 4,
    ageMax: 10,
    pages: 32,
    reviews: 1330,
    rating: 4.9,
    bestseller: true,
    traits: ['Fairytale magic', '32 illustrated pages', 'Preview before ordering']
  },
  {
    slug: 'boy-explores-the-world-of-jobs',
    title: 'Boy Explores the World of Jobs',
    tagline: 'Open their eyes to the many possibilities waiting for them',
    description: 'Firefighter, doctor, pilot, chef — a career adventure starring your little boy.',
    story: 'A wonderful, engaging book that opens kids’ eyes to the many possibilities waiting for them. Your little boy tries on the hats of heroes, helpers, and dreamers — and imagines who he might become.',
    price: 34.99,
    image: '/static/img/cover-firefighter.webp',
    gender: 'boy',
    category: 'book',
    ages: '4–10',
    ageMin: 4,
    ageMax: 10,
    pages: 32,
    reviews: 890,
    rating: 4.8,
    career: true,
    traits: ['Career inspiration', '32 illustrated pages', 'Preview before ordering']
  },
  {
    slug: 'little-firefighter',
    title: 'Little Firefighter',
    tagline: 'A career adventure for brave hearts',
    description: 'Helmet on, hose ready — your child is the hero of the firehouse.',
    story: 'The alarm rings and your child races to the truck. In this hyper-personalised career adventure they learn teamwork, bravery, and how helpers keep a town safe.',
    price: 34.99,
    image: '/static/img/cover-firefighter.webp',
    gender: 'unisex',
    category: 'book',
    ages: '4–10',
    ageMin: 4,
    ageMax: 10,
    pages: 32,
    reviews: 612,
    rating: 4.8,
    career: true,
    traits: ['Career adventure', 'Bravery & teamwork', 'Preview before ordering']
  },
  {
    slug: 'little-police-officer',
    title: 'Little Police Officer',
    tagline: 'A career adventure for helpers and protectors',
    description: 'Badge shining, your child keeps the neighbourhood kind and safe.',
    story: 'With a badge and a kind heart, your child spends a day as a police officer — helping neighbours, finding lost pets, and learning that real heroes listen first.',
    price: 34.99,
    image: '/static/img/cover-police.webp',
    gender: 'unisex',
    category: 'book',
    ages: '4–10',
    ageMin: 4,
    ageMax: 10,
    pages: 32,
    reviews: 501,
    rating: 4.7,
    career: true,
    traits: ['Career adventure', 'Kindness & helping', 'Preview before ordering']
  },
  {
    slug: 'little-pilot',
    title: 'Little Pilot',
    tagline: 'A career adventure above the clouds',
    description: 'Wheels up — your child takes the controls of a sunrise flight.',
    story: 'From the runway to the clouds, your child is the captain. They learn that big dreams take practice, checklists, and a sky full of courage.',
    price: 34.99,
    image: '/static/img/cover-pilot.webp',
    gender: 'unisex',
    category: 'book',
    ages: '4–10',
    ageMin: 4,
    ageMax: 10,
    pages: 32,
    reviews: 448,
    rating: 4.8,
    career: true,
    traits: ['Career adventure', 'Dreams & focus', 'Preview before ordering']
  },
  {
    slug: 'little-doctor',
    title: 'Little Doctor',
    tagline: 'A career adventure of care and healing',
    description: 'Stethoscope on — your child is the kindest doctor in town.',
    story: 'In a colourful children’s clinic, your child listens, helps, and heals. A gentle career story about empathy, science, and looking after others.',
    price: 34.99,
    image: '/static/img/cover-doctor.webp',
    gender: 'unisex',
    category: 'book',
    ages: '4–10',
    ageMin: 4,
    ageMax: 10,
    pages: 32,
    reviews: 533,
    rating: 4.8,
    career: true,
    traits: ['Career adventure', 'Empathy & care', 'Preview before ordering']
  }
]

export const languages = [
  'English',
  'Spanish',
  'Portuguese (Brazil)',
  'Arabic',
  'French',
  'Turkish',
  'German',
  'Italian',
  'Dutch',
  'Albanian'
]

export type Faq = { q: string; a: string; cat: string }

/**
 * FAQ copy is built per call (not as a module-level constant) so the brand
 * name always comes from the single src/brand.ts boundary — L-D.
 */
export function faqList(): Faq[] {
  const b = brand()
  return [
  {
    cat: 'Popular',
    q: 'How do I personalise a book?',
    a: 'Choose the book, upload a photo of your child (make sure it matches our recommendations), and enter their name and age. You can review and edit the book in the reader before adding it to your cart. Note: this version does not charge a real payment or produce a printed book.'
  },
  {
    cat: 'Popular',
    q: 'Do you ship internationally?',
    a: 'No — shipping is not available in this version. Printing and delivery are later milestones, so no order placed today will be shipped. The checkout collects shipping details so the order record is complete.'
  },
  {
    cat: 'Popular',
    q: 'What is your refund policy?',
    a: 'Not applicable yet — this version does not collect a real payment, so there is nothing to refund. Orders placed here are test orders.'
  },
  {
    cat: 'Popular',
    q: 'How long does shipping take?',
    a: 'Delivery is not scheduled in this version — there is no fulfilment or shipping integration yet.'
  },
  {
    cat: 'Popular',
    q: 'Are taxes and customs included?',
    a: 'Not applicable yet — no real payment, shipping or customs handling exists in this version.'
  },
  {
    cat: 'Popular',
    q: 'Can I review the book before it is printed?',
    a: 'You can review and edit your book in the reader before ordering; every edit is saved as its own revision. There is no post-order approval or revision workflow in this version yet.'
  },
  {
    cat: 'Popular',
    q: 'What languages are your books available in?',
    a: 'The personalisation form currently offers English, Spanish, Portuguese (Brazil), Arabic, French, Turkish, German, Italian, Dutch and Albanian.'
  },
  {
    cat: 'About Our Books',
    q: 'How is the book personalised for my child?',
    a: 'Creating your child’s book is quick and magical: Upload your child’s photo so the hero truly looks like them. Enter their name and age to personalize the story throughout. Preview before ordering to make sure it’s perfect. Every page is crafted so your child feels like the true hero of the adventure.'
  },
  {
    cat: 'About Our Books',
    q: 'What is the format of the book?',
    a: 'Each book is a premium hardcover storybook in a large square format, with over 30+ beautifully illustrated pages. Made to feel like a keepsake — sturdy, vibrant, and designed to last for years of reading.'
  },
  {
    cat: 'About Our Books',
    q: 'Can I submit my own custom story?',
    a: 'Currently, we don’t offer custom story submissions. All our personalised books use pre-written stories available on our site.'
  },
  {
    cat: 'Shipping & Delivery',
    q: 'How can I track my order?',
    a: 'Order tracking is not available in this version: no tracking emails or tracking links are sent, and no orders are printed or shipped. If you need the status of an order you placed here, contact us using the contact form.'
  },
  {
    cat: 'Shipping & Delivery',
    q: 'Can I change my shipping address?',
    a: 'Contact us using the contact form and we will look at the order record. Nothing ships in this version, so no shipment can be affected.'
  },
  {
    cat: 'Your Account',
    q: 'Do I need an account to order?',
    a: 'No, you can check out as a guest. Creating an account keeps the orders you place while signed in under My Books. Guest orders cannot be linked to an account in this version.'
  },
  {
    cat: 'Placing an Order',
    q: 'What payment methods do you accept?',
    a: 'None — this version does not collect a real payment. Checkout records the order without charging anything and does not offer card or PayPal payment.'
  },
  {
    cat: 'About Us',
    q: `What is ${b.name}?`,
    a: `${b.name} is an online business that creates personalized children’s books where your child becomes the star of the story.`
    }
  ]
}

/** Blog copy is built per call so its brand references come from src/brand.ts (L-D). */
export function blogPosts() {
  const b = brand()
  return [
  {
    slug: 'how-to-make-a-kids-book',
    title: "How to Make a Kids' Book for Lasting Memories",
    date: 'July 4, 2025',
    excerpt: `Learn how to make a kids’ book that will help you create a special story your child will treasure — with creativity, a few tools, or ${b.name}.`,
    image: '/static/img/books-header.webp',
    body: `<p>Reading can change everything — and for children, it helps shape who they become. It encourages creativity, builds empathy, reduces stress, and supports their development.</p>
<p>But it’s not just about whether kids read, but what they read. The stories they’re exposed to, the characters they follow, and the language they absorb all influence how they see themselves and the world around them.</p>
<h3>Define your book’s age group</h3>
<p>A story that delights a two-year-old might leave a seven-year-old bored. Tailoring your book to the child’s age isn’t just about word count — it’s about matching structure and emotional themes.</p>
<h3>Brainstorm the story idea</h3>
<p>The best children’s stories often revolve around kindness, curiosity, courage, friendship, or learning to handle emotions. Personalization — a name they recognize, a challenge they’re quietly working through — gives the book lasting value.</p>
<h3>Illustrate, edit, and print</h3>
<p>Most picture books follow a 32-page layout. With ${b.name}, we take care of the tricky parts like design, illustration, and layout so you can focus on the child you’re creating it for.</p>`
  },
  {
    slug: 'personalized-childrens-books',
    title: 'Why Personalized Children’s Books Make the Perfect Gift',
    date: 'July 4, 2025',
    excerpt: 'When children see their own names, birthdays, or favourite hobbies in a book, their eyes light up. Here’s why personalised stories last.',
    image: '/static/img/cta-reading.webp',
    body: `<p>When children see their own names, birthdays, or favourite hobbies in a book, their eyes light up. A personalised storybook isn’t just a present — it’s a mirror that says: you belong in stories, too.</p>
<p>${b.name} books place your child’s face and name into professionally illustrated adventures, creating a keepsake families read again and again.</p>`
  },
  {
    slug: 'best-baby-books',
    title: 'Best Baby Books for Newborns & Toddlers',
    date: 'November 3, 2025',
    excerpt: `From first birthdays to new-sibling stories, here are the ${b.name} titles families reach for in the earliest years.`,
    image: '/static/img/cover-birthday-girl.webp',
    body: `<p>The earliest years are full of firsts — first smiles, first words, first days. A board-style or short picture book that names your child as the hero becomes part of the bedtime ritual.</p>
<p>Families love Happy Birthday Girl, Boy’s Smile, and our new-sibling stories for toddlers ages 2–4.</p>`
  }
  ]
}

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

export function money(n: number) {
  return `$${n.toFixed(2)}`
}
