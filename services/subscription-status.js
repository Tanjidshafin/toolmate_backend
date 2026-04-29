const ACTIVE_STATUSES = new Set(['active', 'trialing']);
const TERMINAL_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired', 'paused', 'inactive']);
const HARD_NO_ENTITLEMENT_STATUSES = new Set(['unpaid', 'incomplete_expired']);

/**
 * Raw subscription fields from the user document (no derived entitlement).
 */
const parseSubscriptionFields = (user) => {
  const subscription = user?.subscription || {};
  const status = subscription.status || 'inactive';

  return {
    status,
    plan: subscription.plan || (status === 'active' ? 'premium' : 'free'),
    billingMode: subscription.billingMode || 'auto_renew',
    stripeCustomerId: subscription.stripeCustomerId || null,
    stripeSubscriptionId: subscription.stripeSubscriptionId || null,
    currentPeriodStart: subscription.currentPeriodStart ? new Date(subscription.currentPeriodStart) : null,
    currentPeriodEnd: subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null,
    cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
    gracePeriodEndsAt: subscription.gracePeriodEndsAt ? new Date(subscription.gracePeriodEndsAt) : null,
    updatedAt: subscription.updatedAt ? new Date(subscription.updatedAt) : null,
  };
};

const isSubscriptionEntitled = (subscription, now = new Date()) => {
  if (!subscription) return false;
  const status = subscription.status || 'inactive';

  if (HARD_NO_ENTITLEMENT_STATUSES.has(status)) return false;
  if (ACTIVE_STATUSES.has(status)) return true;

  if (status === 'past_due' && subscription.gracePeriodEndsAt) {
    return now <= new Date(subscription.gracePeriodEndsAt);
  }

  const end = subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
  if (end && now < end) {
    if (subscription.cancelAtPeriodEnd) return true;
    if (status === 'canceled') return true;
  }

  return false;
};

const resolveScheduledCancellation = (subscription, now = new Date()) => {
  const entitled = isSubscriptionEntitled(subscription, now);
  const end = subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
  const status = subscription.status || 'inactive';
  const cancelAtPeriodEnd = Boolean(subscription.cancelAtPeriodEnd);

  const isScheduled =
    entitled && end && now < end && (cancelAtPeriodEnd || status === 'canceled');

  const scheduledCancellationEffectiveAt = isScheduled && end ? end.toISOString() : null;
  const cancellationMessage =
    isScheduled && scheduledCancellationEffectiveAt
      ? "Your subscription is cancelled for the next billing cycle. You'll keep Best Mate access until the end of your current billing period."
      : null;

  return {
    isScheduledForCancellation: isScheduled,
    scheduledCancellationEffectiveAt,
    cancellationMessage,
  };
};

/**
 * Core row + derived plan for persistence (`plan` and top-level `isSubscribed` stay aligned).
 */
const prepareSubscriptionForStore = (subscriptionCore, now = new Date()) => {
  const entitled = isSubscriptionEntitled(subscriptionCore, now);
  return {
    ...subscriptionCore,
    plan: entitled ? 'premium' : 'free',
  };
};

/** API view from an already-parsed core row (same shape as parseSubscriptionFields output). */
const buildSubscriptionViewFromCore = (core, now = new Date()) => {
  const entitled = isSubscriptionEntitled(core, now);
  const scheduled = resolveScheduledCancellation(core, now);

  return {
    ...core,
    plan: entitled ? 'premium' : 'free',
    isActive: entitled,
    ...scheduled,
  };
};

/**
 * Full subscription view for APIs (entitlement-correct plan, flags, cancellation copy).
 */
const normalizeSubscription = (user, now = new Date()) => {
  const base = parseSubscriptionFields(user);
  return buildSubscriptionViewFromCore(base, now);
};

const getUserProStatus = (user) => {
  return isSubscriptionEntitled(parseSubscriptionFields(user), new Date());
};

const enrichUserWithSubscription = (user) => {
  if (!user) return null;

  const subscription = normalizeSubscription(user);
  const entitled = subscription.isActive;
  return {
    ...user,
    subscription,
    isSubscribed: entitled,
    isPro: entitled,
  };
};

/**
 * Job-level entitlement helper. A saved job is considered unlocked when ANY
 * of these hold:
 *   - The saved job carries `lockState=unlocked` (set at webhook bind time).
 *   - The user has at least one Job Pass with `packRemaining > 0` and the
 *     pass has not been refunded/revoked. The caller is expected to pass
 *     `activePasses` (already-fetched list) to avoid a roundtrip.
 *
 * Reasons returned, in priority order:
 *   job_pass_bound | job_pass_available | none
 */
const getJobEntitlement = ({ savedJob, user, activePasses = [], now = new Date() } = {}) => {
  // Persisted unlock on the saved job (Job Pass, admin grant, or subscription-era unlock) is lifetime for that job.
  if (savedJob && savedJob.lockState === 'unlocked') {
    let reason = 'job_pass_bound';
    if (savedJob.unlockType === 'admin_grant') reason = 'admin_grant';
    return {
      unlocked: true,
      reason,
      passId: savedJob.passId || null,
      packRemaining: null,
    };
  }

  const usablePass = (Array.isArray(activePasses) ? activePasses : []).find((pass) => {
    if (!pass) return false;
    if (pass.status !== 'active') return false;
    if (pass.refundedAt || pass.revokedAt) return false;
    if (typeof pass.packRemaining !== 'number') return false;
    return pass.packRemaining > 0;
  });

  if (usablePass) {
    return {
      unlocked: false,
      reason: 'job_pass_available',
      passId: usablePass.passId,
      packRemaining: usablePass.packRemaining,
    };
  }

  return {
    unlocked: false,
    reason: 'none',
    passId: null,
    packRemaining: 0,
  };
};

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  HARD_NO_ENTITLEMENT_STATUSES,
  parseSubscriptionFields,
  isSubscriptionEntitled,
  resolveScheduledCancellation,
  prepareSubscriptionForStore,
  buildSubscriptionViewFromCore,
  normalizeSubscription,
  getUserProStatus,
  enrichUserWithSubscription,
  getJobEntitlement,
};
