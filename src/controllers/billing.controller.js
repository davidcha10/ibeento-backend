const Stripe = require('stripe');
const User = require('../models/User');
const UserSubscription = require('../models/UserSubscription');
const BillingTransaction = require('../models/BillingTransaction');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const { buildWebAppUrl } = require('../utils/web-app-url');

const ACTIVE_SUB_STATUSES = new Set(['active', 'trialing']);

/** Masks an email for display: "david@gmail.com" → "da***@gmail.com" */
function maskEmail(email) {
  if (!email || !email.includes('@')) return '';
  const [local, domain] = email.split('@');
  const visible = Math.min(2, local.length);
  const masked = local.slice(0, visible) + '*'.repeat(Math.max(3, local.length - visible));
  return `${masked}@${domain}`;
}

function deriveAutoRenew(stripeSubscription, status) {
  const hasScheduledCancel = Boolean(
    stripeSubscription?.cancel_at_period_end || stripeSubscription?.cancel_at
  );

  // If subscription is already terminated, it cannot auto-renew.
  if (status === 'canceled' || status === 'expired') return false;
  // For active/trial subscriptions, any scheduled cancel means no auto-renew.
  if (ACTIVE_SUB_STATUSES.has(status)) return !hasScheduledCancel;
  // For non-active states (past_due, incomplete, paused), keep conservative behavior.
  return !hasScheduledCancel;
}

function getStripeClient() {
  const secret = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!secret) return null;
  return new Stripe(secret);
}

function mapInterval(interval) {
  const v = String(interval || '').toLowerCase();
  if (v === 'day' || v === 'week' || v === 'month' || v === 'year') return v;
  return 'unknown';
}

function inferApplePlanInterval(productId = '') {
  const pid = String(productId || '').toLowerCase();
  if (pid.includes('year') || pid.includes('annual')) return 'year';
  if (pid.includes('month')) return 'month';
  if (pid.includes('week')) return 'week';
  if (pid.includes('day')) return 'day';
  return 'unknown';
}

function centsToAmount(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n / 100 : 0;
}

function getPlanConfig(plan) {
  const key = String(plan || '').toLowerCase();
  if (key === 'yearly') {
    return {
      priceId: String(process.env.STRIPE_PRICE_ID_YEARLY || '').trim(),
      planId: 'yearly',
      planName: 'Yearly',
    };
  }

  if (key === 'weekly') {
    return {
      priceId: String(process.env.STRIPE_PRICE_ID_WEEKLY || '').trim(),
      planId: 'weekly',
      planName: 'Weekly',
    };
  }

  if (key === 'trial') {
    return {
      priceId: String(process.env.STRIPE_PRICE_ID_TRIAL || '').trim(),
      planId: 'trial',
      planName: 'Trial',
    };
  }

  if (key === 'yearly_trial') {
    return {
      priceId: String(process.env.STRIPE_PRICE_ID_YEARLY || '').trim(),
      planId: 'yearly_trial',
      planName: 'Yearly (Trial)',
    };
  }

  if (key === 'weekly_trial') {
    return {
      priceId: String(process.env.STRIPE_PRICE_ID_WEEKLY || '').trim(),
      planId: 'weekly_trial',
      planName: 'Weekly (Trial)',
    };
  }

  return null;
}

async function hasAnyBillingHistory({ userId, stripeCustomerId, stripe }) {
  if (!userId) return false;

  const [hasTransactions, hasSubscriptionDoc] = await Promise.all([
    BillingTransaction.exists({ userId }),
    UserSubscription.exists({ userId }),
  ]);
  if (hasTransactions || hasSubscriptionDoc) return true;

  if (!stripe || !stripeCustomerId) return false;

  // Fallback to Stripe history in case local data was pruned/reset.
  try {
    const [subs, invoices] = await Promise.all([
      stripe.subscriptions.list({ customer: stripeCustomerId, status: 'all', limit: 1 }),
      stripe.invoices.list({ customer: stripeCustomerId, limit: 1 }),
    ]);
    return Boolean((subs?.data?.length || 0) > 0 || (invoices?.data?.length || 0) > 0);
  } catch (_err) {
    // If Stripe lookup fails, rely on local state only.
    return false;
  }
}

