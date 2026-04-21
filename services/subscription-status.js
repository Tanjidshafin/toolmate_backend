const ACTIVE_STATUSES = new Set(['active', 'trialing']);
const TERMINAL_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired', 'paused', 'inactive']);

const isSubscriptionEntitled = (subscription, now = new Date()) => {
  if (!subscription) return false;
  if (subscription.isActive === true) return true;
  if (ACTIVE_STATUSES.has(subscription.status)) return true;

  if (subscription.status === 'past_due' && subscription.gracePeriodEndsAt) {
    return now <= new Date(subscription.gracePeriodEndsAt);
  }

  return false;
};

const normalizeSubscription = (user) => {
  const subscription = user?.subscription || {};
  const status = subscription.status || 'inactive';
  const isActive = isSubscriptionEntitled(
    {
      ...subscription,
      status,
      gracePeriodEndsAt: subscription.gracePeriodEndsAt ? new Date(subscription.gracePeriodEndsAt) : null,
    },
    new Date(),
  );

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
    isActive,
  };
};

const getUserProStatus = (user) => {
  return normalizeSubscription(user).status === 'active';
};

const enrichUserWithSubscription = (user) => {
  if (!user) return null;

  const subscription = normalizeSubscription(user);
  return {
    ...user,
    subscription,
    isSubscribed: subscription.isActive,
    isPro: subscription.status === 'active',
  };
};

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  isSubscriptionEntitled,
  normalizeSubscription,
  getUserProStatus,
  enrichUserWithSubscription,
};