const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SUBSCRIPTION_GRACE_DAYS = Number.parseInt(process.env.SUBSCRIPTION_GRACE_DAYS || '3', 10);
const ONE_TIME_SUBSCRIPTION_DAYS = Number.parseInt(process.env.ONE_TIME_SUBSCRIPTION_DAYS || '30', 10);
const ACTIVE_STATUSES = new Set(['active', 'trialing']);
const TERMINAL_STATUSES = new Set([
  'canceled',
  'unpaid',
  'incomplete_expired',
  'paused',
  'inactive',
]);

const derivePlanFromStatus = (status) => {
  if (!status) return 'free';
  if (ACTIVE_STATUSES.has(status) || status === 'past_due') return 'premium';
  if (TERMINAL_STATUSES.has(status)) return 'free';
  return 'free';
};

const normalizeSubscription = (user) => {
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
  };
};

const calculateOneTimePeriodEnd = (startDate) => {
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + ONE_TIME_SUBSCRIPTION_DAYS);
  return endDate;
};

const isSubscriptionEntitled = (subscription, now = new Date()) => {
  if (!subscription) return false;
  if (ACTIVE_STATUSES.has(subscription.status)) return true;

  if (subscription.status === 'past_due' && subscription.gracePeriodEndsAt) {
    return now <= new Date(subscription.gracePeriodEndsAt);
  }

  return false;
};

const applyReconciledState = async ({ usersStorage, userEmail, nextSubscription }) => {
  const entitled = isSubscriptionEntitled(nextSubscription);

  await usersStorage.updateOne(
    { userEmail },
    {
      $set: {
        subscription: {
          ...nextSubscription,
          updatedAt: new Date(),
        },
        isSubscribed: entitled,
        updatedAt: new Date(),
      },
    }
  );

  return entitled;
};

const hasStateChanged = (before, after, beforeEntitled, afterEntitled) => {
  return (
    before.status !== after.status ||
    before.plan !== after.plan ||
    before.billingMode !== after.billingMode ||
    before.stripeCustomerId !== after.stripeCustomerId ||
    before.stripeSubscriptionId !== after.stripeSubscriptionId ||
    Number(before.cancelAtPeriodEnd) !== Number(after.cancelAtPeriodEnd) ||
    (before.currentPeriodStart ? new Date(before.currentPeriodStart).getTime() : null) !==
      (after.currentPeriodStart ? new Date(after.currentPeriodStart).getTime() : null) ||
    (before.currentPeriodEnd ? new Date(before.currentPeriodEnd).getTime() : null) !==
      (after.currentPeriodEnd ? new Date(after.currentPeriodEnd).getTime() : null) ||
    (before.gracePeriodEndsAt ? new Date(before.gracePeriodEndsAt).getTime() : null) !==
      (after.gracePeriodEndsAt ? new Date(after.gracePeriodEndsAt).getTime() : null) ||
    beforeEntitled !== afterEntitled
  );
};

