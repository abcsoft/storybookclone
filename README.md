# WonderWraps Clone

A full visual and functional clone of [wonderwraps.com](https://wonderwraps.com/) — personalized children’s storybooks and sticker packs.

## Project Overview
- **Name**: WonderWraps
- **Goal**: Recreate the WonderWraps shopping experience: browse stories, personalise with a child’s name/photo, cart, checkout, account, FAQs, blog, and support.
- **Features**:
  - Home page matching the original structure (promo banner, hero, bestsellers, how it works, girls/boys bands, careers, age browse, FAQs, CTA)
  - Book catalog with gender, career, age, and search filters
  - Sticker packs at 50% off
  - Product pages with personalisation form and photo preview
  - Cart, EXTRA20 discount on 2+ books, checkout
  - Login / register / forgot password
  - My Books order history
  - FAQs, contact, support, privacy, terms, blog

## URLs
- **Home**: `/`
- **Books**: `/books`, `/books?gender=girl|boy`, `/books?career=1`, `/books?q=`
- **Age catalogs**: `/books/age/2-4`, `/books/age/4-6`, `/books/age/6-8`
- **Product**: `/books/:slug`, `/stickers/:slug`
- **Stickers**: `/stickers`
- **Account**: `/login`, `/register`, `/forgot-password`, `/my-books`
- **Commerce**: `/cart`, `/checkout`
- **Help**: `/faqs`, `/support`, `/contact`
- **Legal**: `/support/privacy-policy`, `/support/terms-and-conditions`
- **Blog**: `/blog`, `/blog/:slug`

## Data Architecture
- **Catalog**: static product data in `src/data.ts`
- **Storage**: Cloudflare D1 (`users`, `orders`, `newsletter`, `contacts`)
- **Cart**: browser `localStorage` until checkout

## User Guide
1. Browse books or stickers.
2. Open a title, enter the child’s name, age, language, optional dedication, and photo.
3. Personalise now → cart. Two or more books automatically apply EXTRA20 (20% off).
4. Checkout stores a demo order in D1 (no real payment).
5. View orders on My Books.

## Deployment
- **Platform**: Cloudflare Pages + D1
- **Tech Stack**: Hono + TypeScript + custom CSS
- **Local**: `npm run build` then `pm2 start ecosystem.config.cjs`
- **Last Updated**: 2026-08-27