async function ensureStripeCustomer(stripe, user) {
  if (user?.stripeCustomerId) return user.stripeCustomerId;
  const customer = await stripe.customers.create({
    email: user.email || undefined,
    name: user.name || undefined,
    metadata: {
      userId: String(user._id),
    },
  });
  await User.findByIdAndUpdate(user._id, { $set: { stripeCustomerId: customer.id } });
  return customer.id;
}

async function upsertSubscriptionFromStripe(stripeSubscription, opts = {}) {
  const userId = opts.userId;
  if (!userId) return;

  const item = stripeSubscription?.items?.data?.[0];
  const price = item?.price || {};
  const recurring = price?.recurring || {};
  const status = String(stripeSubscription?.status || '').toLowerCase();
  const isPro = ACTIVE_SUB_STATUSES.has(status);
  const currentPeriodStart = stripeSubscription?.current_period_start
    ? new Date(stripeSubscription.current_period_start * 1000)
    : undefined;
  const currentPeriodEndUnix = stripeSubscription?.current_period_end || stripeSubscription?.cancel_at;
  const currentPeriodEnd = currentPeriodEndUnix
    ? new Date(currentPeriodEndUnix * 1000)
    : undefined;
  const trialEndsAt = stripeSubscription?.trial_end
    ? new Date(stripeSubscription.trial_end * 1000)
    : undefined;
  const canceledAt = stripeSubscription?.canceled_at
    ? new Date(stripeSubscription.canceled_at * 1000)
    : undefined;
  const startedAt = stripeSubscription?.start_date
    ? new Date(stripeSubscription.start_date * 1000)
    : undefined;

  await UserSubscription.findOneAndUpdate(
    { userId },
    {
      $set: {
        provider: 'stripe',
        providerCustomerId: stripeSubscription?.customer || undefined,
        providerSubscriptionId: stripeSubscription?.id || undefined,
        status: status || 'incomplete',
        isPro,
        autoRenew: deriveAutoRenew(stripeSubscription, status),
        plan: {
          planId: String(price?.id || opts.planId || ''),
          planName: String(price?.nickname || opts.planName || ''),
          interval: mapInterval(recurring?.interval),
          amount: centsToAmount(price?.unit_amount),
          currency: String(price?.currency || 'USD').toUpperCase(),
        },
        startedAt,
        trialEndsAt,
        currentPeriodStart,
        currentPeriodEnd,
        canceledAt,
        lastTransactionAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );

  await User.findByIdAndUpdate(userId, { $set: { isPro } });
}

async function createBillingTransactionFromEvent(payload) {
  const {
    userId,
    externalTransactionId,
    eventType,
    status,
    occurredAt,
    providerCustomerId,
    providerSubscriptionId,
    providerInvoiceId,
    providerPaymentIntentId,
    webhookEventId,
    planId,
    planName,
    planInterval,
    amountCents,
    currency,
    rawPayload,
  } = payload;

  if (!userId || !externalTransactionId || !eventType || !status || !occurredAt) return;

  await BillingTransaction.findOneAndUpdate(
    {
      provider: 'stripe',
      externalTransactionId,
    },
    {
      $setOnInsert: {
        userId,
        provider: 'stripe',
        externalTransactionId,
        eventType,
        status,
        occurredAt,
        processedAt: new Date(),
        source: 'webhook',
        providerCustomerId: providerCustomerId || undefined,
        providerSubscriptionId: providerSubscriptionId || undefined,
        providerInvoiceId: providerInvoiceId || undefined,
        providerPaymentIntentId: providerPaymentIntentId || undefined,
        webhookEventId: webhookEventId || undefined,
        plan: {
          planId: planId || undefined,
          planName: planName || undefined,
          interval: mapInterval(planInterval),
        },
        amount: {
          gross: centsToAmount(amountCents),
          fee: 0,
          tax: 0,
          net: centsToAmount(amountCents),
          currency: String(currency || 'USD').toUpperCase(),
        },
        metadata: {},
        rawPayload: rawPayload || undefined,
      },
    },
    { upsert: true }
  );
}

async function trackServerAnalyticsEvent({ event, userId, sessionId, metadata = {} }) {
  if (!event || (!userId && !sessionId)) return;
  await AnalyticsEvent.create({
    event,
    userId: userId || undefined,
    sessionId: sessionId || undefined,
    source: 'server',
    platform: 'web',
    pathname: '/billing',
    success: true,
    metadata,
    occurredAt: new Date(),
  });
}

exports.createCheckoutSession = async (req, res, next) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: 'Unauthorized' });
    const stripe = getStripeClient();
    if (!stripe) return res.status(503).json({ error: 'Stripe is not configured' });

    const plan = String(req.body?.plan || '').toLowerCase();
    const entryPoint = String(req.body?.entryPoint || 'unknown').trim() || 'unknown';
    const paywallId = String(req.body?.paywallId || 'main_pro_paywall').trim() || 'main_pro_paywall';
    const abVariant = String(req.body?.abVariant || 'unknown').trim() || 'unknown';
    let planConfig = getPlanConfig(plan);
    if (!planConfig || !planConfig.priceId) {
      return res.status(400).json({ error: 'Invalid plan configuration' });
    }

    const user = await User.findById(req.user._id).select('_id email name stripeCustomerId').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    let forceNoTrial = false;
    let trialPeriodDays = 0;
    const requestedPlan = plan;

    // Legacy compatibility: "trial" behaves as weekly with 3-day trial.
    if (requestedPlan === 'trial') {
      trialPeriodDays = 3;
      const weeklyConfig = getPlanConfig('weekly');
      if (weeklyConfig?.priceId) {
        planConfig = {
          ...weeklyConfig,
          planId: 'weekly_trial',
          planName: 'Weekly (Trial)',
        };
      }
    } else if (requestedPlan === 'yearly_trial') {
      trialPeriodDays = 7;
      const yearlyConfig = getPlanConfig('yearly');
      if (yearlyConfig?.priceId) {
        planConfig = {
          ...yearlyConfig,
          planId: 'yearly_trial',
          planName: 'Yearly (Trial)',
        };
      }
    } else if (requestedPlan === 'weekly_trial') {
      trialPeriodDays = 3;
      const weeklyConfig = getPlanConfig('weekly');
      if (weeklyConfig?.priceId) {
        planConfig = {
          ...weeklyConfig,
          planId: 'weekly_trial',
          planName: 'Weekly (Trial)',
        };
      }
    }

    if (trialPeriodDays > 0) {
      const billingHistory = await hasAnyBillingHistory({
        userId: user._id,
        stripeCustomerId: user.stripeCustomerId,
        stripe,
      });
      if (billingHistory) {
        trialPeriodDays = 0;
        forceNoTrial = true;
        if (planConfig.planId === 'yearly_trial') {
          planConfig = {
            ...planConfig,
            planId: 'yearly',
            planName: 'Yearly',
          };
        } else {
          planConfig = {
            ...planConfig,
            planId: 'weekly',
            planName: 'Weekly',
          };
        }
      }
    }

    const customerId = await ensureStripeCustomer(stripe, user);
    const successUrl = buildWebAppUrl('/trip?payment=success');
    const cancelUrl = buildWebAppUrl('/trip?payment=cancel');

    const subscriptionData = {
      metadata: {
        userId: String(user._id),
        planId: planConfig.planId,
        requestedPlan,
        entryPoint,
        paywallId,
        abVariant,
      },
      ...(trialPeriodDays > 0 ? { trial_period_days: trialPeriodDays } : {}),
      ...(forceNoTrial ? { trial_end: 'now' } : {}),
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: String(user._id),
      line_items: [
        {
          price: planConfig.priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        userId: String(user._id),
        planId: planConfig.planId,
        entryPoint,
        paywallId,
        abVariant,
      },
      subscription_data: subscriptionData,
      allow_promotion_codes: true,
    });

    await trackServerAnalyticsEvent({
      event: 'checkout_start',
      userId: req.user._id,
      sessionId: undefined,
      metadata: {
        plan_id: planConfig.planId,
        plan_name: planConfig.planName,
        checkout_session_id: session.id,
        entry_point: entryPoint,
        paywall_id: paywallId,
        ab_variant: abVariant,
      },
    });

    return res.json({ ok: true, sessionId: session.id, url: session.url });
  } catch (err) {
    return next(err);
  }
};

