# Source Expansion Inventory v2 — Summary Report

**Inventory version:** 2.0.0  
**Generated:** 2026-11-02T00:00:00Z  
**Status:** Inventory development only. No acquisition, training, production write, promotion, job, timer or corpus change was performed.

## 1. Executive summary

The expanded inventory contains **45 candidate sources**. Of these, **37** are in the unrestricted pool, drawn from **35 independent publisher groups** and **37 source families**. A further **3** are share-alike sources and **5** are non-commercial/restricted sources. It also records **19 excluded or deferred candidates** with reasons.

After fetch, quality, deduplication, v1-overlap and cross-source-overlap allowances, and after an explicit uncertainty factor, the unrestricted pool has a **conservative novel-token capacity of 40.22M** (gross 94.31M). The recommended planned draw is **19.05M conservative novel tokens** from about **4,903 candidate URLs**. Both figures exceed the **7.75M** target and the policy's **35% headroom floor** (10.46M).

**Recommendation:** the 7.75M target is **feasible on inventory evidence**, with substantial capacity headroom. It is **not yet measured**. The next step should be a separately authorised, bounded acquisition pilot that measures real yield, v1 overlap, cross-source duplication, licence compliance and robots/terms for this expanded source set. This work package does not authorise acquisition or training.

## 2. Baseline and prior pilot

| Baseline | Documents | Cleaned tokens | Publishers | Source families |
| --- | --- | --- | --- | --- |
| Frozen v1 (prospective-rebalanced) | 128 | 914,005 | 14 | 12 |
| Pilot v2 (100-doc acquisition) | 100 | 476,081 | 13 | 11 |

Pilot v2 found **92/100** documents overlapping frozen v1, leaving only **8 novel documents** and **113,254 novel tokens** (23.8%). This is why the expanded inventory explicitly records v1 overlap and cross-source overlap instead of treating new URLs as novel.

Frozen v1 identity: manifest `44fd36ae0ddb1378023e26c299dd16f6d74d9d3d1162e44462e47c863fde6e35`; train `552ffad836b9b95f6609c4062531bd2883a5f1f7a7e9833366bdd54d7a68b446`; validation `95aa6f130a73b0516253f52fd3572da853598ea8285e259a79a5d84418f176ae`.  
Pilot v2 identity: manifest `e08543dd2a3d441f0af68606d32222f506d34fc8ab9310647dcf592616816a98`; screening `b3c982ef3b3163e9f890046189b3c5e231967baa49335835796536a3f1565a8d`.

## 3. Inventory overview

| Pool | Sources | Publishers | Families | Capacity docs | Planned docs | Gross capacity | Conservative novel capacity | Conservative planned novel |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| unrestricted | 37 | 35 | 37 | 9,976 | 4,903 | 94.31M | 40.22M | 19.05M |
| share-alike | 3 | 2 | 3 | 2,200 | 1,100 | 9.70M | 3.66M | 1.83M |
| non-commercial | 5 | 5 | 5 | 2,600 | 0 | 11.10M | 3.01M | 0.00M |

Only the **unrestricted** pool counts toward the 7.75M target. Share-alike and non-commercial sources are reported separately and are not used to satisfy the target.

## 4. Capacity waterfall (unrestricted pool)

| Stage | Capacity draw | Planned draw |
| --- | --- | --- |
| Gross cleaned-token estimate | 94,310,000 | 44,830,000 |
| After fetch-success allowance | 88,867,500 | 42,217,000 |
| After quality acceptance | 80,035,743 | 37,959,144 |
| After duplicate removal | 74,581,997 | 35,362,533 |
| After v1 and cross-source novelty | 68,052,174 | 32,342,127 |
| Conservative (uncertainty factor) | 40,221,444 | 19,051,548 |

The difference between capacity and planned draw is deliberate headroom. The inventory can supply more than the recommended draw; the draw is capped for composition, cost and review reasons.

## 5. Licence breakdown (unrestricted pool)

