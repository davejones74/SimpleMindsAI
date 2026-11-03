export const A = (method, rule, examples, options = {}) => ({
  method,
  urlGenerationRule: rule,
  exampleUrls: examples,
  requiresAccount: Boolean(options.account),
  requiresPayment: Boolean(options.payment),
  requiresTermsAcceptance: Boolean(options.terms),
  robotsReview: options.robots ?? "required-before-acquisition",
});

export const V1 = (knownDocuments, knownSourceIds, method, limitations) => ({
  knownDocuments,
  knownSourceIds,
  method,
  limitations,
});

export const src = (value) => ({
  ...value,
  subjects: Object.keys(value.subjectShares).sort(),
});
