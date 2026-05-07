const User = require('../models/User');
const Itinerary = require('../models/Itinerary');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const BillingTransaction = require('../models/BillingTransaction');
const UserSubscription = require('../models/UserSubscription');
const Activity = require('../models/Activity');
const Zone = require('../models/Zone');

const FUNNEL_STEPS = [
  'landing_viewed',
  'signup_started',
  'signup_completed',
  'itinerary_created',
  'city_added',
  'activity_added',
  'max_itineraries_paywall_view',
  'max_destinations_paywall_view',
  'build_route_paywall_view',
  'paywall_view',
  'checkout_start',
  'purchase_success',
];

function parseDays(raw, fallback = 30) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.round(n), 1), 365);
}

function rangeStart(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function startOfUtcDay(dateLike) {
  const d = new Date(dateLike);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function keyFor(doc) {
  if (doc?.userId) return `u:${doc.userId}`;
  if (doc?.sessionId) return `s:${doc.sessionId}`;
  return null;
}

function keyForLandingViewed(doc, sessionToUser) {
  if (doc?.userId) return `u:${doc.userId}`;
  const sessionId = doc?.sessionId ? String(doc.sessionId) : '';
  if (!sessionId) return null;
  const mappedUser = sessionToUser.get(sessionId);
  if (mappedUser) return `u:${mappedUser}`;
  return `s:${sessionId}`;
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toMoney(value) {
  return Math.round(asNumber(value) * 100) / 100;
}

async function uniqueActorCountByEvent(event, from) {
  const rows = await AnalyticsEvent.aggregate([
    { $match: { event, occurredAt: { $gte: from } } },
    {
      $project: {
        actor: {
          $ifNull: [
            { $concat: ['u:', { $toString: '$userId' }] },
            { $concat: ['s:', '$sessionId'] },
          ],
        },
      },
    },
    { $match: { actor: { $ne: null } } },
    { $group: { _id: '$actor' } },
    { $count: 'total' },
  ]);

  return Number(rows?.[0]?.total || 0);
}

exports.overview = async (req, res, next) => {
  try {
    const days = parseDays(req.query.days, 30);
    const from = rangeStart(days);

    const [newUsers, newItineraries, totalEvents, activeEventActors] = await Promise.all([
      User.countDocuments({ createdAt: { $gte: from } }),
      Itinerary.countDocuments({ createdAt: { $gte: from } }),
      AnalyticsEvent.countDocuments({ occurredAt: { $gte: from } }),
      AnalyticsEvent.aggregate([
        { $match: { occurredAt: { $gte: from } } },
        {
          $project: {
            actor: {
              $ifNull: [
                { $concat: ['u:', { $toString: '$userId' }] },
                { $concat: ['s:', '$sessionId'] },
              ],
            },
          },
        },
        { $match: { actor: { $ne: null } } },
        { $group: { _id: '$actor' } },
        { $count: 'total' },
      ]),
    ]);

    const activeActors = Number(activeEventActors?.[0]?.total || 0);

    return res.json({
      success: true,
      data: {
        windowDays: days,
        from,
        newUsers,
        newItineraries,
        activeActors,
        totalEvents,
      },
    });
  } catch (err) {
    return next(err);
  }
};

exports.funnel = async (req, res, next) => {
  try {
    const days = parseDays(req.query.days, 30);
    const from = rangeStart(days);

    const events = await AnalyticsEvent.find(
      { occurredAt: { $gte: from }, event: { $in: FUNNEL_STEPS } },
      { event: 1, userId: 1, sessionId: 1 }
    ).lean();

    // Link guest sessions that later became authenticated users, so landing_viewed
    // can be deduplicated per user identity instead of counting both session and user.
    const sessionToUser = new Map();
    for (const ev of events) {
      const sid = ev?.sessionId ? String(ev.sessionId) : '';
      const uid = ev?.userId ? String(ev.userId) : '';
      if (!sid || !uid) continue;
      if (!sessionToUser.has(sid)) sessionToUser.set(sid, uid);
    }

    const actorsByStep = new Map(FUNNEL_STEPS.map((s) => [s, new Set()]));
    for (const ev of events) {
      const k = ev.event === 'landing_viewed'
        ? keyForLandingViewed(ev, sessionToUser)
        : keyFor(ev);
      if (!k) continue;
      const set = actorsByStep.get(ev.event);
      if (!set) continue;
      set.add(k);
    }

    const firstCount = actorsByStep.get(FUNNEL_STEPS[0])?.size || 0;
    let prevCount = firstCount;

    const steps = FUNNEL_STEPS.map((step, idx) => {
      const count = actorsByStep.get(step)?.size || 0;
      const conversionFromPrev = idx === 0 ? 1 : (prevCount > 0 ? count / prevCount : 0);
      const conversionFromStart = firstCount > 0 ? count / firstCount : 0;
      prevCount = count;
      return {
        step,
        count,
        conversionFromPrev,
        conversionFromStart,
      };
    });

    return res.json({
      success: true,
      data: {
        windowDays: days,
        from,
        steps,
      },
    });
  } catch (err) {
    return next(err);
  }
};

exports.revenueInsights = async (req, res, next) => {
  try {
    const days = parseDays(req.query.days, 30);
    const from = rangeStart(days);
    const windowStartDay = startOfUtcDay(from);
    const todayUtc = startOfUtcDay(new Date());
    const msPerDay = 24 * 60 * 60 * 1000;

    const activeStatuses = ['trialing', 'active', 'past_due'];
    const txSuccessEventTypes = ['purchase', 'trial_converted', 'upgrade'];

    const [
      activeSubsRows,
      activeAtStartRows,
      canceledSubsCount,
      newProWindowCount,
      renewalRows,
      failedRows,
      txByPlanRows,
      paywallRows,
      newUsersRows,
      purchaseRows,
      billingTrendRows,
      paywallViewActorsRows,
      checkoutStartActorsRows,
      purchaseSuccessActorsRows,
    ] = await Promise.all([
      UserSubscription.aggregate([
        { $match: { isPro: true, status: { $in: activeStatuses } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            mrr: {
              $sum: {
                $switch: {
                  branches: [
                    {
                      case: { $eq: ['$plan.interval', 'month'] },
                      then: { $ifNull: ['$plan.amount', 0] },
                    },
                    {
                      case: { $eq: ['$plan.interval', 'year'] },
                      then: { $divide: [{ $ifNull: ['$plan.amount', 0] }, 12] },
                    },
                    {
                      case: { $eq: ['$plan.interval', 'week'] },
                      then: { $multiply: [{ $ifNull: ['$plan.amount', 0] }, 52 / 12] },
                    },
                    {
                      case: { $eq: ['$plan.interval', 'day'] },
                      then: { $multiply: [{ $ifNull: ['$plan.amount', 0] }, 365 / 12] },
                    },
                  ],
                  default: 0,
                },
              },
            },
          },
        },
      ]),
      UserSubscription.aggregate([
        {
          $match: {
            isPro: true,
            startedAt: { $lte: from },
            $or: [{ canceledAt: null }, { canceledAt: { $gt: from } }],
          },
        },
        { $count: 'total' },
      ]),
      UserSubscription.countDocuments({
        canceledAt: { $gte: from },
      }),
      UserSubscription.countDocuments({
        startedAt: { $gte: from },
        isPro: true,
      }),
      BillingTransaction.aggregate([
        {
          $match: {
            occurredAt: { $gte: from },
            eventType: 'renewal',
            status: 'succeeded',
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            gross: { $sum: { $ifNull: ['$amount.gross', 0] } },
          },
        },
      ]),
      BillingTransaction.aggregate([
        {
          $match: {
            occurredAt: { $gte: from },
            eventType: 'failed_payment',
          },
        },
        { $group: { _id: null, count: { $sum: 1 } } },
      ]),
      BillingTransaction.aggregate([
        {
          $match: {
            occurredAt: { $gte: from },
            status: 'succeeded',
            eventType: { $in: txSuccessEventTypes },
          },
        },
        {
          $group: {
            _id: {
              planId: { $ifNull: ['$plan.planId', 'unknown'] },
              planName: { $ifNull: ['$plan.planName', 'Unknown plan'] },
              interval: { $ifNull: ['$plan.interval', 'unknown'] },
            },
            purchases: { $sum: 1 },
            revenue: { $sum: { $ifNull: ['$amount.gross', 0] } },
            users: { $addToSet: '$userId' },
          },
        },
        {
          $project: {
            _id: 0,
            planId: '$_id.planId',
            planName: '$_id.planName',
            interval: '$_id.interval',
            purchases: 1,
            uniqueBuyers: { $size: '$users' },
            revenue: 1,
          },
        },
        { $sort: { revenue: -1, purchases: -1 } },
      ]),
      AnalyticsEvent.aggregate([
        { $match: { occurredAt: { $gte: from }, event: 'purchase_success' } },
        {
          $group: {
            _id: {
              paywallId: { $ifNull: ['$metadata.paywall_id', 'unknown'] },
              placement: { $ifNull: ['$metadata.entry_point', 'unknown'] },
              variant: { $ifNull: ['$metadata.ab_variant', 'unknown'] },
            },
            purchases: { $sum: 1 },
            actors: {
              $addToSet: {
                $ifNull: [
                  { $concat: ['u:', { $toString: '$userId' }] },
                  { $concat: ['s:', '$sessionId'] },
                ],
              },
            },
          },
        },
        {
          $project: {
            _id: 0,
            paywallId: '$_id.paywallId',
            placement: '$_id.placement',
            variant: '$_id.variant',
            purchases: 1,
            uniqueActors: {
              $size: {
                $filter: {
                  input: '$actors',
                  as: 'a',
                  cond: { $ne: ['$$a', null] },
                },
              },
            },
          },
        },
        { $sort: { purchases: -1 } },
      ]),
      User.find({ createdAt: { $gte: windowStartDay } }, { _id: 1, createdAt: 1 }).lean(),
      BillingTransaction.find(
        {
          occurredAt: { $gte: windowStartDay },
          status: 'succeeded',
          eventType: { $in: txSuccessEventTypes },
          userId: { $ne: null },
        },
        { userId: 1, occurredAt: 1 }
      ).sort({ occurredAt: 1 }).lean(),
      BillingTransaction.aggregate([
        {
          $match: {
            occurredAt: { $gte: from },
            eventType: { $in: ['renewal', 'failed_payment'] },
          },
        },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt', timezone: 'UTC' } },
              type: '$eventType',
            },
            count: { $sum: 1 },
          },
        },
      ]),
      AnalyticsEvent.aggregate([
        { $match: { occurredAt: { $gte: from }, event: 'paywall_view' } },
        {
          $group: {
            _id: {
              $ifNull: [
                { $concat: ['u:', { $toString: '$userId' }] },
                { $concat: ['s:', '$sessionId'] },
              ],
            },
          },
        },
        { $count: 'total' },
      ]),
      AnalyticsEvent.aggregate([
        { $match: { occurredAt: { $gte: from }, event: 'checkout_start' } },
        {
          $group: {
            _id: {
              $ifNull: [
                { $concat: ['u:', { $toString: '$userId' }] },
                { $concat: ['s:', '$sessionId'] },
              ],
            },
          },
        },
        { $count: 'total' },
      ]),
      AnalyticsEvent.aggregate([
        { $match: { occurredAt: { $gte: from }, event: 'purchase_success' } },
        {
          $group: {
            _id: {
              $ifNull: [
                { $concat: ['u:', { $toString: '$userId' }] },
                { $concat: ['s:', '$sessionId'] },
              ],
            },
          },
        },
        { $count: 'total' },
      ]),
    ]);

    const activeSummary = activeSubsRows?.[0] || {};
    const activeProUsers = asNumber(activeSummary.total);
    const mrr = toMoney(activeSummary.mrr);
    const arr = toMoney(mrr * 12);
    const activeAtStart = asNumber(activeAtStartRows?.[0]?.total);
    const churned = asNumber(canceledSubsCount);
    const newProWindow = asNumber(newProWindowCount);
    const churnRate = activeAtStart > 0 ? churned / activeAtStart : 0;
    const renewalsCount = asNumber(renewalRows?.[0]?.count);
    const renewalsGross = toMoney(renewalRows?.[0]?.gross);
    const failedPayments = asNumber(failedRows?.[0]?.count);

    const cohortBuckets = { week1: 0, week2: 0, week4: 0 };
    const firstPurchaseByUser = new Map();
    for (const tx of purchaseRows || []) {
      const uid = String(tx?.userId || '');
      if (!uid || firstPurchaseByUser.has(uid)) continue;
      firstPurchaseByUser.set(uid, new Date(tx.occurredAt));
    }
    for (const user of newUsersRows || []) {
      const uid = String(user?._id || '');
      const created = new Date(user?.createdAt);
      const firstPurchase = firstPurchaseByUser.get(uid);
      if (!firstPurchase || !Number.isFinite(created.getTime())) continue;
      const diffDays = (firstPurchase.getTime() - created.getTime()) / msPerDay;
      if (diffDays <= 7) cohortBuckets.week1 += 1;
      if (diffDays <= 14) cohortBuckets.week2 += 1;
      if (diffDays <= 28) cohortBuckets.week4 += 1;
    }
    const newUsersCount = (newUsersRows || []).length;
    const cohorts = {
      newUsers: newUsersCount,
      paidInWeek1: cohortBuckets.week1,
      paidInWeek2: cohortBuckets.week2,
      paidInWeek4: cohortBuckets.week4,
      conversionWeek1: newUsersCount > 0 ? cohortBuckets.week1 / newUsersCount : 0,
      conversionWeek2: newUsersCount > 0 ? cohortBuckets.week2 / newUsersCount : 0,
      conversionWeek4: newUsersCount > 0 ? cohortBuckets.week4 / newUsersCount : 0,
    };

    const billingMap = new Map();
    for (let cursor = new Date(windowStartDay); cursor <= todayUtc; cursor = new Date(cursor.getTime() + msPerDay)) {
      const k = cursor.toISOString().slice(0, 10);
      billingMap.set(k, { date: k, renewals: 0, failedPayments: 0 });
    }
    for (const row of billingTrendRows || []) {
      const date = String(row?._id?.date || '');
      const type = String(row?._id?.type || '');
      const count = asNumber(row?.count);
      const current = billingMap.get(date);
      if (!current) continue;
      if (type === 'renewal') current.renewals = count;
      if (type === 'failed_payment') current.failedPayments = count;
      billingMap.set(date, current);
    }

    const paywallActors = asNumber(paywallViewActorsRows?.[0]?.total);
    const checkoutActors = asNumber(checkoutStartActorsRows?.[0]?.total);
    const purchaseActors = asNumber(purchaseSuccessActorsRows?.[0]?.total);

    const netGrowthRateWindow = activeAtStart > 0 ? (newProWindow - churned) / activeAtStart : 0;
    const monthlyGrowthRate = Math.max(-0.9, Math.min(0.9, netGrowthRateWindow * (30 / Math.max(days, 1))));
    const forecastMonths = [1, 3, 6, 12];
    const forecast = forecastMonths.map((months) => {
      const factor = Math.pow(1 + monthlyGrowthRate, months);
      const projectedMrr = toMoney(Math.max(0, mrr * factor));
      return {
        months,
        projectedMrr,
        projectedArr: toMoney(projectedMrr * 12),
      };
    });

    return res.json({
      success: true,
      data: {
        windowDays: days,
        from,
        metrics: {
          mrr,
          arr,
          churnRate,
          renewalsCount,
          renewalsGross,
          failedPayments,
          activeProUsers,
        },
        conversionsByPaywall: paywallRows || [],
        planConversion: (txByPlanRows || []).map((row) => ({
          ...row,
          revenue: toMoney(row.revenue),
        })),
        cohorts,
        billingHealthTimeline: Array.from(billingMap.values()),
        paymentFunnel: {
          paywallView: paywallActors,
          checkoutStart: checkoutActors,
          purchaseSuccess: purchaseActors,
          checkoutFromPaywallRate: paywallActors > 0 ? checkoutActors / paywallActors : 0,
          purchaseFromCheckoutRate: checkoutActors > 0 ? purchaseActors / checkoutActors : 0,
          purchaseFromPaywallRate: paywallActors > 0 ? purchaseActors / paywallActors : 0,
        },
        forecast: {
          windowDays: days,
          monthlyGrowthRate,
          points: forecast,
        },
      },
    });
  } catch (err) {
    return next(err);
  }
};