| Licence | SPDX | Planned novel tokens | Share | Commercial use | Non-commercial |
| --- | --- | --- | --- | --- | --- |
| CC-BY-4.0 | CC-BY-4.0 | 6,842,630 | 35.9% | allowed | no |
| US-Gov-Work | LicenseRef-US-Gov-Work | 2,234,686 | 11.7% | allowed | no |
| OAPEN-CC-BY | CC-BY-4.0 | 1,752,152 | 9.2% | allowed | no |
| World-Bank-CC-BY | CC-BY-4.0 | 1,717,909 | 9.0% | allowed | no |
| Gutenberg-PD-US | LicenseRef-PublicDomain-US | 1,506,620 | 7.9% | allowed | no |
| StandardEbooks-CC0 | CC0-1.0 | 1,149,205 | 6.0% | allowed | no |
| OECD-CC-BY-4.0 | CC-BY-4.0 | 954,324 | 5.0% | allowed | no |
| EU-CC-BY-4.0 | CC-BY-4.0 | 558,137 | 2.9% | allowed | no |
| OSTI-Gov-Work | LicenseRef-OSTI-Gov-Work | 497,446 | 2.6% | allowed | no |
| NIST-Gov-Work | LicenseRef-NIST-Gov-Work | 438,100 | 2.3% | allowed | no |
| OGL-3.0 | OGL-3.0 | 338,370 | 1.8% | allowed | no |
| PSF-2.0 | PSF-2.0 | 288,686 | 1.5% | allowed | no |
| NASA-Gov-Work | LicenseRef-NASA-Gov-Work | 273,160 | 1.4% | allowed | no |
| PostgreSQL | PostgreSQL | 186,333 | 1.0% | allowed | no |
| MIT | MIT | 156,895 | 0.8% | allowed | no |
| BSD-3-Clause | BSD-3-Clause | 156,895 | 0.8% | allowed | no |

All unrestricted entries are commercial-use allowed, non-share-alike, non-non-commercial and non-no-derivatives. Share-alike and non-commercial entries are in separate pools. Licence evidence is recorded in `licence-register.json`; this is not legal clearance.

## 6. Composition and diversity (planned draw)

### 6.1 Subject distribution

| Subject | Conservative novel tokens | Share |
| --- | --- | --- |
| economics-social-political | 3,351,483 | 17.6% |
| humanities-philosophy-literature | 2,519,502 | 13.2% |
| physics-chemistry-biology | 2,409,891 | 12.6% |
| medicine-public-health | 2,302,743 | 12.1% |
| geography-earth-environmental | 2,219,165 | 11.6% |
| mathematics-formal-sciences | 1,528,382 | 8.0% |
| computer-science-software | 1,330,737 | 7.0% |
| general-reference-education | 1,140,622 | 6.0% |
| history-historical-reference | 1,129,008 | 5.9% |
| engineering-applied-sciences | 1,120,016 | 5.9% |

The planned draw covers all ten requested subject areas. The thinnest area is engineering/applied sciences; the strongest are economics/social/political, humanities, physics/chemistry/biology, medicine/public health and geography/earth/environment.

### 6.2 Publisher-group distribution

| Publisher group | Conservative novel tokens | Share |
| --- | --- | --- |
| oapen.org | 1,752,152 | 9.2% |
| worldbank.org | 1,717,909 | 9.0% |
| gutenberg.org | 1,506,620 | 7.9% |
| arxiv.org | 1,403,758 | 7.4% |
| standardebooks.org | 1,149,205 | 6.0% |
| open-logic-project | 1,086,130 | 5.7% |
| usgs.gov | 956,351 | 5.0% |
| oecd.org | 954,324 | 5.0% |
| plos.org | 951,600 | 5.0% |
| elifesciences.org | 761,533 | 4.0% |
| noaa.gov | 577,279 | 3.0% |
| european-union | 558,137 | 2.9% |
| copernicus.org | 514,303 | 2.7% |
| osti.gov | 497,446 | 2.6% |
| frontiersin.org | 457,896 | 2.4% |

