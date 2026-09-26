# Spin the Wheel

A simple spin-the-wheel you can use to pick names, decide where to eat, choose who goes first, whatever you need. It's plain HTML, CSS and JavaScript. No framework, no sign-up, and everything you add stays in your browser.

## What it does

- Add items by typing in the list and pressing Enter. Click an item to rename it, or click its colored dot to change the color.
- Spin by clicking the wheel or the Spin button in the middle. Clicking again while it's still spinning speeds it up instead of starting over.
- When it stops, the picked item shows up at the top and the rest of the wheel fades out so it's easy to see.
- Import a list from a CSV file with the Import CSV button, or just drag the file onto the item list. Export CSV saves your list back out in the same format.
- Share link makes a link with your list in it (up to 200 items). Whoever opens it gets asked whether to load it, add it to their own list, or cancel, so nobody's list gets replaced by surprise. The list lives inside the link itself, so there's no server storing anything.
- Your items and settings are saved in your browser, so they'll still be there next time you open the page.
- Lock the wheel with a 4-digit PIN using the padlock next to Items. While it's locked, anyone can still spin, but nobody can add, remove, edit or recolor items, change settings, or import a file until the PIN is entered. The PIN itself is never saved, only a salted hash of it. Just keep in mind a 4-digit PIN on a web page is there to stop casual tampering, not a determined person with dev tools.

The Settings menu has a few options:

- **Spin time** is how long the wheel spins, from 1 to 20 seconds.
- **View** switches between the wheel and a slot-machine style reel. On Auto (the default) it uses the wheel for short lists and flips to the reel once you have more than 100 items, since the wheel's labels get too small to read. You can change that number, or just pick Wheel or Slot to always use one. Either way every item has the same chance.
- **Disable remove item** hides the Remove button on the picked item, if you don't want people taking things off the wheel.
- **Remove on select** takes the picked item off the wheel on its own after a few seconds. Handy for drawing names one at a time. You can set how long it stays up with the Show for slider.

## CSV format

I tried to make the import forgiving, so most simple files should just work. Any of these are fine:

One item per line:

```
Pizza
Tacos
Sushi
```

Everything on one line:

```
Red,Green,Blue
```

An item and a color on each line:

```
Coffee,#6b4f2a
Tea,#9bbf5a
```

Or a file with a header row. It looks for a column called Name, Item, Label or Option, and it'll use a Color column too if there is one:

```
Name,Color
Alex,#ff0000
Jordan,
Sam,#0af
```

Items without a color get one picked for them. Imported items are added to whatever's already on the wheel, up to 1,000 per file. If a file has more than 100 lines you'll get a heads-up, since the labels get pretty small at that point.

## Security

Share links come from other people, so the page treats them as untrusted:

- A link can only ever turn into a list of plain-text names and hex colors. Nothing in it gets run, used as a web address, or inserted into the page as HTML, so there's no way to use one for a redirect or to inject a script.
- Links are checked hard before anything loads: a size limit on the link, a limit on how big it can get when decompressed, an exact expected shape, and at most 200 items. Anything off gets rejected with a message and your list isn't touched.
- Every name, whether typed, imported, loaded from a link or from saved data, goes through the same cleanup. Control characters and invisible characters (including the ones that can make text display backwards) are removed and names are capped at 60 characters.
- Exported CSVs are safe to open in Excel or Sheets. Names that start with `=`, `+`, `-` or `@` get a leading `'` so they show up as text instead of running as formulas, and the importer takes it back off.
- The page has a strict Content Security Policy, so the browser itself refuses to run any script that isn't one of the site's own files, and blocks HTML injection outright in Chromium browsers.

## Working on it

There's no build step needed while you're making changes. Edit `index.html`, `styles.css` and `script.js` and open `index.html` in your browser.

If you want to see the minified version that actually gets deployed, you'll need Node installed:

```sh
npm install
npm run preview
```

That builds everything into `dist/` and serves it locally.

## Deploying

This is set up to deploy to GitHub Pages through GitHub Actions. Every push to `main` builds the site and publishes it.

The first time, you have to tell GitHub to use Actions. Go to Settings, then Pages, and under Build and deployment set Source to GitHub Actions. After that it's automatic.

A few things the build does, in case you're wondering:

- It minifies `script.js` and `styles.css` with esbuild and adds a hash to their file names, so browsers always pick up the new files after a deploy.
- It generates `sw.js`, a service worker that caches the site's files. GitHub Pages only lets browsers cache files for 10 minutes and there's no way to change that, so this is the workaround. After the first visit the page loads almost instantly and even works offline. Each deploy clears the old cache, so people still get updates on their next visit.

You don't need to touch `sw.js` or `build.mjs` for normal changes.

## Credits

- CSV parsing is done by [Papa Parse](https://www.papaparse.com/) (MIT license). A copy is in `vendor/` along with its license.
- The font is [Schibsted Grotesk](https://github.com/schibsted/schibsted-grotesk) (SIL Open Font License), hosted locally in `fonts/`.