exports.getTrialEligibility = async (req, res, next) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: 'Unauthorized' });
    const stripe = getStripeClient();

    const user = await User.findById(req.user._id).select('_id stripeCustomerId').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const billingHistory = await hasAnyBillingHistory({
      userId: user._id,
      stripeCustomerId: user.stripeCustomerId,
      stripe,
    });

    return res.json({
      ok: true,
      trialEligible: !billingHistory,
    });
  } catch (err) {
    return next(err);
  }
};

exports.createCustomerPortalSession = async (req, res, next) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: 'Unauthorized' });
    const stripe = getStripeClient();
    if (!stripe) return res.status(503).json({ error: 'Stripe is not configured' });

    const user = await User.findById(req.user._id).select('_id stripeCustomerId').lean();
    if (!user?.stripeCustomerId) {
      return res.status(400).json({ error: 'No Stripe customer found for this user' });
    }

    const returnUrl = buildWebAppUrl('/trip');
    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: returnUrl,
    });

    return res.json({ ok: true, url: portal.url });
  } catch (err) {
    return next(err);
  }
};

exports.getMySubscription = async (req, res, next) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: 'Unauthorized' });

    let subscription = await UserSubscription.findOne({ userId: req.user._id })
      .select(
        'provider providerCustomerId providerSubscriptionId status isPro autoRenew plan startedAt trialEndsAt currentPeriodStart currentPeriodEnd canceledAt lastTransactionAt'
      )
      .lean();

    // Keep local subscription status in sync even if webhook delivery is delayed.
    if (subscription?.provider === 'stripe') {
      const stripe = getStripeClient();
      if (stripe) {
        try {
          let stripeSubscription = null;

          if (subscription?.providerSubscriptionId) {
            stripeSubscription = await stripe.subscriptions.retrieve(
              subscription.providerSubscriptionId,
              { expand: ['items.data.price'] }
            );
          }

          // If local subscription id is stale/missing, resolve latest from customer.
          if (!stripeSubscription && subscription?.providerCustomerId) {
            const listed = await stripe.subscriptions.list({
              customer: subscription.providerCustomerId,
              limit: 10,
              status: 'all',
            });
            stripeSubscription = listed.data
              .slice()
              .sort((a, b) => Number(b.created || 0) - Number(a.created || 0))[0] || null;
          }

          if (stripeSubscription) {
            await upsertSubscriptionFromStripe(stripeSubscription, { userId: req.user._id });
          }

          subscription = await UserSubscription.findOne({ userId: req.user._id })
            .select(
              'provider status isPro autoRenew plan startedAt trialEndsAt currentPeriodStart currentPeriodEnd canceledAt lastTransactionAt'
            )
            .lean();
        } catch (_err) {
          // Non-blocking: return last known local snapshot if Stripe sync fails.
        }
      }
    } else if (subscription) {
      subscription = await UserSubscription.findOne({ userId: req.user._id })
      .select(
        'provider status isPro autoRenew plan startedAt trialEndsAt currentPeriodStart currentPeriodEnd canceledAt lastTransactionAt'
      )
      .lean();
    }

    if (!subscription) {
      return res.json({ ok: true, subscription: null });
    }

    return res.json({ ok: true, subscription });
  } catch (err) {
    return next(err);
  }
};