### 6.3 Source-family distribution

| Source family | Conservative novel tokens | Share |
| --- | --- | --- |
| oapen-ccby | 1,752,152 | 9.2% |
| world-bank-okr | 1,717,909 | 9.0% |
| project-gutenberg | 1,506,620 | 7.9% |
| arxiv-ccby | 1,403,758 | 7.4% |
| standard-ebooks | 1,149,205 | 6.0% |
| usgs | 956,351 | 5.0% |
| oecd | 954,324 | 5.0% |
| plos | 951,600 | 5.0% |
| open-logic-project | 828,224 | 4.3% |
| elife | 761,533 | 4.0% |
| noaa | 577,279 | 3.0% |
| eu-eurlex-op | 558,137 | 2.9% |
| copernicus-ccby | 514,303 | 2.7% |
| doe-osti-govwork | 497,446 | 2.6% |
| bmc-springeropen-ccby | 457,896 | 2.4% |

### 6.4 Document-format distribution

| Format | Conservative novel tokens | Share |
| --- | --- | --- |
| report | 6,149,965 | 32.3% |
| book | 5,494,107 | 28.8% |
| article | 5,369,434 | 28.2% |
| documentation | 1,036,136 | 5.4% |
| web | 840,795 | 4.4% |
| reference | 161,111 | 0.8% |

### 6.5 Governance-group distribution

| Governance group | Conservative novel tokens | Share |
| --- | --- | --- |
| independent | 14,287,371 | 75.0% |
| us-federal | 3,867,670 | 20.3% |
| eu | 558,137 | 2.9% |
| uk-government | 338,370 | 1.8% |

### 6.6 Concentration metrics

| Dimension | Distinct | Top-1 share | Top-5 share | Top-10 share | Herfindahl |
| --- | --- | --- | --- | --- | --- |
| Publisher | 37 | 9.2% | 39.5% | 62.9% | 0.0500 |
| Publisher group | 35 | 9.2% | 39.5% | 64.2% | 0.0514 |
| Source family | 37 | 9.2% | 39.5% | 62.9% | 0.0500 |
| Subject | 10 | 17.6% | 67.2% | 100.0% | 0.1145 |
| Format | 6 | 32.3% | 99.2% | 100.0% | 0.2718 |
| Governance group | 4 | 75.0% | 100.0% | 100.0% | 0.6048 |

Publisher diversity is not the same as source-family diversity. Related publishers (for example Wikimedia projects, Open Logic Project/forall x, NIST/NIST DLMF, and OAPEN as a host) are grouped so that mirrors, subsidiaries and closely related repositories do not inflate the independent-publisher count. Aggregators such as OAPEN and PMC are treated as one publisher group; their underlying publisher diversity must be measured from item metadata during acquisition. In the governance table, 'independent' is a residual category, not a single publisher; the policy cap applies to the largest actual government group (US federal, currently 20.3%).

### 6.7 Candidate URL allocation

Candidate URL counts below are document counts allocated across subject shares. They are planning estimates, not enumerated URLs. The inventory records a URL-generation rule and example URLs for every source; the full machine-readable allocation is in `candidate-urls.json`.

**By publisher group (top 15)**

| Publisher group | Planned candidate URLs | Capacity candidate URLs | Planned novel tokens |
| --- | --- | --- | --- |
| oapen.org | 90 | 200 | 1,752,152 |
| worldbank.org | 150 | 300 | 1,717,909 |
| gutenberg.org | 60 | 150 | 1,506,620 |
| arxiv.org | 350 | 800 | 1,403,758 |
| standardebooks.org | 40 | 100 | 1,149,205 |
| open-logic-project | 31 | 62 | 1,086,130 |
| usgs.gov | 180 | 360 | 956,351 |
| oecd.org | 120 | 240 | 954,324 |
| plos.org | 300 | 600 | 951,600 |
| elifesciences.org | 180 | 360 | 761,533 |
| noaa.gov | 150 | 300 | 577,279 |
| european-union | 120 | 240 | 558,138 |
| copernicus.org | 150 | 300 | 514,303 |
| osti.gov | 120 | 240 | 497,446 |
| frontiersin.org | 180 | 360 | 457,896 |

