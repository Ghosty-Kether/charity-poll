require('dotenv').config();

const express        = require('express');
const http           = require('http');
const { Server }     = require('socket.io');
const path           = require('path');
const qrcode         = require('qrcode');
const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session        = require('express-session');
const MongoStore     = require('connect-mongo');

const config = require('./config');
const store  = require('./store');

// ── Express + HTTP server ────────────────────────────────────────────────────

const app        = express();
const httpServer = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Session middleware ────────────────────────────────────────────────────────

const sessionMiddleware = session({
  secret:            config.session.secret,
  resave:            false,
  saveUninitialized: false,
  store: config.mongo.uri
    ? MongoStore.create({ mongoUrl: config.mongo.uri, dbName: 'charity-poll', ttl: 7 * 24 * 3600 })
    : undefined,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// ── Google OAuth strategy ─────────────────────────────────────────────────────

if (config.google.clientId) {
  const callbackUrl = config.google.callbackUrl ||
    `${(config.server.baseUrl || 'http://localhost:3000')}/auth/google/callback`;

  passport.use(new GoogleStrategy({
    clientID:     config.google.clientId,
    clientSecret: config.google.clientSecret,
    callbackURL:  callbackUrl,
  }, (_at, _rt, profile, done) => {
    done(null, {
      id:    profile.id,
      name:  profile.displayName,
      email: profile.emails?.[0]?.value  || '',
      photo: profile.photos?.[0]?.value  || '',
    });
  }));
}

passport.serializeUser((user, done)   => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ── Auth routes ───────────────────────────────────────────────────────────────

app.get('/auth/google', (req, res, next) => {
  if (!config.google.clientId) return res.redirect('/join');
  const code = req.query.code || '';
  passport.authenticate('google', { scope: ['profile', 'email'], state: code })(req, res, next);
});

app.get('/auth/google/callback',
  (req, res, next) => {
    if (!config.google.clientId) return res.redirect('/join');
    passport.authenticate('google', { failureRedirect: '/join' })(req, res, next);
  },
  (req, res) => {
    const code = req.query.state || '';
    res.redirect(`/join${code ? `?code=${code}` : ''}`);
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/join'));
});

// ── Page routes ───────────────────────────────────────────────────────────────

app.get('/',        (_req, res) => res.redirect('/admin'));
app.get('/admin',   (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin',   'index.html')));
app.get('/join',    (_req, res) => res.sendFile(path.join(__dirname, 'public', 'join',    'index.html')));
app.get('/present', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'present', 'index.html')));

// ── API routes ────────────────────────────────────────────────────────────────

app.get('/api/me', (req, res) => {
  res.json({
    user:              req.user || null,
    googleAuthEnabled: !!config.google.clientId,
  });
});

app.get('/api/config', (_req, res) => {
  res.json({ event: config.event, roomCode: store.getSession().roomCode });
});

app.get('/api/qr', async (req, res) => {
  const session  = store.getSession();
  const proto    = req.headers['x-forwarded-proto'] || req.protocol;
  const host     = req.headers['x-forwarded-host']  || req.get('host');
  const baseUrl  = (config.server.baseUrl || `${proto}://${host}`).replace(/\/+$/, '');
  const joinUrl  = `${baseUrl}/join?code=${session.roomCode}`;
  try {
    const qrDataUrl = await qrcode.toDataURL(joinUrl, { width: 280, margin: 1, color: { dark: '#000000', light: '#ffffff' } });
    res.json({ qrDataUrl, joinUrl, roomCode: session.roomCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/results/export', (req, res) => {
  const pw = req.query.pw || req.headers['x-admin-password'];
  if (pw !== config.admin.password) return res.status(401).json({ error: 'Unauthorized' });
  const csv      = store.getResultsCSV();
  const date     = new Date().toISOString().split('T')[0];
  const filename = `results-${store.getSession().roomCode}-${date}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────

const io = new Server(httpServer, {
  cors:         { origin: '*' },
  pingTimeout:  60000,
  pingInterval: 25000,
});

// Share express session with socket.io and extract Google user
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, (err) => {
    if (err) return next(err);
    const passportUser = socket.request.session?.passport?.user;
    socket.googleUser  = passportUser || null;
    socket.isAdmin     = socket.handshake.auth?.password === config.admin.password;
    next();
  });
});

io.on('connection', (socket) => {

  store.addParticipant(socket.id);
  io.emit('participant-count', { count: store.getParticipantCount() });

  socket.emit('state', store.getPublicState());

  if (socket.isAdmin) {
    socket.emit('auth-result', { success: true });
    socket.emit('admin-state', store.getFullState());
  } else if (socket.handshake.auth?.password) {
    socket.emit('auth-result', { success: false });
  }

  // ── attendee events ──────────────────────────────────────────────────────

  socket.on('check-votes', ({ clientId, fingerprint }) => {
    if (!clientId) return;
    const googleId = socket.googleUser?.id || null;
    socket.emit('vote-history', {
      votes: store.getClientVotes(clientId, fingerprint || null, googleId),
      user:  socket.googleUser,
    });
  });

  socket.on('vote', ({ questionId, optionIndex, clientId, fingerprint }) => {
    if (!clientId || typeof optionIndex !== 'number') return;
    const googleId = socket.googleUser?.id || null;
    const result   = store.vote(questionId, optionIndex, clientId, fingerprint || null, googleId);
    if (result.success) {
      io.emit('vote-update', { questionId, votes: result.votes, totalVotes: result.totalVotes });
    } else {
      socket.emit('vote-error', { message: result.error, votedIndex: result.votedIndex });
    }
  });

  // ── admin-only events ────────────────────────────────────────────────────

  socket.on('start-presentation', () => {
    if (!socket.isAdmin) return;
    store.startPresentation();
    io.emit('presentation-state', { status: 'active' });
    broadcastAdminState();
  });

  socket.on('end-presentation', () => {
    if (!socket.isAdmin) return;
    store.endPresentation();
    io.emit('presentation-state', { status: 'ended' });
    broadcastAdminState();
  });

  socket.on('activate-question', ({ questionId }) => {
    if (!socket.isAdmin) return;
    const result = store.activateQuestion(questionId);
    if (result.success) {
      io.emit('question-changed', { activeQuestionId: questionId, question: result.question });
      broadcastAdminState();
    }
  });

  socket.on('deactivate-question', () => {
    if (!socket.isAdmin) return;
    store.deactivateQuestion();
    io.emit('question-changed', { activeQuestionId: null, question: null });
    broadcastAdminState();
  });

  socket.on('next-question', () => {
    if (!socket.isAdmin) return;
    const result = store.nextQuestion();
    if (result.success) {
      io.emit('question-changed', { activeQuestionId: store.getSession().activeQuestionId, question: result.question });
      broadcastAdminState();
    }
  });

  socket.on('prev-question', () => {
    if (!socket.isAdmin) return;
    const result = store.prevQuestion();
    if (result.success) {
      io.emit('question-changed', { activeQuestionId: store.getSession().activeQuestionId, question: result.question });
      broadcastAdminState();
    }
  });

  socket.on('reset-votes', ({ questionId }) => {
    if (!socket.isAdmin) return;
    const result = store.resetVotes(questionId);
    if (result.success) {
      io.emit('vote-update', { questionId, votes: result.votes, totalVotes: 0 });
      broadcastAdminState();
    }
  });

  socket.on('add-question', ({ title, options }) => {
    if (!socket.isAdmin) return;
    if (!title || !Array.isArray(options) || options.length < 2) return;
    const clean = options.map(o => String(o).trim()).filter(Boolean);
    if (clean.length < 2) return;
    store.addQuestion(title.trim(), clean);
    broadcastAdminState();
  });

  socket.on('update-question', ({ id, title, options }) => {
    if (!socket.isAdmin) return;
    if (!title || !Array.isArray(options) || options.length < 2) return;
    const clean = options.map(o => String(o).trim()).filter(Boolean);
    if (clean.length < 2) return;
    store.updateQuestion(id, title.trim(), clean);
    io.emit('state', store.getPublicState());
    broadcastAdminState();
  });

  socket.on('delete-question', ({ id }) => {
    if (!socket.isAdmin) return;
    store.deleteQuestion(id);
    io.emit('question-changed', {
      activeQuestionId: store.getSession().activeQuestionId,
      question: store.getActiveQuestion() ? store.getPublicState().questions.find(q => q.id === store.getSession().activeQuestionId) : null,
    });
    broadcastAdminState();
  });

  socket.on('reorder-questions', ({ ids }) => {
    if (!socket.isAdmin) return;
    store.reorderQuestions(ids);
    broadcastAdminState();
  });

  socket.on('lock-question', ({ questionId, locked }) => {
    if (!socket.isAdmin) return;
    store.setQuestionLocked(questionId, locked);
    io.emit('question-locked', { questionId, locked });
    broadcastAdminState();
  });

  socket.on('disconnect', () => {
    store.removeParticipant(socket.id);
    io.emit('participant-count', { count: store.getParticipantCount() });
  });
});

function broadcastAdminState() {
  const state = store.getFullState();
  for (const [, s] of io.sockets.sockets) {
    if (s.isAdmin) s.emit('admin-state', state);
  }
}

// ── start ─────────────────────────────────────────────────────────────────────

const port = config.server.port;
store.ready.then(() => {
  httpServer.listen(port, () => {
    const { roomCode } = store.getSession();
    console.log('');
    console.log('🎉  Charity Poll is running!');
    console.log(`    URL:        http://localhost:${port}`);
    console.log(`    Admin:      http://localhost:${port}/admin   (password: ${config.admin.password})`);
    console.log(`    Join:       http://localhost:${port}/join`);
    console.log(`    Present:    http://localhost:${port}/present`);
    console.log(`    Room code:  ${roomCode}`);
    console.log(`    Google auth: ${config.google.clientId ? 'enabled' : 'disabled (set GOOGLE_CLIENT_ID to enable)'}`);
    console.log('');
  });
}).catch(err => {
  console.error('Failed to initialise store:', err);
  process.exit(1);
});
