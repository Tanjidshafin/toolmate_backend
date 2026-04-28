/**
 * Job Pass pricing config — single source of truth.
 *
 * The shape lives in the existing `Promos` collection so admins can change
 * launch / standard prices, toggle promos, swap Stripe price IDs, and disable
 * a payment provider without redeploying. The default provider can also be
 * flipped (e.g. when we want to A/B Stripe-vs-PayPal as the primary CTA).
 *
 * Amount fields are stored in minor units (cents) to match Stripe and avoid
 * floating-point drift. Any currency conversion or display formatting happens
 * at the edge.
 */

const DEFAULT_OFFER_KEY = 'job_pass_default';

const DEFAULT_PRICING_CONFIG = {
  offerKey: DEFAULT_OFFER_KEY,
  isActive: true,
  enabledProviders: ['stripe', 'paypal'],
  defaultProvider: 'stripe',
  single: {
    launchAmount: 499,
    standardAmount: 999,
    currency: 'AUD',
    promoLabel: 'Launch price',
    promoBadgeLabel: 'Limited time',
    discountLabel: '',
    showStandardPrice: true,
    promoActive: true,
    description: '1 Job Pass — saves one DIY job inside Job Tab',
    providers: {
      stripe: {
        priceIdLaunch: process.env.STRIPE_PRICE_ID_JOB_PASS_SINGLE_LAUNCH || '',
        priceIdStandard: process.env.STRIPE_PRICE_ID_JOB_PASS_SINGLE_STANDARD || '',
      },
      paypal: {
        skuLaunch: 'JOBPASS_SINGLE_LAUNCH',
        skuStandard: 'JOBPASS_SINGLE_STD',
      },
    },
  },
  pack3: {
    launchAmount: 1200,
    standardAmount: 2499,
    currency: 'AUD',
    promoLabel: 'Launch price',
    promoBadgeLabel: 'Limited time',
    discountLabel: 'Save 50%',
    showStandardPrice: true,
    promoActive: true,
    description: '3 Job Passes — save up to 3 DIY jobs',
    providers: {
      stripe: {
        priceIdLaunch: process.env.STRIPE_PRICE_ID_JOB_PASS_3PACK_LAUNCH || '',
        priceIdStandard: process.env.STRIPE_PRICE_ID_JOB_PASS_3PACK_STANDARD || '',
      },
      paypal: {
        skuLaunch: 'JOBPASS_3PACK_LAUNCH',
        skuStandard: 'JOBPASS_3PACK_STD',
      },
    },
  },
};

const cloneDefault = () => JSON.parse(JSON.stringify(DEFAULT_PRICING_CONFIG));

const IMMUTABLE_TOP_LEVEL_FIELDS = new Set(['_id', 'createdAt', 'offerKey']);

const omitImmutableTopLevelFields = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !IMMUTABLE_TOP_LEVEL_FIELDS.has(key)),
  );
};

const ensurePricingConfigSeeded = async (promoStorage) => {
  if (!promoStorage) return null;
  const existing = await promoStorage.findOne({ offerKey: DEFAULT_OFFER_KEY });
  if (existing) return existing;
  const seed = {
    ...cloneDefault(),
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedBy: 'system-seed',
  };
  await promoStorage.insertOne(seed);
  console.log(`Seeded default Job Pass pricing config (offerKey=${DEFAULT_OFFER_KEY}).`);
  return seed;
};

const getPricingConfig = async (promoStorage) => {
  if (!promoStorage) return cloneDefault();
  const doc = await promoStorage.findOne({ offerKey: DEFAULT_OFFER_KEY });
  if (!doc) {
    return cloneDefault();
  }
  return doc;
};

const isProviderEnabled = (config, provider) => {
  if (!config) return false;
  const enabled = Array.isArray(config.enabledProviders) ? config.enabledProviders : [];
  return enabled.includes(provider);
};

/**
 * Resolve the price the user should see right now for a given (sku, provider).
 * The "variant" field is what gets stamped on every analytics event so we can
 * compare launch-vs-standard conversion later.
 */
