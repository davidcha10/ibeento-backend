const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const dotenv = require('dotenv');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { connectDB } = require('./config/db');
const routes = require('./routes');
const errorHandler = require('./middlewares/errorHandler');
const { startSireDailyReportScheduler } = require('./services/sire-daily-report.service');
const { startOrphanActivityCleanupScheduler } = require('./services/activity-orphan-cleanup.service');
const { startTrialReminderScheduler } = require('./services/trial-reminder.service');
const { startDiscoverPreviewPersistentWorker } = require('./controllers/activity.controller');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const isProd = process.env.NODE_ENV === 'production';

if (isProd) {
  // Required when running behind a reverse proxy (Render/Railway/Fly/etc.)
  app.set('trust proxy', 1);
}

const defaultAllowedOrigins = [
  'http://localhost:4200',
  'http://localhost:58078',
  'http://localhost',
  'capacitor://localhost',
  'ionic://localhost',
  'https://ibeento.vercel.app',
  'https://www.ibeento.com',
  'https://ibeento.com',
];

const extraAllowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const allowedOrigins = new Set([...defaultAllowedOrigins, ...extraAllowedOrigins]);

app.use(helmet());
app.use(cors({
  origin(origin, cb) {
    // Allow same-origin/server-side/no-origin requests (curl, mobile webviews, etc.)
    if (!origin) return cb(null, true);
    if (allowedOrigins.has(origin)) return cb(null, true);
    return cb(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true
}));
app.use(express.json({
  verify: (req, _res, buf) => {
    if (req.originalUrl === '/api/billing/stripe/webhook') {
      req.rawBody = buf;
    }
  }
}));
app.use(cookieParser());
app.use(morgan('dev'));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/auth', authLimiter);

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'backend', env: process.env.NODE_ENV || 'development' });
});

app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'backend', env: process.env.NODE_ENV || 'development' });
});

app.use('/api', routes);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;

(async () => {
  await connectDB(process.env.MONGODB_URI);
  startSireDailyReportScheduler();
  startOrphanActivityCleanupScheduler();
  startTrialReminderScheduler();
  startDiscoverPreviewPersistentWorker();
  app.listen(PORT, () => console.log(`🚀 API listening at http://localhost:${PORT}`));
})();