**By subject**

| Subject | Planned candidate URLs | Capacity candidate URLs | Planned novel tokens |
| --- | --- | --- | --- |
| economics-social-political | 629 | 1,264 | 3,351,484 |
| humanities-philosophy-literature | 102 | 241 | 2,519,502 |
| physics-chemistry-biology | 880 | 1,795 | 2,409,890 |
| medicine-public-health | 1,106 | 2,212 | 2,302,745 |
| geography-earth-environmental | 627 | 1,253 | 2,219,165 |
| mathematics-formal-sciences | 156 | 344 | 1,528,381 |
| computer-science-software | 776 | 1,572 | 1,330,737 |
| general-reference-education | 117 | 245 | 1,140,623 |
| history-historical-reference | 134 | 282 | 1,129,008 |
| engineering-applied-sciences | 377 | 769 | 1,120,016 |

**Example candidate URLs for the largest planned sources**

| Source | Publisher group | Planned docs | Example URL |
| --- | --- | --- | --- |
| oapen-ccby | oapen.org | 90 | https://library.oapen.org/ |
| world-bank-okr | worldbank.org | 150 | https://openknowledge.worldbank.org/ |
| project-gutenberg | gutenberg.org | 60 | https://www.gutenberg.org/cache/epub/11/pg11.txt |
| arxiv-ccby | arxiv.org | 350 | https://arxiv.org/abs/2301.00001 |
| standard-ebooks | standardebooks.org | 40 | https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice |
| usgs | usgs.gov | 180 | https://pubs.usgs.gov/ |
| oecd | oecd.org | 120 | https://www.oecd.org/en/publications.html |
| plos | plos.org | 300 | https://journals.plos.org/plosone/ |

## 7. Top planned sources

| Source | Publisher group | Format | Planned docs | Conservative planned novel | Publisher-group share |
| --- | --- | --- | --- | --- | --- |
| oapen-ccby | oapen.org | book | 90 | 1.75M | 9.2% |
| world-bank-okr | worldbank.org | report | 150 | 1.72M | 9.0% |
| project-gutenberg | gutenberg.org | book | 60 | 1.51M | 7.9% |
| arxiv-ccby | arxiv.org | article | 350 | 1.40M | 7.4% |
| standard-ebooks | standardebooks.org | book | 40 | 1.15M | 6.0% |
| usgs | usgs.gov | report | 180 | 0.96M | 5.0% |
| oecd | oecd.org | report | 120 | 0.95M | 5.0% |
| plos | plos.org | article | 300 | 0.95M | 5.0% |
| open-logic-project | open-logic-project | book | 25 | 0.83M | 5.7% |
| elife | elifesciences.org | article | 180 | 0.76M | 4.0% |
| noaa | noaa.gov | report | 150 | 0.58M | 3.0% |
| eu-eurlex-op | european-union | report | 120 | 0.56M | 2.9% |
| copernicus-ccby | copernicus.org | article | 150 | 0.51M | 2.7% |
| doe-osti-govwork | osti.gov | report | 120 | 0.50M | 2.6% |
| frontiers | frontiersin.org | article | 180 | 0.46M | 2.4% |
| bmc-springeropen-ccby | springer-nature | article | 180 | 0.46M | 2.4% |
| pmc-oa-ccby | nih-pmc | article | 400 | 0.42M | 2.2% |
| mdpi-ccby | mdpi.com | article | 180 | 0.40M | 2.1% |
| uk-govuk | gov.uk | report | 180 | 0.34M | 1.8% |
| python-docs | python-software-foundation | documentation | 120 | 0.29M | 1.5% |