const resolveOfferForCheckout = (config, { productSku, paymentProvider }) => {
  if (!config) return null;
  const skuKey = productSku === 'job_pass_3pack' ? 'pack3' : 'single';
  const offer = config[skuKey];
  if (!offer) return null;
  if (!isProviderEnabled(config, paymentProvider)) {
    return null;
  }
  const variant = offer.promoActive ? 'launch' : 'standard';
  const amount = variant === 'launch' ? offer.launchAmount : offer.standardAmount;
  const providers = offer.providers || {};
  const providerCfg = providers[paymentProvider] || {};
  let providerPriceRef = null;
  if (paymentProvider === 'stripe') {
    providerPriceRef = variant === 'launch' ? providerCfg.priceIdLaunch : providerCfg.priceIdStandard;
  } else if (paymentProvider === 'paypal') {
    providerPriceRef = variant === 'launch' ? providerCfg.skuLaunch : providerCfg.skuStandard;
  }
  return {
    productSku: productSku === 'job_pass_3pack' ? 'job_pass_3pack' : 'job_pass_single',
    packQuantity: productSku === 'job_pass_3pack' ? 3 : 1,
    paymentProvider,
    variant,
    amount,
    currency: offer.currency || 'AUD',
    promoLabel: offer.promoActive ? offer.promoLabel || 'Launch price' : null,
    promoBadgeLabel: offer.promoActive ? offer.promoBadgeLabel || '' : '',
    discountLabel: offer.promoActive ? offer.discountLabel || '' : '',
    showStandardPrice: offer.showStandardPrice !== false,
    description: offer.description || '',
    providerPriceRef: providerPriceRef || null,
  };
};

/**
 * Public-safe view used by the marketing Pricing page. Strips Stripe price IDs
 * but keeps everything the UI needs to render both launch + standard, both
 * SKUs, and the list of enabled providers.
 */
const buildPublicPricingView = (config) => {
  if (!config) return null;
  const single = config.single || {};
  const pack3 = config.pack3 || {};
  return {
    offerKey: config.offerKey || DEFAULT_OFFER_KEY,
    isActive: !!config.isActive,
    enabledProviders: Array.isArray(config.enabledProviders) ? config.enabledProviders : [],
    defaultProvider: config.defaultProvider || 'stripe',
    single: {
      launchAmount: single.launchAmount,
      standardAmount: single.standardAmount,
      currency: single.currency || 'AUD',
      promoLabel: single.promoLabel || 'Launch price',
      promoBadgeLabel: single.promoBadgeLabel || '',
      discountLabel: single.discountLabel || '',
      showStandardPrice: single.showStandardPrice !== false,
      promoActive: !!single.promoActive,
      description: single.description || '',
    },
    pack3: {
      launchAmount: pack3.launchAmount,
      standardAmount: pack3.standardAmount,
      currency: pack3.currency || 'AUD',
      promoLabel: pack3.promoLabel || 'Launch price',
      promoBadgeLabel: pack3.promoBadgeLabel || '',
      discountLabel: pack3.discountLabel || '',
      showStandardPrice: pack3.showStandardPrice !== false,
      promoActive: !!pack3.promoActive,
      description: pack3.description || '',
    },
  };
};

const updatePricingConfig = async (promoStorage, patch, actorEmail = 'system') => {
  if (!promoStorage) throw new Error('promoStorage is not available');
  const existing = (await promoStorage.findOne({ offerKey: DEFAULT_OFFER_KEY })) || cloneDefault();
  const safeExisting = omitImmutableTopLevelFields(existing);
  const safePatch = omitImmutableTopLevelFields(patch);
  const next = {
    ...safeExisting,
    ...safePatch,
    offerKey: DEFAULT_OFFER_KEY,
    single: {
      ...(existing.single || {}),
      ...(patch.single || {}),
      providers: {
        ...((existing.single && existing.single.providers) || {}),
        ...((patch.single && patch.single.providers) || {}),
      },
    },
    pack3: {
      ...(existing.pack3 || {}),
      ...(patch.pack3 || {}),
      providers: {
        ...((existing.pack3 && existing.pack3.providers) || {}),
        ...((patch.pack3 && patch.pack3.providers) || {}),
      },
    },
    updatedAt: new Date(),
    updatedBy: actorEmail || 'system',
  };
  await promoStorage.updateOne(
    { offerKey: DEFAULT_OFFER_KEY },
    { $set: next, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  return next;
};

module.exports = {
  DEFAULT_OFFER_KEY,
  DEFAULT_PRICING_CONFIG,
  ensurePricingConfigSeeded,
  getPricingConfig,
  isProviderEnabled,
  resolveOfferForCheckout,
  buildPublicPricingView,
  updatePricingConfig,
};