const reconcileSingleUser = async ({ usersStorage, subscriptionStorage, auditLogger, user }) => {
  const now = new Date();
  const current = normalizeSubscription(user);
  const currentEntitled = isSubscriptionEntitled(current, now);

  const next = { ...current };
  const isLegacyOneTime = next.billingMode === 'one_time';

  if (isLegacyOneTime) {
    if (!next.currentPeriodStart && user.createdAt) {
      next.currentPeriodStart = new Date(user.createdAt);
    }
    if (!next.currentPeriodEnd && next.currentPeriodStart) {
      next.currentPeriodEnd = calculateOneTimePeriodEnd(next.currentPeriodStart);
    }
    if (next.currentPeriodEnd && now > new Date(next.currentPeriodEnd)) {
      next.status = 'inactive';
      next.plan = 'free';
      next.gracePeriodEndsAt = null;
    }
  }
  let localGraceExpired = false;
  if (next.status === 'past_due' && next.gracePeriodEndsAt && now > new Date(next.gracePeriodEndsAt)) {
    next.status = 'inactive';
    next.plan = 'free';
    next.gracePeriodEndsAt = null;
    localGraceExpired = true;
  }

  if (!isLegacyOneTime && next.stripeSubscriptionId) {
    try {
      const stripeSub = await stripe.subscriptions.retrieve(next.stripeSubscriptionId);
      const stripeStatus = stripeSub.status || next.status;
      next.status = stripeStatus;
      next.plan = derivePlanFromStatus(next.status);
      next.billingMode = 'auto_renew';
      next.stripeCustomerId =
        stripeSub.customer && typeof stripeSub.customer === 'string' ? stripeSub.customer : next.stripeCustomerId;
      next.currentPeriodStart = stripeSub.current_period_start
        ? new Date(stripeSub.current_period_start * 1000)
        : next.currentPeriodStart;
      next.currentPeriodEnd = stripeSub.current_period_end
        ? new Date(stripeSub.current_period_end * 1000)
        : next.currentPeriodEnd;
      next.cancelAtPeriodEnd = Boolean(stripeSub.cancel_at_period_end);
      if (next.status === 'past_due') {
        if (localGraceExpired) {
          next.status = 'inactive';
          next.plan = 'free';
          next.gracePeriodEndsAt = null;
        } else if (current.status !== 'past_due' || !current.gracePeriodEndsAt) {
          next.gracePeriodEndsAt = new Date(now.getTime() + SUBSCRIPTION_GRACE_DAYS * 24 * 60 * 60 * 1000);
        } else {
          next.gracePeriodEndsAt = new Date(current.gracePeriodEndsAt);
        }
      } else {
        next.gracePeriodEndsAt = null;
      }
    } catch (error) {
      if (error?.code === 'resource_missing') {
        next.status = 'inactive';
        next.plan = 'free';
        next.cancelAtPeriodEnd = false;
        next.gracePeriodEndsAt = null;
      } else {
        throw error;
      }
    }
  }

  const nextEntitled = isSubscriptionEntitled(next, now);
  if (!hasStateChanged(current, next, currentEntitled, nextEntitled)) {
    return { changed: false, userEmail: user.userEmail };
  }

  await applyReconciledState({ usersStorage, userEmail: user.userEmail, nextSubscription: next });

  const logPayload = {
    userEmail: user.userEmail,
    userId: user.clerkId || user.userEmail,
    clerkId: user.clerkId,
    userName: user.userName,
    type: 'subscription_reconcile',
    description: `Subscription reconciled: ${current.status} -> ${next.status}`,
    amount: 0,
    currency: 'AUD',
    status: 'completed',
    date: now,
    createdAt: now,
    metadata: {
      source: 'cron_reconcile',
      beforeStatus: current.status,
      afterStatus: next.status,
      beforeEntitled: currentEntitled,
      afterEntitled: nextEntitled,
      stripeSubscriptionId: next.stripeSubscriptionId,
    },
  };

  await subscriptionStorage.insertOne(logPayload);

  await auditLogger.logAudit({
    action: 'RECONCILE_SUBSCRIPTION_STATE',
    resource: 'subscription',
    resourceId: user._id?.toString?.() || user.userEmail,
    userId: 'system',
    userEmail: 'system@toolmate.com',
    role: 'system',
    oldData: {
      subscription: current,
      isSubscribed: currentEntitled,
    },
    newData: {
      subscription: next,
      isSubscribed: nextEntitled,
    },
    metadata: {
      source: 'cron_reconcile',
      targetUser: user.userEmail,
    },
  });

  return { changed: true, userEmail: user.userEmail };
};

const reconcileSubscriptionState = async ({ usersStorage, subscriptionStorage, auditLogger, batchLimit = 200 }) => {
  const users = await usersStorage
    .find({
      $or: [
        { 'subscription.stripeSubscriptionId': { $exists: true, $ne: null } },
        { 'subscription.status': { $in: ['active', 'trialing', 'past_due'] } },
        { isSubscribed: true },
      ],
    })
    .limit(batchLimit)
    .toArray();

  const summary = {
    scanned: users.length,
    changed: 0,
    failed: 0,
  };

  for (const user of users) {
    try {
      const result = await reconcileSingleUser({ usersStorage, subscriptionStorage, auditLogger, user });
      if (result.changed) {
        summary.changed += 1;
      }
    } catch (error) {
      summary.failed += 1;
      console.error(`Subscription reconcile failed for ${user.userEmail}:`, error.message || error);
    }
  }

  return summary;
};

module.exports = {
  reconcileSubscriptionState,
};
