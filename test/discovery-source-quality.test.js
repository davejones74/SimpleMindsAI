import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyUrlQuality, classifyUrlQualityWithMode } from "../src/discovery/source-quality.js";
import { createDiscoveryPolicy } from "../src/discovery/discovery-policy.js";

test("low-value URL shapes are classified with explicit reasons", () => {
  const cases = [
    ["https://en.wikipedia.org/wiki/File:Example.jpg", "wiki-namespace:file"],
    ["https://en.wikipedia.org/wiki/Category:Physics", "wiki-namespace:category"],
    ["https://en.wikipedia.org/wiki/Special:Search", "wiki-namespace:special"],
    ["https://en.wikipedia.org/wiki/Template:Infobox", "wiki-namespace:template"],
    ["https://example.com/photo.webp", "non-content-extension"],
    ["https://example.com/login", "non-article-path"],
    ["mailto:someone@example.com", "non-http-scheme"],
    ["https://donate.wikimedia.org/x", "non-content-host"],
  ];
  for (const [url, reason] of cases) {
    const result = classifyUrlQuality(url);
    assert.equal(result.action, "reject", url);
    assert.equal(result.reason, reason, url);
  }
});

test("real article URLs are not filtered", () => {
  for (const url of [
    "https://en.wikipedia.org/wiki/Steam_engine",
    "https://science.nasa.gov/mission/webb/",
    "https://example.com/articles/a-real-article",
  ]) {
    assert.equal(classifyUrlQuality(url).action, "allow", url);
  }
});

test("shadow mode records would-be rejections without blocking", () => {
  const shadow = classifyUrlQualityWithMode("https://en.wikipedia.org/wiki/File:X.jpg", "shadow");
  assert.equal(shadow.action, "allow");
  assert.equal(shadow.shadowRejected, true);
  const off = classifyUrlQualityWithMode("https://en.wikipedia.org/wiki/File:X.jpg", "off");
  assert.equal(off.action, "allow");
  assert.equal(off.shadowRejected, false);
});

test("discovery policy rejects low-value URLs even on a seed host", () => {
  const policy = createDiscoveryPolicy({
    seedUrls: ["https://en.wikipedia.org/wiki/Steam_engine"],
    mode: "seeds-only",
    urlQuality: "enforce",
  });
  assert.equal(policy.decide("https://en.wikipedia.org/wiki/Steam_engine").allowed, true);
  const file = policy.decide("https://en.wikipedia.org/wiki/File:X.jpg");
  assert.equal(file.allowed, false);
  assert.equal(file.reason, "wiki-namespace:file");
});
