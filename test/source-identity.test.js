import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalSourceUrl,
  originalSourceUrl,
  sourcePublisher,
  captureIdentity,
  isArchiveCapture,
} from "../src/dataset/source-identity.js";

test("archive captures resolve to the underlying original source identity", () => {
  const archive = "https://web.archive.org/web/20171016050101/https://www.example.org/lecture/ecosystem";
  assert.equal(originalSourceUrl(archive), "https://www.example.org/lecture/ecosystem");
  assert.equal(canonicalSourceUrl(archive), "https://example.org/lecture/ecosystem");
  assert.equal(sourcePublisher(archive), "example.org");
  assert.equal(isArchiveCapture(archive), true);
});

test("two captures of the same original share canonical identity but not capture identity", () => {
  const a = { articleId: "a", sourceUrl: "https://web.archive.org/web/20120101000000/https://example.org/page", fetchedContentHash: "h1" };
  const b = { articleId: "b", sourceUrl: "https://web.archive.org/web/20200101000000/https://example.org/page", fetchedContentHash: "h2" };
  assert.equal(canonicalSourceUrl(a), canonicalSourceUrl(b));
  assert.notEqual(captureIdentity(a), captureIdentity(b));
});

test("ordinary URLs remain their own canonical source", () => {
  assert.equal(canonicalSourceUrl("https://www.example.org/a/?utm_source=x"), "https://example.org/a");
  assert.equal(originalSourceUrl("https://www.example.org/a/"), "https://www.example.org/a/");
  assert.equal(sourcePublisher("https://www.example.org/a/"), "example.org");
  assert.equal(isArchiveCapture("https://www.example.org/a/"), false);
});

test("publisher identity collapses NASA subdomains but keeps independent registrable domains", async () => {
  const { publisherIdentity, registrableDomain } = await import("../src/dataset/source-identity.js");
  assert.equal(registrableDomain("science.nasa.gov"), "nasa.gov");
  assert.equal(registrableDomain("www.nasa.gov"), "nasa.gov");
  assert.equal(registrableDomain("www.bbc.co.uk"), "bbc.co.uk");
  assert.equal(registrableDomain("sub.example.com"), "example.com");
  assert.notEqual(publisherIdentity("https://science.nasa.gov/a").publisherDomain, publisherIdentity("https://www.wired.com/a").publisherDomain);
});