exports.handleStripeWebhook = async (req, res, next) => {
  try {
    const stripe = getStripeClient();
    if (!stripe) return res.status(503).json({ error: 'Stripe is not configured' });

    const signature = req.headers['stripe-signature'];
    const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
    if (!signature || !webhookSecret) {
      return res.status(400).json({ error: 'Missing Stripe webhook configuration' });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, signature, webhookSecret);
    } catch (err) {
      return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
    }

    const type = String(event.type || '');
    const data = event.data?.object || {};

    if (type === 'checkout.session.completed') {
      const userId = String(data?.client_reference_id || data?.metadata?.userId || '').trim();
      const customerId = String(data?.customer || '').trim();
      const subscriptionId = String(data?.subscription || '').trim();

      if (userId && customerId) {
        await User.findByIdAndUpdate(userId, { $set: { stripeCustomerId: customerId } });
      }

      if (subscriptionId && userId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
        await upsertSubscriptionFromStripe(subscription, { userId });
      }

      if (userId) {
        await trackServerAnalyticsEvent({
          event: 'purchase_success',
          userId,
          sessionId: undefined,
          metadata: {
            paywall_id: String(data?.metadata?.paywallId || 'main_pro_paywall'),
            entry_point: String(data?.metadata?.entryPoint || 'unknown'),
            ab_variant: String(data?.metadata?.abVariant || 'unknown'),
            checkout_session_id: String(data?.id || ''),
            stripe_subscription_id: subscriptionId || undefined,
          },
        });

        await createBillingTransactionFromEvent({
          userId,
          externalTransactionId: event.id,
          webhookEventId: event.id,
          eventType: 'purchase',
          status: 'succeeded',
          occurredAt: new Date(),
          providerCustomerId: customerId || undefined,
          providerSubscriptionId: subscriptionId || undefined,
          rawPayload: data,
        });
      }
    }

    if (type === 'customer.subscription.created' || type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
      const subscription = data;
      const customerId = String(subscription?.customer || '').trim();
      const subscriptionId = String(subscription?.id || '').trim();
      if (customerId && subscriptionId) {
        const user = await User.findOne({ stripeCustomerId: customerId }).select('_id').lean();
        if (user?._id) {
          await upsertSubscriptionFromStripe(subscription, { userId: user._id });
          await createBillingTransactionFromEvent({
            userId: user._id,
            externalTransactionId: event.id,
            webhookEventId: event.id,
            eventType: type === 'customer.subscription.deleted' ? 'subscription_canceled' : (type === 'customer.subscription.created' ? 'subscription_created' : 'subscription_updated'),
            status: type === 'customer.subscription.deleted' ? 'canceled' : 'succeeded',
            occurredAt: new Date(subscription?.current_period_start ? subscription.current_period_start * 1000 : Date.now()),
            providerCustomerId: customerId,
            providerSubscriptionId: subscriptionId,
            rawPayload: subscription,
          });
        }
      }
    }

    if (type === 'invoice.paid' || type === 'invoice.payment_failed') {
      const invoice = data;
      const customerId = String(invoice?.customer || '').trim();
      const subscriptionId = String(invoice?.subscription || '').trim();
      const user = customerId
        ? await User.findOne({ stripeCustomerId: customerId }).select('_id').lean()
        : null;

      if (user?._id) {
        await createBillingTransactionFromEvent({
          userId: user._id,
          externalTransactionId: event.id,
          webhookEventId: event.id,
          eventType: type === 'invoice.paid' ? 'renewal' : 'failed_payment',
          status: type === 'invoice.paid' ? 'succeeded' : 'failed',
          occurredAt: new Date(invoice?.created ? invoice.created * 1000 : Date.now()),
          providerCustomerId: customerId,
          providerSubscriptionId: subscriptionId,
          providerInvoiceId: String(invoice?.id || ''),
          providerPaymentIntentId: String(invoice?.payment_intent || ''),
          amountCents: Number(invoice?.amount_paid || invoice?.amount_due || 0),
          currency: String(invoice?.currency || 'USD'),
          rawPayload: invoice,
        });
      }
    }

    return res.json({ received: true });
  } catch (err) {
    return next(err);
  }
};

