// NowPlaying lyric-follow regression checks.
// Usage: QBASE=http://127.0.0.1:5173 npm run verify:lyrics
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.QBASE || "http://127.0.0.1:5173";
const browserPath = [
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((path) => path && existsSync(path));

if (!browserPath) throw new Error("Chrome/Chromium not found; set CHROME_BIN");

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

const page = await browser.newPage();

const waitForSmoothScroll = () => new Promise((resolve) => setTimeout(resolve, 700));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const seedLyrics = (activeIndex, fixture) => page.evaluate(({ activeIndex, fixture }) => {
  const player = window.__player;
  player.queue = [{
    mid: `lyric-follow-${fixture}`,
    name: "Lyric follow fixture",
    singer: [{ name: "Quaver" }],
    interval: 180,
  }];
  player.index = 0;
  player.lyrics = Array.from({ length: 20 }, (_, index) => ({
    t: index <= activeIndex ? 0 : 5,
    text: `line ${index}`,
    trans: index % 2 === 0 ? `translation ${index}` : undefined,
  }));
  player.lyricState = "ok";
  player.showTrans = true;
  player.expanded = true;
  player.notifyPublic();
}, { activeIndex, fixture });

const activeLinePosition = () => page.evaluate(() => {
  const lyrics = document.querySelector("#np-lyrics");
  const current = lyrics?.querySelector(".np-ly-line.cur");
  if (!(lyrics instanceof HTMLElement) || !(current instanceof HTMLElement)) {
    throw new Error("active lyric line missing");
  }
  const lyricsRect = lyrics.getBoundingClientRect();
  const currentRect = current.getBoundingClientRect();
  return {
    text: current.querySelector(".l1")?.textContent ?? "",
    scrollTop: Math.round(lyrics.scrollTop),
    centerDelta: Math.round(
      currentRect.top + currentRect.height / 2
      - (lyricsRect.top + lyricsRect.height / 2),
    ),
  };
});

const assertCentered = async (activeIndex, fixture) => {
  await seedLyrics(activeIndex, fixture);
  await waitForSmoothScroll();
  const position = await activeLinePosition();
  if (position.text !== `line ${activeIndex}` || Math.abs(position.centerDelta) > 2) {
    throw new Error(`active lyric is not centered: ${JSON.stringify({ activeIndex, ...position })}`);
  }
};

try {
  await page.setViewport({ width: 1280, height: 840 });
  await page.goto(`${BASE}/index.html#/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#now-playing");

  await page.evaluate(() => {
    const player = window.__player;
    player.queue = [{
      mid: "backdrop-fixture",
      name: "Backdrop fixture",
      singer: [{ name: "Quaver" }],
      album: { mid: "backdrop-album" },
      interval: 180,
    }];
    player.index = 0;
    player.lyrics = [];
    player.lyricState = "none";
    player.expanded = true;
    player.notifyPublic();
  });
  const backdrop = await page.$eval("#now-playing", (nowPlaying) => {
    const image = nowPlaying.querySelector("#np-backdrop-img");
    const cover = nowPlaying.querySelector("#np-cover img");
    const layer = nowPlaying.querySelector(".np-backdrop");
    if (!(image instanceof HTMLImageElement) || !(cover instanceof HTMLImageElement) || !(layer instanceof HTMLElement)) {
      throw new Error("full-screen cover layers missing");
    }
    const imageStyle = getComputedStyle(image);
    const layerRect = layer.getBoundingClientRect();
    const pageRect = nowPlaying.getBoundingClientRect();
    return {
      sameSource: image.src === cover.src,
      hidden: image.hidden,
      filter: imageStyle.filter,
      objectFit: imageStyle.objectFit,
      pointerEvents: getComputedStyle(layer).pointerEvents,
      fillsPage: Math.round(layerRect.width) === Math.round(pageRect.width)
        && Math.round(layerRect.height) === Math.round(pageRect.height),
    };
  });
  if (!backdrop.sameSource || backdrop.hidden || backdrop.filter !== "blur(56px)"
      || backdrop.objectFit !== "cover" || backdrop.pointerEvents !== "none" || !backdrop.fillsPage) {
    throw new Error(`full-screen backdrop is not wired correctly: ${JSON.stringify(backdrop)}`);
  }
  console.log("PASS album cover fills and blurs the full-screen background");

  const overlayColors = {};
  for (const theme of ["light", "dark"]) {
    overlayColors[theme] = await page.evaluate((nextTheme) => {
      document.documentElement.dataset.theme = nextTheme;
      const layer = document.querySelector(".np-backdrop");
      return getComputedStyle(layer, "::after").backgroundColor;
    }, theme);
  }
  if (overlayColors.light === overlayColors.dark) {
    throw new Error(`theme overlay did not change: ${JSON.stringify(overlayColors)}`);
  }
  console.log(`PASS full-screen overlay follows light/dark theme — ${overlayColors.light} / ${overlayColors.dark}`);

  for (const viewport of [
    { width: 1280, height: 840, name: "wide" },
    { width: 760, height: 720, name: "narrow" },
  ]) {
    await page.setViewport(viewport);
    for (const activeIndex of [0, 9, 19]) {
      await assertCentered(activeIndex, `${viewport.name}-${activeIndex}`);
    }
    console.log(`PASS ${viewport.name} viewport centers first, middle, and last lyrics`);
  }

  for (const lyricState of ["loading", "none"]) {
    await page.evaluate((state) => {
      const player = window.__player;
      player.queue = [{ mid: `lyric-${state}`, name: "Empty lyric fixture", interval: 180 }];
      player.index = 0;
      player.lyrics = [];
      player.lyricState = state;
      player.expanded = true;
      player.notifyPublic();
    }, lyricState);
    const empty = await page.$eval("#np-lyrics", (lyrics) => ({
      placeholder: !!lyrics.querySelector(".np-ly-empty"),
      beforeContent: getComputedStyle(lyrics, "::before").content,
      afterContent: getComputedStyle(lyrics, "::after").content,
    }));
    if (!empty.placeholder || empty.beforeContent !== "none" || empty.afterContent !== "none") {
      throw new Error(`${lyricState} state gained lyric scroll spacers: ${JSON.stringify(empty)}`);
    }
  }
  console.log("PASS loading and empty states have no lyric scroll spacers");

  await page.setViewport({ width: 1280, height: 840 });
  await assertCentered(0, "browse-mode");
  const lyricsBox = await page.$("#np-lyrics");
  const bounds = await lyricsBox.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel({ deltaY: 260 });
  await wait(120);
  const manuallyScrolled = await activeLinePosition();

  await page.evaluate(() => {
    const player = window.__player;
    player.lyrics[1].t = 0;
    player.notifyPublic();
  });
  await wait(500);
  const held = await activeLinePosition();
  if (held.text !== "line 1" || Math.abs(held.scrollTop - manuallyScrolled.scrollTop) > 2) {
    throw new Error(`manual lyric browsing did not hold position: ${JSON.stringify({ manuallyScrolled, held })}`);
  }

  await wait(3000);
  const resumed = await activeLinePosition();
  if (resumed.text !== "line 1" || Math.abs(resumed.centerDelta) > 2) {
    throw new Error(`lyric following did not resume after browsing: ${JSON.stringify(resumed)}`);
  }
  console.log("PASS manual browsing pauses following and resumes centered");
} finally {
  await browser.close();
}
