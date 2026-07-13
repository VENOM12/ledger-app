# Ledger — Windows Desktop App

## One-time setup

1. **Install Node.js**: https://nodejs.org (LTS installer), click through defaults.
2. **Unzip this folder**, e.g. `C:\Users\YourName\LedgerDesktop`.
3. Open **Command Prompt** or **PowerShell** in that folder:
   ```
   cd C:\Users\YourName\LedgerDesktop
   npm install
   ```

## Run it to test

```
npm start
```

## Build a real installable .exe

```
npm run dist
```
Look in the `release` folder for `Ledger Setup 1.0.0.exe`.

## What's new in this version

- **New "Orders" tab** — every detected purchase order, tracked through a
  proper status lifecycle: **Order Placed** (confirmation seen, nothing
  further yet) → **Shipped** → **Out for Delivery** (now its own distinct
  status, not lumped in with "Shipped") → **Delivered**. Carrier and
  tracking number show up as soon as a shipping email mentions them, and
  estimated delivery date/time too when given.
- **Renamed "Preorders" to "PKC Orders."** Pokémon Center order confirmations
  that mention "preorder" anywhere in the email are now detected
  automatically and land here — with order number, delivery address,
  recipient name, which of your email addresses/aliases it was sent to, and
  an itemized breakdown of products with quantity and price each, all
  pulled directly from the confirmation email.
- **Dashboard's "Pending Delivery" stat renamed to "Open Orders."** I didn't
  reuse "Order Placed" for this one on purpose — that phrase is now the
  specific status for an individual order with no updates yet, and this
  stat is a *count* across orders in any open status (placed, shipped, or
  out for delivery), so reusing the same wording would've been misleading.
  Flagging this in case you pictured it differently.
- **Fixed a real date bug** found while testing this: delivery dates like
  "July 15" with no year mentioned were silently parsing to the year 2001
  (a genuine JavaScript `Date` parsing quirk) instead of the correct year.
  Fixed by anchoring year-less dates to the email's own date.

**Being honest about the address/recipient/line-item extraction**: this is
regex-based best-effort parsing of plain email text, not a real structured
API. It worked well on a well-formatted test email (see below), but Pokémon
Center's own emails aren't perfectly consistent format-to-format, and I
can't guarantee every field populates on every order. Missing fields just
show as "—" rather than breaking anything. I tested this against realistic
sample emails I wrote myself (not real inbox data, since I don't have
access to your actual Pokémon Center order emails), covering order
confirmation → shipped → out for delivery → delivered, plus a full PKC
preorder with a two-item order. All of it worked correctly in that test,
including the parsed line items, recipient name, and delivery address — but
your actual emails may format things differently than my test cases did.

- **Sold tab** — every sale across all your items, flattened into one table:
  date, product, platform (eBay, Facebook Marketplace, Mercari, Local/Cash,
  Other), quantity, gross price, fees, net proceeds, and profit. Filter by
  platform or search by product name.
- **Profit now nets out fees.** Marking something as sold now asks for the
  platform and any fees/shipping deducted (defaults to eBay, since that's
  the norm) — profit, ROI, and the dashboard are all based on what actually
  lands in your account, not the gross sale price.
- **Preorders tab** — check "This is a preorder" when adding a purchase for
  anything not released/shipped yet, optionally with an expected arrival
  date. Preorders sit in their own tab, separate from Stock, until you hit
  "Mark Arrived," which moves them into regular Stock.
- **Email sync now detects sales too**, not just purchases — eBay "item
  sold" and payout emails get picked up, pulling out the net amount when
  the email states one explicitly. Since email content can't reliably say
  *which* of your items sold, detected sales show up under "Detected Sales"
  in Email Sync with a "Match to Item" button — pick the right item and it
  opens the normal Mark as Sold form, prefilled with the platform/amount/date
  for you to confirm.
- **Dashboard fixes:**
  - The profit chart now shows actual dollar values on it (labeled points
    for every day with real activity, a $0 reference line, hover tooltips)
    instead of being an unlabeled squiggle.
  - "Stock by Category" was counting *all* historical spend per category,
    including items already sold off — it now reflects only what's
    currently sitting in inventory.
  - "Pending Orders" is now labeled "Pending Delivery" for clarity.

- **Edit and delete stock items.** Open any item from Stock and there's a full
  edit form (name, category, quantity, price, retailer, date, notes) plus a
  Delete Item button. You can also delete individual sale records if you
  logged one by mistake — the quantity goes back into available stock.
- **Decimal prices work properly now** (£24.99, not just £24) — price fields
  now explicitly allow cents/pence.