exports.screenDropoff = async (req, res, next) => {
  try {
    const days = parseDays(req.query.days, 30);
    const from = rangeStart(days);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const rows = await AnalyticsEvent.aggregate([
      { $match: { occurredAt: { $gte: from }, event: 'screen_view', pathname: { $ne: null } } },
      { $group: { _id: '$pathname', views: { $sum: 1 }, uniqueUsers: { $addToSet: '$userId' }, uniqueSessions: { $addToSet: '$sessionId' } } },
      {
        $project: {
          _id: 0,
          pathname: '$_id',
          views: 1,
          uniqueUsers: {
            $size: {
              $filter: {
                input: '$uniqueUsers',
                as: 'u',
                cond: { $ne: ['$$u', null] },
              },
            },
          },
          uniqueSessions: {
            $size: {
              $filter: {
                input: '$uniqueSessions',
                as: 's',
                cond: { $ne: ['$$s', null] },
              },
            },
          },
        },
      },
      { $sort: { views: -1 } },
      { $limit: limit },
    ]);

    return res.json({
      success: true,
      data: {
        windowDays: days,
        from,
        rows,
      },
    });
  } catch (err) {
    return next(err);
  }
};

exports.usersInsights = async (req, res, next) => {
  try {
    const days = parseDays(req.query.days, 30);
    const from = rangeStart(days);
    const fromDay = startOfUtcDay(from);
    const todayUtc = startOfUtcDay(new Date());

    const [totalUsers, newUsersWindow, onboardingCompletedUsers, googleLinkedUsers, passwordUsers, bothMethodsUsers, totalEventsWindow, activeUsersWindowRows, topUserScreens, proUsersAllRows, proUsersWindowRows, signupStarted, signupCompleted, itineraryCreated, cityAdded, activityAdded, usersBeforeWindow, dailyUserSignups, dailyLandingViewed] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ createdAt: { $gte: from } }),
      User.countDocuments({ onboardingCompleted: true }),
      User.countDocuments({ 'providers.provider': 'google' }),
      User.countDocuments({ passwordHash: { $exists: true, $nin: ['', null] } }),
      User.countDocuments({ 'providers.provider': 'google', passwordHash: { $exists: true, $nin: ['', null] } }),
      AnalyticsEvent.countDocuments({ occurredAt: { $gte: from } }),
      AnalyticsEvent.aggregate([
        { $match: { occurredAt: { $gte: from }, userId: { $ne: null } } },
        { $group: { _id: '$userId' } },
        { $count: 'total' },
      ]),
      AnalyticsEvent.aggregate([
        { $match: { occurredAt: { $gte: from }, event: 'screen_view', pathname: { $ne: null }, userId: { $ne: null } } },
        { $group: { _id: '$pathname', views: { $sum: 1 }, uniqueUsers: { $addToSet: '$userId' } } },
        {
          $project: {
            _id: 0,
            pathname: '$_id',
            views: 1,
            uniqueUsers: { $size: '$uniqueUsers' },
          },
        },
        { $sort: { views: -1 } },
        { $limit: 8 },
      ]),
      AnalyticsEvent.aggregate([
        { $match: { event: 'purchase_success', userId: { $ne: null } } },
        { $group: { _id: '$userId' } },
        { $count: 'total' },
      ]),
      AnalyticsEvent.aggregate([
        { $match: { event: 'purchase_success', occurredAt: { $gte: from }, userId: { $ne: null } } },
        { $group: { _id: '$userId' } },
        { $count: 'total' },
      ]),
      uniqueActorCountByEvent('signup_started', from),
      uniqueActorCountByEvent('signup_completed', from),
      uniqueActorCountByEvent('itinerary_created', from),
      uniqueActorCountByEvent('city_added', from),
      uniqueActorCountByEvent('activity_added', from),
      User.countDocuments({ createdAt: { $lt: fromDay } }),
      User.aggregate([
        { $match: { createdAt: { $gte: fromDay } } },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' },
            },
            newUsers: { $sum: 1 },
          },
        },
        { $project: { _id: 0, date: '$_id', newUsers: 1 } },
        { $sort: { date: 1 } },
      ]),
      AnalyticsEvent.aggregate([
        { $match: { occurredAt: { $gte: fromDay }, event: 'landing_viewed' } },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt', timezone: 'UTC' } },
            },
            landingViews: { $sum: 1 },
            uniqueActors: {
              $addToSet: {
                $ifNull: [
                  { $concat: ['u:', { $toString: '$userId' }] },
                  { $concat: ['s:', '$sessionId'] },
                ],
              },
            },
          },
        },
        {
          $project: {
            _id: 0,
            date: '$_id.date',
            landingViews: 1,
            uniqueActors: {
              $size: {
                $filter: {
                  input: '$uniqueActors',
                  as: 'a',
                  cond: { $ne: ['$$a', null] },
                },
              },
            },
          },
        },
        { $sort: { date: 1 } },
      ]),
    ]);

    const activeUsersWindow = Number(activeUsersWindowRows?.[0]?.total || 0);
    const proUsersAllTime = Number(proUsersAllRows?.[0]?.total || 0);
    const proUsersWindow = Number(proUsersWindowRows?.[0]?.total || 0);
    const onboardingCompletionRate = totalUsers > 0 ? onboardingCompletedUsers / totalUsers : 0;
    const proRateAllTime = totalUsers > 0 ? proUsersAllTime / totalUsers : 0;
    const signupCompletionRate = signupStarted > 0 ? signupCompleted / signupStarted : 0;
    const activationRateFromSignupCompleted = signupCompleted > 0 ? activityAdded / signupCompleted : 0;
    const emailOnlyUsers = Math.max(passwordUsers - bothMethodsUsers, 0);
    const googleOnlyUsers = Math.max(googleLinkedUsers - bothMethodsUsers, 0);
    const avgEventsPerActiveUserWindow = activeUsersWindow > 0 ? totalEventsWindow / activeUsersWindow : 0;
    const dailySignupsMap = new Map(
      (dailyUserSignups || []).map((row) => [String(row.date), Number(row.newUsers || 0)])
    );
    const timeline = [];
    let cumulativeUsers = Number(usersBeforeWindow || 0);
    for (let cursor = new Date(fromDay); cursor <= todayUtc; cursor = new Date(cursor.getTime() + 86400000)) {
      const key = cursor.toISOString().slice(0, 10);
      const newUsers = Number(dailySignupsMap.get(key) || 0);
      cumulativeUsers += newUsers;
      timeline.push({
        date: key,
        newUsers,
        totalUsers: cumulativeUsers,
      });
    }

    const dailyTrafficMap = new Map(
      (dailyLandingViewed || []).map((row) => [
        String(row.date),
        {
          landingViews: Number(row.landingViews || 0),
          uniqueActors: Number(row.uniqueActors || 0),
        },
      ])
    );
    const trafficTimeline = [];
    let totalLandingViewsWindow = 0;
    for (let cursor = new Date(fromDay); cursor <= todayUtc; cursor = new Date(cursor.getTime() + 86400000)) {
      const key = cursor.toISOString().slice(0, 10);
      const point = dailyTrafficMap.get(key) || { landingViews: 0, uniqueActors: 0 };
      totalLandingViewsWindow += point.landingViews;
      trafficTimeline.push({
        date: key,
        landingViews: point.landingViews,
        uniqueActors: point.uniqueActors,
      });
    }

    return res.json({
      success: true,
      data: {
        windowDays: days,
        from,
        summary: {
          totalUsers,
          newUsersWindow,
          activeUsersWindow,
          onboardingCompletedUsers,
          onboardingCompletionRate,
        },
        authMix: {
          googleOnlyUsers,
          emailOnlyUsers,
          bothMethodsUsers,
        },
        activation: {
          signupStarted,
          signupCompleted,
          itineraryCreated,
          cityAdded,
          activityAdded,
          signupCompletionRate,
          activationRateFromSignupCompleted,
        },
        pro: {
          proUsersAllTime,
          proUsersWindow,
          proRateAllTime,
        },
        engagement: {
          totalEventsWindow,
          avgEventsPerActiveUserWindow,
          topUserScreens,
        },
        growth: {
          timeline,
        },
        traffic: {
          totalLandingViewsWindow,
          timeline: trafficTimeline,
        },
      },
    });
  } catch (err) {
    return next(err);
  }
};

