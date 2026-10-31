#!/usr/bin/env node
/**
 * Phase 2B — rebalanced, historically screened prospective corpus pilot.
 *
 * Writes ONLY under a new /home/dave/sma-experiments/prospective-pilot-* staging
 * directory. The production ArticleStore and RegistryStore are opened read-only
 * and used solely for historical-exclusion checks. No production article is
 * written, consumed or mutated. No snapshot/training/evaluation is created.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.EXTRACTION_MODE ??= "readability";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const PILOT_ROOT = path.join("/home/dave/sma-experiments", `prospective-rebalanced-${STAMP}`);
const USER_AGENT = "SimpleMindsAI-RebalancePilot/1.0 (local research; contact: local operator)";
const TOKENIZER = "/home/dave/sma-experiments/corpus-only-candidate-20261029T071409Z/store/v389/tokenizer.json";
const PYTHON = existsSync(path.join(REPO_ROOT, "python/.venv_test/bin/python"))
  ? path.join(REPO_ROOT, "python/.venv_test/bin/python")
  : "python3";
const DELAY_MS = 500;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SOURCES = [
  {
    family: "wikipedia-en",
    publisher: "en.wikipedia.org",
    category: "encyclopaedic/reference",
    licence: "CC BY-SA 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    termsUrl: "https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use",
    urls: [
      "https://en.wikipedia.org/wiki/Antarctica",
      "https://en.wikipedia.org/wiki/Plate_tectonics",
      "https://en.wikipedia.org/wiki/Volcano",
      "https://en.wikipedia.org/wiki/Rainforest",
      "https://en.wikipedia.org/wiki/Ancient_Egypt",
      "https://en.wikipedia.org/wiki/Mesopotamia",
      "https://en.wikipedia.org/wiki/Maya_civilization",
      "https://en.wikipedia.org/wiki/Sustainable_energy",
      "https://en.wikipedia.org/wiki/Renewable_energy",
      "https://en.wikipedia.org/wiki/Oceanography",
      "https://en.wikipedia.org/wiki/Genetics",
      "https://en.wikipedia.org/wiki/Microbiology",
      "https://en.wikipedia.org/wiki/Neuroscience",
      "https://en.wikipedia.org/wiki/Linguistics",
      "https://en.wikipedia.org/wiki/Urban_planning",
      "https://en.wikipedia.org/wiki/Public_health",
      "https://en.wikipedia.org/wiki/Climate_change",
      "https://en.wikipedia.org/wiki/Biodiversity",
      "https://en.wikipedia.org/wiki/History_of_the_Internet",
      "https://en.wikipedia.org/wiki/Electric_vehicle",
      "https://en.wikipedia.org/wiki/Archaeology",
      "https://en.wikipedia.org/wiki/Anthropology",
      "https://en.wikipedia.org/wiki/Sociology",
      "https://en.wikipedia.org/wiki/Education",
      "https://en.wikipedia.org/wiki/Transport",
      "https://en.wikipedia.org/wiki/Energy",
      "https://en.wikipedia.org/wiki/Water",
      "https://en.wikipedia.org/wiki/Desert",
      "https://en.wikipedia.org/wiki/Forest",
      "https://en.wikipedia.org/wiki/Island",
      "https://en.wikipedia.org/wiki/Earthquake",
      "https://en.wikipedia.org/wiki/Meteorology",
    ],
  },
  {
    family: "project-gutenberg",
    publisher: "gutenberg.org",
    category: "public-domain books/literature",
    licence: "Public domain in the United States (Project Gutenberg terms)",
    licenceUrl: "https://www.gutenberg.org/policy/terms_of_use.html",
    termsUrl: "https://www.gutenberg.org/policy/terms_of_use.html",
    urls: [
      "https://www.gutenberg.org/cache/epub/1342/pg1342.txt",
      "https://www.gutenberg.org/cache/epub/84/pg84.txt",
      "https://www.gutenberg.org/cache/epub/2701/pg2701.txt",
      "https://www.gutenberg.org/cache/epub/1661/pg1661.txt",
    ],
  },
  {
    family: "nasa",
    publisher: "nasa.gov",
    category: "scientific/educational",
    licence: "NASA media usage: generally not subject to copyright in the United States",
    licenceUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
    termsUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
    urls: [
      "https://science.nasa.gov/solar-system/",
      "https://science.nasa.gov/universe/",
      "https://science.nasa.gov/earth/",
      "https://science.nasa.gov/moon/",
      "https://science.nasa.gov/mars/",
      "https://science.nasa.gov/jupiter/",
      "https://science.nasa.gov/saturn/",
      "https://science.nasa.gov/exoplanets/",
      "https://science.nasa.gov/astrobiology/",
      "https://science.nasa.gov/heliophysics/",
      "https://science.nasa.gov/biological-physical/",
      "https://science.nasa.gov/planetary-science/",
      "https://www.nasa.gov/humans-in-space/",
      "https://www.nasa.gov/artemis/",
      "https://www.nasa.gov/webb/",
      "https://science.nasa.gov/venus/",
      "https://science.nasa.gov/mercury/",
      "https://science.nasa.gov/neptune/",
      "https://science.nasa.gov/uranus/",
      "https://science.nasa.gov/asteroids-comets-meteors/",
      "https://science.nasa.gov/sun/",
      "https://science.nasa.gov/space-weather/",
      "https://science.nasa.gov/technology/",
      "https://science.nasa.gov/missions/",
      "https://science.nasa.gov/science-research/",
    ],
  },
  {
    family: "gov-uk",
    publisher: "www.gov.uk",
    category: "government/general knowledge (OGL)",
    licence: "Open Government Licence v3.0",
    licenceUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    urls: [
      "https://www.gov.uk/guidance/the-highway-code",
      "https://www.gov.uk/guidance/universal-credit-how-it-works",
      "https://www.gov.uk/government/publications/uk-climate-change-risk-assessment-2022",
      "https://www.gov.uk/government/publications/national-ai-strategy",
      "https://www.gov.uk/government/publications/uk-space-strategy",
      "https://www.gov.uk/government/publications/levelling-up-the-united-kingdom",
      "https://www.gov.uk/government/publications/integrated-review-of-defence-security-and-development",
      "https://www.gov.uk/government/publications/clean-growth-strategy",
      "https://www.gov.uk/government/publications/net-zero-strategy",
      "https://www.gov.uk/government/publications/uk-digital-strategy",
      "https://www.gov.uk/government/publications/industrial-strategy-white-paper-2017",
      "https://www.gov.uk/government/publications/national-cyber-security-strategy-2022-to-2030",
      "https://www.gov.uk/government/publications/uk-biodiversity-strategy-and-action-plan",
      "https://www.gov.uk/government/publications/childhood-obesity-a-plan-for-action",
      "https://www.gov.uk/government/publications/social-care-common-core-principles",
    ],
  },
  {
    family: "python-docs",
    publisher: "docs.python.org",
    category: "technical documentation",
    licence: "Python Software Foundation License / Python documentation licence",
    licenceUrl: "https://docs.python.org/3/license.html",
    termsUrl: "https://docs.python.org/3/license.html",
    urls: [
      "https://docs.python.org/3/tutorial/introduction.html",
      "https://docs.python.org/3/tutorial/controlflow.html",
      "https://docs.python.org/3/tutorial/datastructures.html",
      "https://docs.python.org/3/tutorial/modules.html",
      "https://docs.python.org/3/tutorial/inputoutput.html",
      "https://docs.python.org/3/tutorial/errors.html",
      "https://docs.python.org/3/tutorial/classes.html",
      "https://docs.python.org/3/tutorial/stdlib.html",
      "https://docs.python.org/3/tutorial/stdlib2.html",
      "https://docs.python.org/3/tutorial/venv.html",
      "https://docs.python.org/3/tutorial/whatnow.html",
      "https://docs.python.org/3/tutorial/interactive.html",
      "https://docs.python.org/3/tutorial/floatingpoint.html",
      "https://docs.python.org/3/tutorial/appendix.html",
      "https://docs.python.org/3/library/functions.html",
      "https://docs.python.org/3/library/stdtypes.html",
      "https://docs.python.org/3/library/exceptions.html",
      "https://docs.python.org/3/library/re.html",
      "https://docs.python.org/3/library/json.html",
      "https://docs.python.org/3/library/pathlib.html",
      "https://docs.python.org/3/library/datetime.html",
      "https://docs.python.org/3/library/collections.html",
      "https://docs.python.org/3/library/itertools.html",
      "https://docs.python.org/3/library/functools.html",
      "https://docs.python.org/3/library/os.html",
      "https://docs.python.org/3/library/sys.html",
      "https://docs.python.org/3/library/subprocess.html",
      "https://docs.python.org/3/library/threading.html",
      "https://docs.python.org/3/library/asyncio.html",
      "https://docs.python.org/3/library/unittest.html",
    ],
  },
  {
    family: "nist",
    publisher: "nist.gov",
    category: "standards/scientific institution",
    licence: "NIST public-domain content; copyrights and disclaimers page",
    licenceUrl: "https://www.nist.gov/copyrights-disclaimers",
    termsUrl: "https://www.nist.gov/copyrights-disclaimers",
    urls: [
      "https://www.nist.gov/standards-and-measurements",
      "https://www.nist.gov/cybersecurity",
      "https://www.nist.gov/physical-measurement-laboratory",
      "https://www.nist.gov/mml",
      "https://www.nist.gov/itl",
      "https://www.nist.gov/el",
      "https://www.nist.gov/communications-technology-laboratory",
      "https://www.nist.gov/ncnr",
    ],
  },
  {
    family: "epa",
    publisher: "epa.gov",
    category: "government/public-sector environmental science",
    licence: "U.S. federal government work; EPA disclaimers page",
    licenceUrl: "https://www.epa.gov/web-policies-and-procedures/epa-disclaimers",
    termsUrl: "https://www.epa.gov/web-policies-and-procedures/epa-disclaimers",
    urls: [
      "https://www.epa.gov/climate-change",
      "https://www.epa.gov/air-quality",
      "https://www.epa.gov/water-research",
      "https://www.epa.gov/energy",
      "https://www.epa.gov/watersense",
      "https://www.epa.gov/recycle",
      "https://www.epa.gov/radon",
      "https://www.epa.gov/pesticides",
    ],
  },
  {
    family: "doe",
    publisher: "energy.gov",
    category: "government/public-sector energy science",
    licence: "U.S. federal government work; DOE web policies",
    licenceUrl: "https://www.energy.gov/about-us/web-policies",
    termsUrl: "https://www.energy.gov/about-us/web-policies",
    urls: [
      "https://www.energy.gov/science/office-science",
      "https://www.energy.gov/energysaver/energy-efficient-home-design",
      "https://www.energy.gov/eere/renewable-energy",
      "https://www.energy.gov/eere/solar/solar-energy-technology-basics",
      "https://www.energy.gov/eere/wind/wind-energy-basics",
      "https://www.energy.gov/eere/water/water-power-basics",
      "https://www.energy.gov/energysaver/weatherize",
      "https://www.energy.gov/science/np/nuclear-physics",
    ],
  },
  {
    family: "nps",
    publisher: "nps.gov",
    category: "government/public-sector natural and cultural heritage",
    licence: "U.S. federal government work; NPS disclaimer",
    licenceUrl: "https://www.nps.gov/aboutus/disclaimer.htm",
    termsUrl: "https://www.nps.gov/aboutus/disclaimer.htm",
    urls: [
      "https://www.nps.gov/subjects/climatechange/index.htm",
      "https://www.nps.gov/subjects/geology/index.htm",
      "https://www.nps.gov/subjects/wilderness/index.htm",
      "https://www.nps.gov/subjects/history/index.htm",
      "https://www.nps.gov/subjects/naturalresources/index.htm",
      "https://www.nps.gov/subjects/air/index.htm",
      "https://www.nps.gov/subjects/waterres/index.htm",
      "https://www.nps.gov/subjects/archaeology/index.htm",
    ],
  },
  {
    family: "census",
    publisher: "census.gov",
    category: "government/public-sector statistics and society",
    licence: "U.S. federal government work; Census policies",
    licenceUrl: "https://www.census.gov/about/policies.html",
    termsUrl: "https://www.census.gov/about/policies.html",
    urls: [
      "https://www.census.gov/programs-surveys/decennial-census/about.html",
      "https://www.census.gov/programs-surveys/acs/about.html",
      "https://www.census.gov/topics/population.html",
      "https://www.census.gov/topics/income-poverty.html",
      "https://www.census.gov/topics/education.html",
      "https://www.census.gov/topics/housing.html",
      "https://www.census.gov/topics/business-industry.html",
      "https://www.census.gov/topics/health.html",
    ],
  },
  {
    family: "openstax",
    publisher: "openstax.org",
    category: "open educational resources",
    licence: "Creative Commons Attribution 4.0 (CC BY 4.0), per OpenStax license page",
    licenceUrl: "https://openstax.org/license",
    termsUrl: "https://openstax.org/terms-of-use",
    urls: [
      "https://openstax.org/books/physics/pages/1-introduction",
      "https://openstax.org/books/physics/pages/2-1-relative-motion-distance-and-displacement",
      "https://openstax.org/books/biology-2e/pages/1-introduction",
      "https://openstax.org/books/biology-2e/pages/1-1-the-science-of-biology",
      "https://openstax.org/books/chemistry-2e/pages/1-introduction",
      "https://openstax.org/books/chemistry-2e/pages/1-1-chemistry-in-context",
      "https://openstax.org/books/world-history-volume-1/pages/1-introduction",
      "https://openstax.org/books/psychology-2e/pages/1-introduction",
      "https://openstax.org/books/physics/pages/1-1-physics-definitions-and-applications",
      "https://openstax.org/books/physics/pages/1-2-the-scientific-methods",
      "https://openstax.org/books/physics/pages/1-3-the-language-of-physics-physical-quantities-and-units",
      "https://openstax.org/books/physics/pages/2-2-speed-and-velocity",
      "https://openstax.org/books/physics/pages/2-3-acceleration",
      "https://openstax.org/books/physics/pages/3-1-acceleration",
      "https://openstax.org/books/physics/pages/3-2-representing-acceleration-with-velocity-time-graphs",
      "https://openstax.org/books/physics/pages/4-1-force",
      "https://openstax.org/books/physics/pages/4-2-newtons-first-law-of-motion-inertia",
      "https://openstax.org/books/physics/pages/4-3-newtons-second-law-of-motion",
      "https://openstax.org/books/physics/pages/5-1-vector-addition-and-subtraction-graphical-methods",
      "https://openstax.org/books/physics/pages/5-2-vector-addition-and-subtraction-analytical-methods",
      "https://openstax.org/books/physics/pages/6-1-angle-of-rotation-and-angular-velocity",
      "https://openstax.org/books/physics/pages/6-2-uniform-circular-motion",
      "https://openstax.org/books/physics/pages/7-1-work-the-scientific-definition",
      "https://openstax.org/books/physics/pages/7-2-kinetic-energy-and-the-work-energy-theorem",
      "https://openstax.org/books/physics/pages/8-1-linear-momentum-force-and-impulse",
      "https://openstax.org/books/physics/pages/8-2-conservation-of-momentum",
      "https://openstax.org/books/physics/pages/9-1-work-energy-and-power",
      "https://openstax.org/books/physics/pages/9-2-mechanical-energy-and-conservation-of-energy",
      "https://openstax.org/books/physics/pages/10-1-postulates-of-special-relativity",
      "https://openstax.org/books/physics/pages/10-2-consequences-of-special-relativity",
      "https://openstax.org/books/physics/pages/11-1-temperature-and-thermal-energy",
      "https://openstax.org/books/physics/pages/11-2-heat-specific-heat-and-heat-transfer",
      "https://openstax.org/books/physics/pages/12-1-zeroth-law-of-thermodynamics-thermal-equilibrium",
      "https://openstax.org/books/physics/pages/12-2-first-law-of-thermodynamics-thermal-energy-and-work",
      "https://openstax.org/books/physics/pages/13-1-types-of-waves",
      "https://openstax.org/books/physics/pages/13-2-wave-properties-speed-amplitude-frequency-and-period",
      "https://openstax.org/books/physics/pages/14-1-speed-of-sound-frequency-and-wavelength",
      "https://openstax.org/books/physics/pages/15-1-the-electromagnetic-spectrum",
      "https://openstax.org/books/physics/pages/16-1-reflection",
      "https://openstax.org/books/physics/pages/17-1-understanding-diffraction-and-interference",
      "https://openstax.org/books/physics/pages/18-1-electrical-charges-conservation-of-charge-and-transfer-of-charge",
      "https://openstax.org/books/physics/pages/18-2-coulombs-law",
      "https://openstax.org/books/physics/pages/19-1-ohms-law",
      "https://openstax.org/books/physics/pages/19-2-series-circuits",
      "https://openstax.org/books/physics/pages/20-1-magnetic-fields-field-lines-and-force",
      "https://openstax.org/books/physics/pages/21-1-planck-and-quantum-nature-of-light",
      "https://openstax.org/books/physics/pages/22-1-the-structure-of-the-atom",
      "https://openstax.org/books/physics/pages/23-1-the-four-fundamental-forces",
    ],
  },
  {
    family: "mit-ocw",
    publisher: "ocw.mit.edu",
    category: "open courseware/educational",
    licence: "MIT OpenCourseWare CC BY-NC-SA terms",
    licenceUrl: "https://ocw.mit.edu/terms/",
    termsUrl: "https://ocw.mit.edu/terms/",
    urls: [
      "https://ocw.mit.edu/courses/8-01sc-classical-mechanics-fall-2016/pages/readings/",
      "https://ocw.mit.edu/courses/8-02sc-physics-ii-electricity-and-magnetism-fall-2010/pages/readings/",
      "https://ocw.mit.edu/courses/18-01sc-single-variable-calculus-fall-2010/pages/readings/",
      "https://ocw.mit.edu/courses/18-02sc-multivariable-calculus-fall-2010/pages/readings/",
      "https://ocw.mit.edu/courses/6-0001-introduction-to-computer-science-and-programming-in-python-fall-2016/pages/lecture-slides-code/",
      "https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/pages/lecture-notes/",
      "https://ocw.mit.edu/courses/7-01sc-fundamentals-of-biology-fall-2011/pages/readings/",
      "https://ocw.mit.edu/courses/9-01-introduction-to-neuroscience-fall-2007/pages/readings/",
    ],
  },
  {
    family: "libretexts",
    publisher: "libretexts.org",
    category: "open textbooks/educational",
    licence: "LibreTexts content under Creative Commons licences (content-level evidence; flag for review)",
    licenceUrl: "https://chem.libretexts.org/Bookshelves/Introductory_Chemistry",
    termsUrl: "https://chem.libretexts.org/Bookshelves/Introductory_Chemistry",
    urls: [
      "https://chem.libretexts.org/Bookshelves/Introductory_Chemistry",
      "https://bio.libretexts.org/Bookshelves/Introductory_and_General_Biology",
      "https://phys.libretexts.org/Bookshelves/University_Physics",
      "https://math.libretexts.org/Bookshelves/Calculus",
      "https://eng.libretexts.org/Bookshelves/Computer_Science",
      "https://socialsci.libretexts.org/Bookshelves/Political_Science",
      "https://human.libretexts.org/Bookshelves/History",
      "https://geo.libretexts.org/Bookshelves/Oceanography",
    ],
  },
];


const PUBLISHER_BUDGETS = Object.freeze({
  "project-gutenberg": 350_000,
  "wikipedia-en": 300_000,
  "python-docs": 150_000,
  "nasa": 50_000,
  "gov-uk": 50_000,
  "nist": 100_000,
  "epa": 100_000,
  "doe": 100_000,
  "nps": 100_000,
  "census": 100_000,
  "openstax": 250_000,
  "mit-ocw": 100_000,
  "libretexts": 100_000,
});

function canonical(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    let p = u.pathname.replace(/\/+$/, "");
    if (!p) p = "/";
    return `${u.protocol}//${u.hostname}${p}${u.search}`;
  } catch {
    return String(url);
  }
}
function publisher(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return "unknown"; }
}

async function main() {
  const { fetchDocument, parseRobots, robotsAllows } = await import("../src/harness/fetcher.js");
  const { cleanRawText, buildCommonLines } = await import("../src/dataset/corpus-text.js");
  const { evaluateCorpusLanguage } = await import("../src/dataset/language-policy.js");
  const {
    buildContentClusters,
    minhashSignatureForText,
    lshBandKeys,
    wordShingles,
    jaccardFromSets,
    normalizeDedupText,
  } = await import("../src/dataset/dedup.js");
  const { buildPartition } = await import("../src/dataset/partition.js");
  const { computeCorpusDiversity } = await import("../src/dataset/diversity.js");
  const { ArticleStore } = await import("../src/storage/article-store.js");
  const { RegistryStore } = await import("../src/storage/registry-store.js");

  await mkdir(PILOT_ROOT, { recursive: true });
  await mkdir(path.join(PILOT_ROOT, "robots"), { recursive: true });
  await mkdir(path.join(PILOT_ROOT, "licences"), { recursive: true });
  await mkdir(path.join(PILOT_ROOT, "documents"), { recursive: true });
  await mkdir(path.join(PILOT_ROOT, "corpus"), { recursive: true });

  const production = await ArticleStore.open("/var/lib/simpleminds/data/articles", { readOnly: true });
  const registry = await RegistryStore.open("/var/lib/simpleminds/data/registry", { readOnly: true });
  const historicalUrls = new Set();
  const historicalHashes = new Set();
  for (const article of production.articles.values()) {
    if (article.sourceUrl) historicalUrls.add(canonical(article.sourceUrl));
    if (article.contentHash) historicalHashes.add(article.contentHash);
    if (article.fetchedContentHash) historicalHashes.add(article.fetchedContentHash);
  }
  const historicalSnapshotIds = new Set();
  for (const snap of registry.listSnapshots()) for (const id of snap.articleIds ?? []) historicalSnapshotIds.add(id);

  // Actual historical text index. Signatures are streamed; no historical text
  // is copied into the prospective corpus. Exact/normalised maps cover every
  // production article, including job-40 material (treated conservatively as
  // historical unless independently shown otherwise).
  const historicalIndexEntries = [];
  const historicalExact = new Map();
  const historicalNormalized = new Map();
  const historicalSource = new Map();
  const historicalBuckets = new Map();
  const addMap = (map, key, id) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    list.push(id);
    map.set(key, list);
  };
  for (const article of production.articles.values()) {
    const text = String(article.rawText ?? article.text ?? "");
    if (!text.trim()) continue;
    const sourceId = article.fetchedContentHash || canonical(article.sourceUrl ?? "") || article.articleId;
    const normalizedHash = sha256(normalizeDedupText(text));
    const signature = minhashSignatureForText(text, { hashCount: 32 });
    const entry = {
      articleId: article.articleId,
      contentHash: article.contentHash ?? null,
      fetchedContentHash: article.fetchedContentHash ?? null,
      normalizedHash,
      sourceId,
      sourceUrl: article.sourceUrl ?? null,
      status: article.status ?? null,
      signature: Array.from(signature),
    };
    historicalIndexEntries.push(entry);
    if (article.contentHash) addMap(historicalExact, article.contentHash, article.articleId);
    if (article.fetchedContentHash) addMap(historicalExact, article.fetchedContentHash, article.articleId);
    addMap(historicalNormalized, normalizedHash, article.articleId);
    addMap(historicalSource, sourceId, article.articleId);
    for (const key of lshBandKeys(signature, { bands: 8 })) addMap(historicalBuckets, key, article.articleId);
  }
  historicalIndexEntries.sort((a, b) => a.articleId.localeCompare(b.articleId));
  const historicalIndexPolicy = {
    schema: "sma/historical-comparison-index@1",
    sourceStore: "/var/lib/simpleminds/data/articles",
    articleCount: historicalIndexEntries.length,
    minhashHashes: 32,
    minhashShingleSize: 5,
    lshBands: 8,
    normalizedWith: "lowercase NFKC; non-alphanumeric to space; whitespace collapsed",
    comparisonThresholds: { probableNearDuplicate: 0.6, ambiguous: 0.4 },
    note: "Contains historical identifiers/hashes/signatures only; no historical text is copied.",
  };
  const historicalIndexFingerprint = sha256(JSON.stringify({ policy: historicalIndexPolicy, entries: historicalIndexEntries }));
  const historicalIndexFile = path.join(PILOT_ROOT, "historical-index.json");
  await writeFile(historicalIndexFile, JSON.stringify({ policy: historicalIndexPolicy, fingerprint: historicalIndexFingerprint, entries: historicalIndexEntries }, null, 2) + "\n", "utf8");

  const robotsCache = new Map();
  const robotsEvidence = [];
  async function robotsFor(url) {
    const host = publisher(url);
    if (robotsCache.has(host)) return robotsCache.get(host);
    const origin = new URL(url).origin;
    const robotsUrl = `${origin}/robots.txt`;
    try {
      const res = await fetchDocument(robotsUrl, {
        timeoutMs: 15000,
        maxBytes: 1_000_000,
        maxRedirects: 3,
        userAgent: USER_AGENT,
      });
      const groups = parseRobots(res.text);
      const file = path.join(PILOT_ROOT, "robots", `${host}.txt`);
      await writeFile(file, res.text, "utf8");
      const evidence = { host, robotsUrl, status: res.status, fetchedAt: res.fetchedAt, bytes: res.bytes, sha256: sha256(res.text), file, allowed: true };
      robotsCache.set(host, { groups, evidence });
      robotsEvidence.push(evidence);
      return { groups, evidence };
    } catch (err) {
      const evidence = { host, robotsUrl, status: "unavailable", fetchedAt: new Date().toISOString(), error: err.message, allowed: false };
      robotsCache.set(host, { groups: null, evidence });
      robotsEvidence.push(evidence);
      return { groups: null, evidence };
    }
  }

  const licenceEvidence = [];
  const licenceSeen = new Set();
  for (const source of SOURCES) {
    for (const key of ["licenceUrl", "termsUrl"]) {
      const url = source[key];
      if (!url || licenceSeen.has(url)) continue;
      licenceSeen.add(url);
      const robots = await robotsFor(url);
      const allowed = robots.groups ? robotsAllows(robots.groups, new URL(url).pathname + new URL(url).search, USER_AGENT) : false;
      try {
        if (!allowed) throw new Error("robots-disallowed");
        const res = await fetchDocument(url, { timeoutMs: 20000, maxBytes: 1_000_000, maxRedirects: 4, userAgent: USER_AGENT });
        const file = path.join(PILOT_ROOT, "licences", `${source.family}-${sha256(url).slice(0, 8)}.txt`);
        await writeFile(file, res.text, "utf8");
        const snippet = (res.text.match(/.{0,120}(?:licen[cs]e|public domain|copyright|open government licence|PSF).{0,180}/gi) ?? []).slice(0, 5).join("\n");
        licenceEvidence.push({ family: source.family, url, status: res.status, fetchedAt: res.fetchedAt, sha256: sha256(res.text), file, snippet });
      } catch (err) {
        licenceEvidence.push({ family: source.family, url, status: "unavailable", error: err.message, robotsAllowed: allowed });
      }
      await sleep(DELAY_MS);
    }
  }

  const declarations = [];
  for (const source of SOURCES) {
    for (const url of source.urls) declarations.push({ source, url, canonicalUrl: canonical(url), sourceId: canonical(url) });
  }

  const acquisitions = [];
  const fetched = [];
  let foregroundCounter = 0;
  for (const item of declarations) {
    foregroundCounter += 1;
    const base = {
      sourceFamily: item.source.family,
      publisher: publisher(item.url),
      originalUrl: item.url,
      canonicalUrl: item.canonicalUrl,
      sourceId: item.sourceId,
      licence: item.source.licence,
      licenceUrl: item.source.licenceUrl,
      termsUrl: item.source.termsUrl,
    };
    if (historicalUrls.has(item.canonicalUrl)) {
      acquisitions.push({ ...base, state: "deferred", reason: "historical-url-in-production-store", at: new Date().toISOString() });
      continue;
    }
    const robots = await robotsFor(item.url);
    if (!robots.groups) {
      acquisitions.push({ ...base, state: "deferred", reason: "robots-unavailable", robots: robots.evidence, at: new Date().toISOString() });
      continue;
    }
    const pathPlusQuery = new URL(item.url).pathname + new URL(item.url).search;
    if (!robotsAllows(robots.groups, pathPlusQuery, USER_AGENT)) {
      acquisitions.push({ ...base, state: "deferred", reason: "robots-disallowed", robots: robots.evidence, at: new Date().toISOString() });
      continue;
    }
    let res = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        res = await fetchDocument(item.url, {
          timeoutMs: 20000,
          maxBytes: 2_000_000,
          maxRedirects: 5,
          userAgent: USER_AGENT,
        });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (!["FETCH_NETWORK", "FETCH_TIMEOUT"].includes(err.code) || attempt === 2) break;
        await sleep(1500 * attempt);
      }
    }
    if (!res) {
      acquisitions.push({ ...base, state: "failed", reason: lastError?.code ?? "fetch-error", error: lastError?.message ?? null, at: new Date().toISOString() });
      await sleep(DELAY_MS);
      continue;
    }
    const contentHash = sha256(String(res.text ?? ""));
    const record = {
      ...base,
      state: "fetched",
      finalUrl: res.url,
      retrievedAt: res.fetchedAt,
      status: res.status,
      contentType: res.contentType,
      bytes: res.bytes,
      redirects: res.redirects,
      title: res.title,
      htmlLang: res.htmlLang,
      extraction: res.extraction,
      contentHash,
      rawChars: String(res.text ?? "").length,
      robots: robots.evidence,
    };
    acquisitions.push(record);
    fetched.push({ ...record, text: res.text });
    await sleep(DELAY_MS);
  }

  const commonLines = buildCommonLines(fetched.map((d) => ({ rawText: d.text })), { threshold: 10 });
  const cleaned = [];
  const rejected = [];
  const quarantined = [];
  const historicalScreening = [];
  const historicalShingleCache = new Map();
  const historicalText = (id) => {
    const article = production.articles.get(id);
    return String(article?.rawText ?? article?.text ?? "");
  };
  const historicalShingles = (id) => {
    if (!historicalShingleCache.has(id)) historicalShingleCache.set(id, wordShingles(historicalText(id), 5));
    return historicalShingleCache.get(id);
  };
  const screenHistorical = (doc) => {
    const normalizedHash = sha256(normalizeDedupText(doc.text));
    const signature = minhashSignatureForText(doc.text, { hashCount: 32 });
    const candidateIds = new Set();
    for (const id of historicalExact.get(doc.contentHash) ?? []) candidateIds.add(id);
    for (const id of historicalExact.get(doc.rawContentHash) ?? []) candidateIds.add(id);
    for (const id of historicalNormalized.get(normalizedHash) ?? []) candidateIds.add(id);
    for (const id of historicalSource.get(doc.sourceId) ?? []) candidateIds.add(id);
    for (const key of lshBandKeys(signature, { bands: 8 })) {
      for (const id of historicalBuckets.get(key) ?? []) candidateIds.add(id);
    }
    const newShingles = wordShingles(doc.text, 5);
    const exactHit = (historicalExact.get(doc.contentHash) ?? [])[0]
      || (historicalExact.get(doc.rawContentHash) ?? [])[0]
      || null;
    const normalizedHit = (historicalNormalized.get(normalizedHash) ?? [])[0] || null;
    const sourceHit = (historicalSource.get(doc.sourceId) ?? [])[0] || null;
    let best = null;
    const matches = [];
    for (const id of [...candidateIds].slice(0, 256)) {
      const similarity = id === exactHit || id === normalizedHit || id === sourceHit
        ? 1
        : jaccardFromSets(newShingles, historicalShingles(id));
      const entry = { articleId: id, similarity: +Number(similarity).toFixed(6), sourceUrl: production.articles.get(id)?.sourceUrl ?? null };
      matches.push(entry);
      if (!best || similarity > best.similarity) best = entry;
    }
    matches.sort((a, b) => b.similarity - a.similarity || a.articleId.localeCompare(b.articleId));
    let outcome = "NO_HISTORICAL_MATCH";
    let matchType = null;
    if (exactHit) { outcome = "EXACT_HISTORICAL_MATCH"; matchType = "content-hash"; }
    else if (normalizedHit) { outcome = "NORMALISED_HISTORICAL_MATCH"; matchType = "normalised-hash"; }
    else if (sourceHit) { outcome = "EXACT_HISTORICAL_MATCH"; matchType = "source-identity"; }
    else if (best && best.similarity >= 0.6) { outcome = "PROBABLE_NEAR_DUPLICATE"; matchType = "lexical-jaccard"; }
    else if (best && best.similarity >= 0.4) { outcome = "AMBIGUOUS_REQUIRES_REVIEW"; matchType = "lexical-jaccard"; }
    return {
      articleId: doc.articleId,
      sourceId: doc.sourceId,
      outcome,
      matchType,
      bestSimilarity: best?.similarity ?? 0,
      matches: matches.slice(0, 10),
      normalizedHash,
      signature: Array.from(signature),
    };
  };

  for (const doc of fetched) {
    if (historicalHashes.has(doc.contentHash)) {
      rejected.push({ sourceId: doc.sourceId, reason: "historical-content-hash", contentHash: doc.contentHash });
      continue;
    }
    const clean = cleanRawText(doc.text, { commonLines, minChars: 1500, minSentenceRatio: 0 });
    if (!clean.accepted) {
      rejected.push({ sourceId: doc.sourceId, reason: clean.chars < 1500 ? "short" : "low-sentence-ratio", chars: clean.chars, sentenceRatio: clean.sentenceRatio });
      continue;
    }
    const lang = evaluateCorpusLanguage(clean.text, {
      htmlLang: doc.htmlLang,
      sourceUrl: doc.finalUrl,
      supportedLanguages: "en",
      minConfidence: 0.8,
      unknownPolicy: "reject",
    });
    if (!lang.eligible) {
      rejected.push({ sourceId: doc.sourceId, reason: `language:${lang.reason}`, language: lang.language, confidence: lang.confidence });
      continue;
    }
    const articleId = `pilot_${doc.sourceFamily}_${doc.contentHash.slice(0, 12)}`;
    const screened = screenHistorical({ ...doc, articleId, text: clean.text });
    historicalScreening.push(screened);
    if (["EXACT_HISTORICAL_MATCH", "NORMALISED_HISTORICAL_MATCH", "PROBABLE_NEAR_DUPLICATE"].includes(screened.outcome)) {
      rejected.push({ articleId, sourceId: doc.sourceId, reason: `historical:${screened.outcome}`, bestSimilarity: screened.bestSimilarity, matches: screened.matches });
      continue;
    }
    if (screened.outcome === "AMBIGUOUS_REQUIRES_REVIEW") {
      quarantined.push({ articleId, sourceId: doc.sourceId, reason: screened.outcome, bestSimilarity: screened.bestSimilarity, matches: screened.matches });
      continue;
    }
    cleaned.push({
      articleId,
      contentHash: sha256(clean.text),
      rawContentHash: doc.contentHash,
      text: clean.text,
      sourceId: doc.sourceId,
      publisherId: doc.publisher,
      sourceFamily: doc.sourceFamily,
      sourceUrl: doc.finalUrl,
      title: doc.title,
      retrievedAt: doc.retrievedAt,
      licence: doc.licence,
      licenceUrl: doc.licenceUrl,
      termsUrl: doc.termsUrl,
      extraction: doc.extraction,
      qualityTier: "full-text",
      language: lang.language,
      languageConfidence: lang.confidence,
      estimatedTokens: Math.ceil(clean.text.length / 4),
      rawChars: clean.chars,
      sentenceRatio: clean.sentenceRatio,
      historicalScreening: screened.outcome,
      historicalBestSimilarity: screened.bestSimilarity,
    });
  }

  // Deduplicate before accepting. Keep the longest representative per cluster.
  const clusters = buildContentClusters(cleaned.map((d) => ({
    articleId: d.articleId,
    text: d.text,
    contentHash: d.contentHash,
    sourceId: d.sourceId,
  })));
  const byCluster = new Map();
  for (const doc of cleaned) {
    const cid = clusters.clusterByArticle.get(doc.articleId);
    const list = byCluster.get(cid) ?? [];
    list.push(doc);
    byCluster.set(cid, list);
  }
  const accepted = [];
  const duplicateRejected = [];
  for (const [clusterId, members] of byCluster) {
    const sorted = [...members].sort((a, b) => b.rawChars - a.rawChars || a.articleId.localeCompare(b.articleId));
    const winner = sorted[0];
    winner.clusterId = clusterId;
    accepted.push(winner);
    for (const loser of sorted.slice(1)) {
      duplicateRejected.push({ articleId: loser.articleId, sourceId: loser.sourceId, reason: "duplicate-cluster", clusterId, keptAs: winner.articleId });
    }
  }
  accepted.sort((a, b) => a.articleId.localeCompare(b.articleId));

  const acceptedFile = path.join(PILOT_ROOT, "corpus", "accepted-estimated.jsonl");
  await writeFile(acceptedFile, accepted.map((d) => JSON.stringify(d)).join("\n") + "\n", "utf8");
  const tokenizedAllFile = path.join(PILOT_ROOT, "corpus", "accepted-tokenized-all.jsonl");
  const tokenizedFile = path.join(PILOT_ROOT, "corpus", "accepted-tokenized.jsonl");
  const tokenizeCode = String.raw`
import json, sys
from tokenizers import Tokenizer
tok = Tokenizer.from_file(sys.argv[1])
rows = []
for line in open(sys.argv[2], encoding="utf-8"):
    if not line.strip():
        continue
    row = json.loads(line)
    row["actualTokens"] = len(tok.encode(row["text"], add_special_tokens=False).ids)
    rows.append(row)
with open(sys.argv[3], "w", encoding="utf-8") as fh:
    for row in rows:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
print(json.dumps({"rows": len(rows), "tokens": sum(r["actualTokens"] for r in rows)}))
`;
  const tokenize = JSON.parse(execFileSync(PYTHON, ["-c", tokenizeCode, TOKENIZER, acceptedFile, tokenizedAllFile], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }));
  const tokenizedAll = (await readFile(tokenizedAllFile, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  const tokenized = [];
  const publisherBudgetExcluded = [];
  const publisherUsed = new Map();
  for (const row of [...tokenizedAll].sort((a, b) => a.articleId.localeCompare(b.articleId))) {
    const budget = PUBLISHER_BUDGETS[row.sourceFamily] ?? 100_000;
    const used = publisherUsed.get(row.sourceFamily) ?? 0;
    if (used + row.actualTokens > budget) {
      publisherBudgetExcluded.push({ articleId: row.articleId, sourceFamily: row.sourceFamily, publisherId: row.publisherId, actualTokens: row.actualTokens, reason: "publisher-token-budget", budget });
      continue;
    }
    publisherUsed.set(row.sourceFamily, used + row.actualTokens);
    tokenized.push(row);
  }
  tokenized.sort((a, b) => a.articleId.localeCompare(b.articleId));
  await writeFile(tokenizedFile, tokenized.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");

  let partition = null;
  let partitionError = null;
  try {
    partition = buildPartition({
      rows: tokenized.map((row) => ({ ...row, estimatedTokens: row.actualTokens })),
      splitSeed: 20261030,
      validationFraction: 0.15,
      validationTargetTokens: 0,
      minValidationTokens: 50_000,
      minValidationClusters: 10,
      historicalArticleIds: new Set(),
      requireProspective: true,
    });
  } catch (err) {
    partitionError = { code: err.code ?? "PARTITION_ERROR", message: err.message, detail: err };
  }

  let trainRows = [];
  let validationRows = [];
  if (partition) {
    const byId = new Map(tokenized.map((row) => [row.articleId, row]));
    trainRows = partition.trainArticleIds.map((id) => byId.get(id));
    validationRows = partition.validationArticleIds.map((id) => byId.get(id));
  }
  const trainFile = path.join(PILOT_ROOT, "corpus", "train.jsonl");
  const validationFile = path.join(PILOT_ROOT, "corpus", "validation.jsonl");
  await writeFile(trainFile, trainRows.map((row) => JSON.stringify({ ...row, corpusRole: "train" })).join("\n") + "\n", "utf8");
  await writeFile(validationFile, validationRows.map((row) => JSON.stringify({ ...row, corpusRole: "validation" })).join("\n") + "\n", "utf8");
  const assignmentFile = path.join(PILOT_ROOT, "corpus", "split-assignment.json");
  await writeFile(assignmentFile, JSON.stringify(partition ?? { error: partitionError }, null, 2) + "\n", "utf8");

  const diversity = computeCorpusDiversity(tokenized.map((row) => ({ ...row, estimatedTokens: row.actualTokens })));
  const byFamily = new Map();
  for (const row of tokenized) {
    const entry = byFamily.get(row.sourceFamily) ?? { family: row.sourceFamily, documents: 0, tokens: 0, publishers: new Set() };
    entry.documents += 1;
    entry.tokens += row.actualTokens;
    entry.publishers.add(row.publisherId);
    byFamily.set(row.sourceFamily, entry);
  }
  const familyReport = [...byFamily.values()].map((entry) => ({ ...entry, publishers: [...entry.publishers] }));
  const validationTokens = validationRows.reduce((sum, row) => sum + row.actualTokens, 0);
  const trainTokens = trainRows.reduce((sum, row) => sum + row.actualTokens, 0);
  const validationSourceIds = new Set(validationRows.map((row) => row.sourceId));
  const trainingSourceIds = new Set(trainRows.map((row) => row.sourceId));
  const crossingSources = [...validationSourceIds].filter((id) => trainingSourceIds.has(id));

  const sourceManifestFile = path.join(PILOT_ROOT, "source-manifest.json");
  await writeFile(sourceManifestFile, JSON.stringify({
    schema: "sma/prospective-pilot-sources@1",
    createdAt: new Date().toISOString(),
    userAgent: USER_AGENT,
    sources: SOURCES.map((source) => ({
      family: source.family,
      publisher: source.publisher,
      category: source.category,
      licence: source.licence,
      licenceUrl: source.licenceUrl,
      termsUrl: source.termsUrl,
      requestedUrls: source.urls,
    })),
  }, null, 2) + "\n", "utf8");

  const acquisitionsFile = path.join(PILOT_ROOT, "acquisitions.ndjson");
  await writeFile(acquisitionsFile, acquisitions.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  const robotsFile = path.join(PILOT_ROOT, "robots-evidence.json");
  await writeFile(robotsFile, JSON.stringify(robotsEvidence, null, 2) + "\n", "utf8");
  const licenceFile = path.join(PILOT_ROOT, "licence-evidence.json");
  await writeFile(licenceFile, JSON.stringify(licenceEvidence, null, 2) + "\n", "utf8");
  const screeningFile = path.join(PILOT_ROOT, "historical-screening.ndjson");
  await writeFile(screeningFile, historicalScreening.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  const dedupFile = path.join(PILOT_ROOT, "dedup-clusters.json");
  await writeFile(dedupFile, JSON.stringify({
    policyVersion: clusters.policyVersion,
    shingleSize: clusters.shingleSize,
    threshold: clusters.threshold,
    minShingles: clusters.minShingles,
    clusters: clusters.clusters,
    nearDuplicatePairs: clusters.pairs,
  }, null, 2) + "\n", "utf8");
  const publisherManifestFile = path.join(PILOT_ROOT, "publisher-manifest.json");
  const publisherManifest = new Map();
  for (const row of tokenized) {
    const entry = publisherManifest.get(row.publisherId) ?? {
      publisherId: row.publisherId,
      families: new Set(),
      documents: 0,
      actualTokens: 0,
      tokenBudget: PUBLISHER_BUDGETS[row.sourceFamily] ?? 100_000,
      licenceUrls: new Set(),
    };
    entry.families.add(row.sourceFamily);
    entry.documents += 1;
    entry.actualTokens += row.actualTokens;
    entry.licenceUrls.add(row.licenceUrl);
    publisherManifest.set(row.publisherId, entry);
  }
  await writeFile(publisherManifestFile, JSON.stringify({
    schema: "sma/prospective-publisher-manifest@1",
    publishers: [...publisherManifest.values()].map((entry) => ({
      ...entry,
      families: [...entry.families].sort(),
      licenceUrls: [...entry.licenceUrls].sort(),
    })),
  }, null, 2) + "\n", "utf8");
  const finalActualTokens = tokenized.reduce((sum, row) => sum + row.actualTokens, 0);
  const qualityFile = path.join(PILOT_ROOT, "quality-report.json");
  await writeFile(qualityFile, JSON.stringify({
    qualityPolicyVersion: "phase2-pilot-quality-v1",
    dedupPolicyVersion: clusters.policyVersion,
    languagePolicyVersion: "english-first-v1",
    tokenizerFile: TOKENIZER,
    tokenizerSha256: sha256(await readFile(TOKENIZER)),
    fetchedDocuments: fetched.length,
    cleanedDocuments: cleaned.length,
    acceptedDocuments: tokenized.length,
    rejectedDocuments: rejected.length,
    quarantinedDocuments: quarantined.length,
    duplicateClusterRowsRejected: duplicateRejected.length,
    publisherBudgetExcluded,
    publisherBudgets: PUBLISHER_BUDGETS,
    rejected,
    quarantined,
    historicalScreening,
    duplicateRejected,
    tokenized,
    tokenEstimate: { estimatedTokens: accepted.reduce((sum, row) => sum + row.estimatedTokens, 0), actualTokens: finalActualTokens, method: "SmolLM3 tokenizer.json, add_special_tokens=false" },
    diversity,
    families: familyReport,
    split: partition ? {
      policy: partition.policyVersion,
      clusterPolicy: partition.clusterPolicyVersion,
      splitSeed: partition.splitSeed,
      splitHash: partition.splitHash,
      targetTokens: partition.targetTokens,
      trainDocuments: trainRows.length,
      validationDocuments: validationRows.length,
      trainTokens,
      validationTokens,
      validationClusters: partition.validationClusterIds.length,
      trainClusters: partition.trainClusterIds.length,
      sourceCrossings: crossingSources,
      exposure: partition.exposure,
      validationMinimumSatisfied: validationTokens >= 50_000 && partition.validationClusterIds.length >= 10,
      validationMinimum: { tokens: 50_000, clusters: 10 },
    } : { error: partitionError, validationMinimumSatisfied: false },
    historicalExclusion: {
      productionArticleStore: "/var/lib/simpleminds/data/articles (read-only)",
      productionRegistry: "/var/lib/simpleminds/data/registry (read-only)",
      historicalUrls: historicalUrls.size,
      historicalHashes: historicalHashes.size,
      historicalSnapshotIds: historicalSnapshotIds.size,
      method: "actual historical text indexed with exact/normalised hashes and 32-hash MinHash/LSH (8 bands x 4), exact Jaccard verification; no historical text copied into pilot",
    },
    counts: {
      requestedUrls: declarations.length,
      fetched: acquisitions.filter((a) => a.state === "fetched").length,
      failed: acquisitions.filter((a) => a.state === "failed").length,
      deferred: acquisitions.filter((a) => a.state === "deferred").length,
    },
  }, null, 2) + "\n", "utf8");

  const manifest = {
    schema: "sma/prospective-pilot-manifest@1",
    candidateUse: "prospective acquisition pilot only; NOT a training snapshot",
    root: PILOT_ROOT,
    createdAt: new Date().toISOString(),
    files: {
      sourceManifest: { path: sourceManifestFile, sha256: sha256(await readFile(sourceManifestFile)) },
      acquisitions: { path: acquisitionsFile, sha256: sha256(await readFile(acquisitionsFile)) },
      robotsEvidence: { path: robotsFile, sha256: sha256(await readFile(robotsFile)) },
      licenceEvidence: { path: licenceFile, sha256: sha256(await readFile(licenceFile)) },
      accepted: { path: tokenizedFile, sha256: sha256(await readFile(tokenizedFile)) },
      train: { path: trainFile, sha256: sha256(await readFile(trainFile)) },
      validation: { path: validationFile, sha256: sha256(await readFile(validationFile)) },
      splitAssignment: { path: assignmentFile, sha256: sha256(await readFile(assignmentFile)) },
      qualityReport: { path: qualityFile, sha256: sha256(await readFile(qualityFile)) },
      historicalIndex: { path: historicalIndexFile, sha256: sha256(await readFile(historicalIndexFile)), fingerprint: historicalIndexFingerprint },
      historicalScreening: { path: screeningFile, sha256: sha256(await readFile(screeningFile)) },
      dedupClusters: { path: dedupFile, sha256: sha256(await readFile(dedupFile)) },
      publisherManifest: { path: publisherManifestFile, sha256: sha256(await readFile(publisherManifestFile)) },
    },
    summary: {
      acceptedDocuments: tokenized.length,
      actualTokens: finalActualTokens,
      trainTokens,
      validationTokens,
      validationMinimumSatisfied: Boolean(partition && validationTokens >= 50_000 && partition.validationClusterIds.length >= 10),
      sourceFamilies: familyReport.length,
      publishers: diversity.distinctPublishers,
      sources: diversity.distinctSources,
      partitions: partition ? "complete" : "INSUFFICIENT_VALIDATION_OR_PARTITION_ERROR",
    },
    partitionError,
  };
  const manifestFile = path.join(PILOT_ROOT, "manifest.json");
  const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(manifestFile, manifestBytes, "utf8");

  // Independent post-write verification of every bound artifact.
  const verification = {
    schema: "sma/prospective-pilot-verification@1",
    verifiedAt: new Date().toISOString(),
    manifestFile,
    manifestSha256: sha256(manifestBytes),
    artifacts: [],
    ok: true,
  };
  for (const [name, artifact] of Object.entries(manifest.files)) {
    const actual = sha256(await readFile(artifact.path));
    const ok = actual === artifact.sha256;
    verification.artifacts.push({ name, path: artifact.path, expected: artifact.sha256, actual, ok });
    if (!ok) verification.ok = false;
  }
  const verificationFile = path.join(PILOT_ROOT, "verification.json");
  await writeFile(verificationFile, JSON.stringify(verification, null, 2) + "\n", "utf8");
  if (!verification.ok) {
    throw new Error(`artifact hash verification failed; see ${verificationFile}`);
  }

  // Freeze: no further writes to this staging directory.
  execFileSync("chmod", ["-R", "a-w", PILOT_ROOT]);

  console.log(JSON.stringify({
    ok: Boolean(partition) && verification.ok,
    root: PILOT_ROOT,
    manifest: manifestFile,
    manifestSha256: verification.manifestSha256,
    verification: verificationFile,
    summary: manifest.summary,
    partitionError,
  }, null, 2));

  await production.close();
  await registry.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