- **Sidebar navigation works from the item detail screen.** This was a real
  bug: the nav button click-handlers were only wired up in the code path for
  Dashboard/Stock/Add/Email views, and the item detail view returned early
  before reaching that code — so clicking anything but "Back" silently did
  nothing. Fixed by binding the nav clicks once, outside that code path.
- **Settings' Export/Clear buttons are smaller**, sitting side by side rather
  than as big full-width blocks.
- **IMAP catch-all address.** In Email Sync, you can now add a dedicated
  alias (e.g. Gmail's `you+orders@gmail.com` trick) that you use at checkout.
  Every email sent to that address is treated as a potential order — no
  keyword matching needed, so nothing slips through due to unusual subject
  lines. Set it when connecting, or add/edit it later from the Email Sync
  screen without reconnecting.
- **Auto-sync every 60 seconds** while the app is open and an account is
  connected — no need to click "Sync Now" manually. It skips re-rendering
  while you're actively typing somewhere so it won't interrupt you.
- **Exclusion filters** in Email Sync: a "Skip promotional & newsletter
  emails" toggle (on by default — it checks for the `List-Unsubscribe`
  header and common marketing phrases like "% off" or "unsubscribe"), plus
  a blocklist for specific senders or whole domains. Every detected order
  has a "Block this sender" link right there if something slips through
  (like a retailer's newsletter getting mistaken for an order) — clicking
  it blocks that domain going forward *and* immediately clears that false
  positive from the list. Note: if a false positive already got auto-added
  to Stock before you blocked it, you'll still need to delete that one item
  manually (blocking only affects future syncs, not past line items already
  written to Stock).
- **Auto-updater**, using `electron-updater` + GitHub Releases. This needs
  one-time setup on your end before it does anything (see below) — until
  then, update checks just fail quietly, which is expected.

## Setting up the auto-updater (optional)

Auto-updates need somewhere to host new versions. The free, standard path is
GitHub Releases:

1. Create a GitHub repo (public or private) for this project.
2. In `package.json`, under `"build" → "publish"`, replace
   `YOUR-GITHUB-USERNAME` and `YOUR-REPO-NAME` with your actual repo.
3. Bump the `"version"` field in `package.json` for each release.
4. Get a GitHub personal access token with `repo` scope, set it as an
   environment variable `GH_TOKEN`, then run:
   ```
   npm run dist -- --publish always
   ```
   This builds the installer **and** uploads it to a GitHub Release.
5. Anyone running an older version will get notified automatically, download
   the update in the background, and see a "Update ready — Restart" button
   in the sidebar (and in Settings) once it's downloaded.

Until you do this setup, the app still works completely normally — it just
can't find anywhere to check for updates, which shows up as a quiet "Couldn't
check for updates" message in Settings rather than an error dialog.

## Setting up Email Sync

Go to the **Email Sync** tab and pick your provider (Gmail, Outlook, Yahoo,
iCloud, or a custom IMAP server). You'll need an **app password**, not your
regular email password:

- **Gmail**: turn on 2-Step Verification, then generate one at
  `myaccount.google.com/apppasswords`
- **Outlook/Office 365**: `account.microsoft.com/security` → Advanced
  security options → App passwords
- **Yahoo**: Account Security → Generate app password
- **iCloud**: appleid.apple.com → Sign-In and Security → App-Specific Passwords

Your password is encrypted using Windows' own credential storage (via
Electron's `safeStorage`, backed by Windows DPAPI) and stays on this PC only.

**What auto-detection can and can't do, honestly:**
- Reliably picks up retailer name, order date, a price found in the email,
  and classifies emails as confirmed / shipped / delivered by keyword.
- **Cannot** reliably read the actual product name out of most order
  emails — formats vary too much. Delivered orders get auto-added to Stock
  as "Order from [retailer] — tap to edit," with price/date pre-filled; you
  do a quick edit to fix the name and quantity.
- If you set a **catch-all address**, anything sent there is checked
  regardless of subject wording — this is the most reliable way to make
  sure nothing gets missed, if you're willing to use a dedicated alias at
  checkout.
- Matching a "shipped"/"delivered" follow-up back to the right order uses
  the order number when the email has one, otherwise a best-effort
  retailer+price match. Remove false positives with the × in the Detected
  Orders table.

## Other notes

- **Your data** (stock, sales, detected orders) lives in this app's local
  storage on this PC only. Use Settings → Export data for a backup.
- I couldn't install `imapflow`/`mailparser`/`electron-updater` or run this
  end-to-end myself — no internet access in my build environment. Everything
  was syntax-checked, and the UI logic (rendering, edit/delete, form
  validation, navigation) was verified with a real headless browser and a
  stubbed version of the Electron APIs. The actual IMAP sync and
  auto-updater calls are untested against a real mailbox/update server. If
  something throws an error, send me the exact message and I'll fix it fast.