exports.contentInsights = async (req, res, next) => {
  try {
    const days = parseDays(req.query.days, 30);
    const fromDay = startOfUtcDay(rangeStart(days));
    const todayUtc = startOfUtcDay(new Date());

    const [
      totalActivities,
      totalZones,
      dailyActivities,
      dailyZones,
      activitiesBeforeWindow,
      zonesBeforeWindow,
    ] = await Promise.all([
      Activity.countDocuments({}),
      Zone.countDocuments({}),
      Activity.aggregate([
        { $match: { createdAt: { $gte: fromDay } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      Zone.aggregate([
        { $match: { createdAt: { $gte: fromDay } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      Activity.countDocuments({ createdAt: { $lt: fromDay } }),
      Zone.countDocuments({ createdAt: { $lt: fromDay } }),
    ]);

    const activitiesMap = new Map(dailyActivities.map((r) => [r._id, r.count]));
    const zonesMap = new Map(dailyZones.map((r) => [r._id, r.count]));

    const activitiesTimeline = [];
    const zonesTimeline = [];
    let cumulativeActivities = activitiesBeforeWindow;
    let cumulativeZones = zonesBeforeWindow;

    for (let cursor = new Date(fromDay); cursor <= todayUtc; cursor = new Date(cursor.getTime() + 86_400_000)) {
      const key = cursor.toISOString().slice(0, 10);
      const newActivities = Number(activitiesMap.get(key) || 0);
      const newZones = Number(zonesMap.get(key) || 0);
      cumulativeActivities += newActivities;
      cumulativeZones += newZones;
      activitiesTimeline.push({ date: key, newActivities, totalActivities: cumulativeActivities });
      zonesTimeline.push({ date: key, newZones, totalZones: cumulativeZones });
    }

    return res.json({
      success: true,
      data: {
        windowDays: days,
        from: fromDay.toISOString().slice(0, 10),
        activities: {
          total: totalActivities,
          newInWindow: dailyActivities.reduce((s, r) => s + r.count, 0),
          timeline: activitiesTimeline,
        },
        zones: {
          total: totalZones,
          newInWindow: dailyZones.reduce((s, r) => s + r.count, 0),
          timeline: zonesTimeline,
        },
      },
    });
  } catch (err) {
    return next(err);
  }
};