## 8. V1 overlap and cross-source overlap

Known frozen-v1 overlap is recorded per source in `source-inventory.json`. The main known overlaps are:

- Project Gutenberg: 2 v1 books; exclude those book IDs and titles duplicated by Standard Ebooks.
- Wikipedia: 16 v1 articles; exclude them.
- Python documentation: 24 v1 pages; exclude them.
- OpenStax: 41 v1 pages; current OpenStax is restricted (CC BY-NC-SA) and is not in the unrestricted target.
- US government agencies: small numbers of v1 pages in NASA, NIST, Census, EPA and GOV.UK; exclude those URLs.
- MIT OCW/LibreTexts: v1 pages; MIT OCW is non-commercial; LibreTexts is excluded as ambiguous.

Cross-source overlaps are modelled explicitly. The largest is PMC versus publisher-specific sources (cross-source overlap 0.55), followed by Standard Ebooks versus Project Gutenberg (0.15), OAPEN within-source (0.10), and Gutenberg boilerplate/edition overlap (0.15). These are planning discounts, not measured overlaps. They must be replaced by measured DOI/title/content overlap in the next acquisition pilot.

## 9. Exclusions and uncertainties

### 9.1 Excluded or deferred candidates

| Candidate | Status | Reason |
| --- | --- | --- |
| LibreTexts | excluded | Content-level Creative Commons licences vary by page and book; prior pilot could not establish a uniform reuse basis. |
| Open Textbook Library | excluded | Per-book licences vary, including CC BY, CC BY-SA, CC BY-NC and all-rights-reserved. No safe bulk basis without item-level verification. |
| DOAB | excluded-as-content-source | DOAB is a discovery directory, not a content host; it points to OAPEN and other platforms. Only metadata is CC0. |
| CORE / OpenAIRE | excluded | Aggregators with per-record licences and mixed full-text availability; provenance and licence can be ambiguous. |
| Internet Archive | excluded | Mixed rights, lending restrictions and unclear public-domain status for many items. |
| HathiTrust | excluded | Public-domain determination is possible but access controls and bulk-use terms are restrictive. |
| Google Books | excluded | Predominantly in-copyright; bulk text not openly licensed. |
| Stack Overflow / Stack Exchange | excluded | CC BY-SA content but fragmented Q&A, code-heavy, and not coherent educational documents; share-alike plus quality concerns. |
| Common Crawl / FineWeb / C4-style web corpora | excluded | Per-document licensing and provenance are unclear; unknown v1 overlap; licence filtering cannot be guaranteed at document level. |
| arXiv non-CC-BY records | excluded-subset | Most arXiv records use the arXiv perpetual licence or other terms that do not clearly permit commercial reuse; only the CC BY 4.0 subset is approved. |
| PMC non-CC-BY records | excluded-subset | PMC OA includes CC BY-NC and CC BY-NC-ND content; only CC BY 4.0 records are approved. |
| OSTI copyrighted journal articles / unmarked documents | excluded-subset | OSTI hosts copyrighted articles and unmarked works; only explicit U.S. Government Work reports are approved. |
| NASA/NIST third-party images, insignia and co-authored journal articles | excluded-subset | These components are not U.S. Government works or are subject to third-party rights; text-only, gov-work filtering is required. |
| International Monetary Fund (IMF) publications | excluded | Terms vary and many publications are not openly licensed for commercial reuse. |
| UNESCO publications | deferred-share-alike | Many UNESCO works use CC BY-SA IGO, which is share-alike; not included in the unrestricted target. |
| OECD pre-1 July 2024 third-party material and items with restrictive notices | excluded-subset | OECD terms changed in 2024 and some items contain third-party or restricted material; only CC BY 4.0 or equivalent items are approved. |
| World Bank CC BY-NC / CC BY-NC-ND items | excluded-subset | A subset of OKR content is non-commercial or no-derivatives; only CC BY items are approved. |
| EU documents with third-party rights, personal data or restrictive notices | excluded-subset | EU reuse policy excludes certain third-party and personal-data content; per-item rights check required. |
| Crown copyright material not covered by OGL | excluded-subset | GOV.UK content is not uniformly OGL; only OGL-marked content is approved. |