exports.syncAppleSubscription = async (req, res, next) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: 'Unauthorized' });

    const productId = String(req.body?.productId || '').trim();
    const transactionId = String(req.body?.transactionId || '').trim();
    const originalTransactionId = String(req.body?.originalTransactionId || '').trim();
    const purchaseDate = req.body?.purchaseDate ? new Date(req.body.purchaseDate) : new Date();
    const expiresDateRaw = req.body?.expiresDate ? new Date(req.body.expiresDate) : null;
    const revocationDateRaw = req.body?.revocationDate ? new Date(req.body.revocationDate) : null;
    const entryPoint = String(req.body?.entryPoint || 'unknown').trim() || 'unknown';
    const paywallId = String(req.body?.paywallId || 'onboarding_paywall').trim() || 'onboarding_paywall';
    const abVariant = String(req.body?.abVariant || 'unknown').trim() || 'unknown';

    if (!productId || !transactionId) {
      return res.status(400).json({ error: 'productId and transactionId are required' });
    }

    const now = new Date();
    const hasRevocation = revocationDateRaw instanceof Date && !Number.isNaN(revocationDateRaw.getTime());
    const hasExpiry = expiresDateRaw instanceof Date && !Number.isNaN(expiresDateRaw.getTime());
    const isActive = !hasRevocation && (!hasExpiry || expiresDateRaw > now);
    const status = isActive ? 'active' : 'expired';
    const isPro = isActive;
    const canonicalProviderSubscriptionId = originalTransactionId || transactionId;

    // Ownership guard #1:
    // A provider subscription (original transaction) cannot belong to a different user.
    const existingSubscriptionOwner = await UserSubscription.findOne({
      provider: 'apple',
      providerSubscriptionId: canonicalProviderSubscriptionId,
      userId: { $ne: req.user._id },
    })
      .select('_id userId providerSubscriptionId')
      .lean();
    if (existingSubscriptionOwner) {
      const conflictUser = await User.findById(existingSubscriptionOwner.userId).select('email').lean();
      const maskedEmail = maskEmail(conflictUser?.email || '');
      return res.status(409).json({
        error: 'apple_subscription_already_claimed',
        message: 'This Apple subscription is already linked to another account.',
        maskedEmail,
      });
    }

    // Ownership guard #2:
    // A transactionId cannot be claimed by a different user.
    const existingTxOwner = await BillingTransaction.findOne({
      provider: 'apple',
      externalTransactionId: transactionId,
      userId: { $ne: req.user._id },
    })
      .select('_id userId externalTransactionId')
      .lean();
    if (existingTxOwner) {
      const conflictUser = await User.findById(existingTxOwner.userId).select('email').lean();
      const maskedEmail = maskEmail(conflictUser?.email || '');
      return res.status(409).json({
        error: 'apple_transaction_already_claimed',
        message: 'This Apple transaction is already linked to another account.',
        maskedEmail,
      });
    }

    await UserSubscription.findOneAndUpdate(
      { userId: req.user._id },
      {
        $set: {
          provider: 'apple',
          providerSubscriptionId: canonicalProviderSubscriptionId,
          status,
          isPro,
          autoRenew: isActive,
          plan: {
            planId: productId,
            planName: 'Apple Subscription',
            interval: inferApplePlanInterval(productId),
            amount: 0,
            currency: 'USD',
          },
          startedAt: purchaseDate,
          currentPeriodStart: purchaseDate,
          currentPeriodEnd: hasExpiry ? expiresDateRaw : undefined,
          canceledAt: hasRevocation ? revocationDateRaw : undefined,
          lastTransactionAt: now,
          metadata: {
            source: 'ios_storekit_client_sync',
            transactionId,
            originalTransactionId: originalTransactionId || '',
          },
        },
      },
      { upsert: true, new: true }
    );

    await User.findByIdAndUpdate(req.user._id, { $set: { isPro } });

    await BillingTransaction.findOneAndUpdate(
      { provider: 'apple', externalTransactionId: transactionId },
      {
        $setOnInsert: {
          userId: req.user._id,
          provider: 'apple',
          externalTransactionId: transactionId,
          eventType: 'purchase',
          status: 'succeeded',
          occurredAt: purchaseDate,
          processedAt: now,
          source: 'ios_iap_client',
          providerSubscriptionId: canonicalProviderSubscriptionId,
          plan: {
            planId: productId,
            planName: 'Apple Subscription',
            interval: inferApplePlanInterval(productId),
          },
          amount: {
            gross: 0,
            fee: 0,
            tax: 0,
            net: 0,
            currency: 'USD',
          },
          metadata: {
            paywall_id: paywallId,
            entry_point: entryPoint,
            ab_variant: abVariant,
          },
          rawPayload: req.body || {},
        },
      },
      { upsert: true }
    );

    await trackServerAnalyticsEvent({
      event: 'purchase_success',
      userId: req.user._id,
      sessionId: undefined,
      metadata: {
        paywall_id: paywallId,
        entry_point: entryPoint,
        ab_variant: abVariant,
        provider: 'apple',
        product_id: productId,
      },
    });

    return res.json({
      ok: true,
      status,
      isPro,
      productId,
      transactionId,
      originalTransactionId: canonicalProviderSubscriptionId,
    });
  } catch (err) {
    // Race-condition guard: if two users try to claim the same Apple subscription/tx
    // at nearly the same time, Mongo unique indexes may throw duplicate key errors.
    if (err?.code === 11000) {
      return res.status(409).json({
        error: 'apple_subscription_conflict',
        message: 'This Apple subscription is already linked to another account.',
      });
    }
    return next(err);
  }
};
