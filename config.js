require('dotenv').config();

module.exports = {
  event: {
    name:         process.env.EVENT_NAME        || 'Leaders for Change Oakville',
    tagline:      process.env.EVENT_TAGLINE     || 'Together we make a difference',
    logoUrl:      process.env.LOGO_URL          || '/logo.png',
    primaryColor: process.env.PRIMARY_COLOR     || '#e85d04',
    accentColor:  process.env.ACCENT_COLOR      || '#f48c06',
    bgColor:      process.env.BG_COLOR          || '#fff8f0',
    darkColor:    process.env.DARK_COLOR        || '#2d3250',
  },
  admin: {
    password: process.env.ADMIN_PASSWORD || 'charity2026',
  },
  server: {
    port:    parseInt(process.env.PORT || '3000', 10),
    baseUrl: process.env.BASE_URL || '',
  },
  mongo: {
    uri: process.env.MONGODB_URI || '',
  },
  google: {
    clientId:     process.env.GOOGLE_CLIENT_ID     || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    callbackUrl:  process.env.GOOGLE_CALLBACK_URL  || '',
  },
  session: {
    secret:      process.env.SESSION_SECRET || 'dev-secret-please-change-in-production',
    persistPath: process.env.SESSION_PATH   || './session.json',
  },
};