### 9.2 Outstanding uncertainties

| ID | Topic | Action |
| --- | --- | --- |
| U1 | Legal characterisation of model training | Obtain legal review before using share-alike or non-commercial material. |
| U2 | Non-commercial scope | Keep out of the unrestricted pool; seek permission or a commercial-use licence if needed. |
| U3 | Licence changes over time | Re-verify licences immediately before acquisition and freeze evidence hashes. |
| U4 | Third-party content inside government and institutional publications | Text-only extraction; exclude third-party material; item-level rights review before acquisition. |
| U5 | Cross-source duplication | Measure DOI/title overlap in a bounded acquisition pilot before final composition. |
| U6 | Token-yield uncertainty | Run a bounded acquisition pilot and measure actual cleaned-token yield per source. |
| U7 | Language filtering | Apply the production language policy and record rejection rates. |
| U8 | Robots, rate limits and access terms | Complete robots/terms review per source before acquisition; honour rate limits and required user agents. |
| U9 | Near-duplicate detection at scale | Retain lexical dedup plus manual/semantic review for high-risk families. |
| U10 | V1 overlap estimates | Run full v1 exact/normalised/MinHash screening during the separately authorised acquisition pilot. |
| U11 | Publisher concentration of aggregators | Extract underlying publisher metadata during acquisition and re-run concentration analysis. |
| U12 | Licence evidence freshness | Freeze licence-page evidence hashes immediately before acquisition; obtain legal review for flagged items. |

The full uncertainty register is in `source-inventory.json`.

## 10. Comparison with the previous 100-document pilot

| Measure | Pilot v2 | This inventory (planned draw) | This inventory (capacity) |
| --- | --- | --- | --- |
| Documents | 100 | 4,903 | 9,976 |
| Gross cleaned tokens | 476,081 | 44,830,000 | 94,310,000 |
| Novel tokens relative to v1 | 113,254 | 19,051,548 | 40,221,444 |
| Publishers / groups | 13 | 35 | 35 |
| Source families | 11 | 37 | 37 |

The pilot's novel yield was about **14,157 novel tokens per novel document**. The expanded inventory plans for **3,886 conservative novel tokens per planned URL**, because it deliberately includes more long-form books, reports and reference works. This is a planning estimate, not a measured yield.

## 11. Validation checks

| Check | Result | Detail |
| --- | --- | --- |
| capacity-exceeds-target | PASS | 40221444 >= 7750000 |
| capacity-headroom | PASS | 40221444 >= 10462500 |
| planned-exceeds-target | PASS | 19051548 >= 7750000 |
| planned-headroom | PASS | 19051548 >= 10462500 |
| max-publisher-share | PASS | 0.09196901 <= 0.15 |
| max-publisher-group-share | PASS | 0.09196901 <= 0.18 |
| max-source-family-share | PASS | 0.09196901 <= 0.15 |
| max-subject-share | PASS | 0.17591657 <= 0.3 |
| max-format-share | PASS | 0.32280658 <= 0.35 |
| max-us-federal-share | PASS | 0.2030108 <= 0.35 |
| subject-min:mathematics-formal-sciences | PASS | 0.08022349 >= 0.05 |
| subject-min:physics-chemistry-biology | PASS | 0.12649316 >= 0.05 |
| subject-min:computer-science-software | PASS | 0.06984929 >= 0.05 |
| subject-min:engineering-applied-sciences | PASS | 0.0587887 >= 0.05 |
| subject-min:medicine-public-health | PASS | 0.12086907 >= 0.05 |
| subject-min:history-historical-reference | PASS | 0.05926071 >= 0.05 |
| subject-min:humanities-philosophy-literature | PASS | 0.13224656 >= 0.05 |
| subject-min:geography-earth-environmental | PASS | 0.11648213 >= 0.05 |
| subject-min:economics-social-political | PASS | 0.17591659 >= 0.05 |
| subject-min:general-reference-education | PASS | 0.0598703 >= 0.05 |
| min-publishers | PASS | 35 >= 20 |
| min-source-families | PASS | 37 >= 25 |
| min-subject-categories | PASS | 10 >= 10 |
| no-restricted-in-target | PASS | all unrestricted sources are commercial-use allowed, non-SA, non-NC, non-ND |

