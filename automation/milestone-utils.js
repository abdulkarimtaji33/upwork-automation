'use strict';

/** Parse hourly/fixed and budget range from Upwork jobType string. */
function parseJobPricing(jobType) {
  const s = String(jobType || '');
  const isHourly = /hourly/i.test(s);
  const isFixed = /fixed[- ]?price|fixed budget/i.test(s);
  const range = s.match(/\$([0-9.,]+)\s*[-–]\s*\$?\s*([0-9.,]+)/);
  const single = s.match(/\$([0-9.,]+[KkMm]?)/);
  return {
    budgetType: isHourly ? 'hourly' : isFixed ? 'fixed' : 'unknown',
    clientBudget: range ? `$${range[1]}–$${range[2]}` : single ? `$${single[1]}` : s.trim() || '',
    isHourly,
    isFixed,
  };
}

const MILESTONE_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    duration: { type: 'string' },
    priceType: { type: 'string', enum: ['hourly', 'fixed'] },
    quotedPrice: { type: 'string' },
  },
  required: ['title', 'description', 'duration', 'priceType', 'quotedPrice'],
  additionalProperties: false,
};

const MILESTONES_ONLY_SCHEMA = {
  type: 'object',
  properties: {
    budgetType: { type: 'string', enum: ['hourly', 'fixed', 'unknown'] },
    clientBudget: { type: 'string' },
    quotedTotal: { type: 'string' },
    milestones: {
      type: 'array',
      items: MILESTONE_ITEM_SCHEMA,
    },
  },
  required: ['budgetType', 'clientBudget', 'quotedTotal', 'milestones'],
  additionalProperties: false,
};

const MILESTONE_PRICES_ONLY_SCHEMA = {
  type: 'object',
  properties: {
    quotedTotal: { type: 'string' },
    milestones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          priceType: { type: 'string', enum: ['hourly', 'fixed'] },
          quotedPrice: { type: 'string' },
        },
        required: ['priceType', 'quotedPrice'],
        additionalProperties: false,
      },
    },
  },
  required: ['quotedTotal', 'milestones'],
  additionalProperties: false,
};

function milestonePricingPrompt(job) {
  const pricing = parseJobPricing(job.jobType);
  const budgetType = pricing.budgetType;
  const clientBudget = pricing.clientBudget || job.jobType || 'Not specified';

  return `
Job pricing context:
- Budget type: ${budgetType} (${budgetType === 'hourly' ? 'quote hourly rates' : budgetType === 'fixed' ? 'quote fixed $ amounts per milestone' : 'infer hourly vs fixed from description'})
- Client budget/rate on posting: ${clientBudget}
- Location: ${job.clientLocation || 'Unknown'}
- Duration estimate: ${job.duration || 'Unknown'}

Pricing rules:
- If hourly: each milestone quotedPrice must be like "$35/hr" (competitive vs client range). quotedTotal = estimated overall e.g. "$1,400 (~40 hrs @ $35/hr)".
- If fixed-price: each milestone quotedPrice is a fixed dollar amount e.g. "$800". Milestone amounts should sum close to quotedTotal and stay within client budget when known.
- priceType on each milestone must be "hourly" or "fixed" matching the job.
- Be realistic for scope and ${job.experienceLevel || 'intermediate'} level.`;
}

function mergeMilestonePrices(existing, priced) {
  return existing.map((m, i) => ({
    ...m,
    priceType: priced[i]?.priceType || m.priceType,
    quotedPrice: priced[i]?.quotedPrice || m.quotedPrice,
  }));
}

function formatPriceBadge(job) {
  const p = parseJobPricing(job.jobType);
  if (p.clientBudget) return p.clientBudget;
  if (job.clientBudget) return job.clientBudget;
  return '';
}

module.exports = {
  parseJobPricing,
  MILESTONE_ITEM_SCHEMA,
  MILESTONES_ONLY_SCHEMA,
  MILESTONE_PRICES_ONLY_SCHEMA,
  milestonePricingPrompt,
  mergeMilestonePrices,
  formatPriceBadge,
};