## 12. Remaining gaps and recommendations

**Gaps**

1. **Measured yield is absent.** Token estimates use pilot measurements for some sources and conservative document-length assumptions for others. They must be replaced by measured cleaned-token yield.
2. **Cross-source duplication is estimated, not measured.** PMC/publisher overlap and Gutenberg/Standard Ebooks overlap need DOI/title/content measurement.
3. **V1 overlap is source/title-level for most families.** Full-text exact, normalised and MinHash screening is required before accepting documents.
4. **Engineering/applied sciences is the thinnest subject area** (near the 5% floor). If the next pilot shows weak yield from NASA/NIST/OSTI/MDPI, engineering could fall below the floor.
5. **Humanities/history depend heavily on public-domain books.** This is legitimate but creates a format and style concentration; OAPEN and open-book sources need measured yield to diversify it.
6. **Medicine/public health relies on journal publishers with material PMC overlap.** The cross-source discount is conservative but unmeasured.
7. **Licence and legal review remain incomplete.** Share-alike and non-commercial material is separated, but whether training/weights trigger those obligations requires legal advice.
8. **Access terms and robots are not yet checked at acquisition scale.** Some sources require APIs, OAI-PMH, rate limits or prior permission.
9. **Licence terms can change.** OpenStax's 2026 move to CC BY-NC-SA is a concrete example; every source must be re-verified immediately before acquisition.
10. **Underlying publisher diversity of OAPEN and PMC is not yet counted.** The current concentration metrics use the distributor as the publisher group; item-level metadata must be used in the next stage.

**Recommendations**

1. **Do not run the full 7.75M acquisition under this work package.** It is inventory development only.
2. **Authorise a separate, bounded acquisition pilot** of roughly 1.5-2.5M gross tokens (or about 500-800 accepted documents) drawn across the new families, with per-publisher caps and full v1/cross-source screening. Measure actual yield, rejection, duplication, language and licence/robots compliance.
3. **Prioritise the new unrestricted families that are least represented in v1:** arXiv CC BY, PLOS/eLife/PMC CC BY, World Bank, OECD, OWASP-like technical documentation (Python/Rust/Go/PostgreSQL/Kubernetes), OAPEN CC BY, USGS/NOAA, and Standard Ebooks.
4. **Keep OpenStax, MIT OCW, Khan Academy, WHO and FAO out of the unrestricted pool** unless non-commercial suitability is explicitly established or permission is obtained.
5. **Run legal review on share-alike and non-commercial obligations** before including those pools. Do not treat public accessibility as reuse permission.
6. **Re-run this inventory build after the pilot** with measured yield and overlap, then freeze the composition for a separately authorised training experiment.

## 13. Reproduction and hashes

Build and validate:

```bash
node scripts/build-source-inventory.mjs
node scripts/build-source-inventory.mjs --check
node --test test/source-inventory.test.js
```

The build reads only the versioned source data under `inventory/source-expansion-v2/data/`, performs no network access, and writes the inventory, derived metrics, licence register, exclusions, policy, this report and `manifest.json`. The manifest records SHA-256 hashes for the inventory, its supporting manifests, the build script and the test. Verify with `--check`.

**No acquisition, crawl, training, evaluation, promotion, production write, job/timer/service change, or frozen-corpus change occurred in producing this inventory.**
