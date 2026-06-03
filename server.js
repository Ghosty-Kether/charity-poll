require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const qrcode     = require('qrcode');

const config = require('./config');
const store  = require('./store');

// ── Express + HTTP server ────────────────────────────────────────────────────

const app        = express();
const httpServer = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Page routes
app.get('/',        (_req, res) => res.redirect('/admin'));
app.get('/admin',   (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin',   'index.html')));
app.get('/join',    (_req, res) => res.sendFile(path.join(__dirname, 'public', 'join',    'index.html')));
app.get('/present', (_req, res) => res.redirect('/admin'));

// Public event config (no secrets)
app.get('/api/config', (_req, res) => {
  res.json({
    event:    config.event,
    roomCode: store.getSession().roomCode,
  });
});

// QR code image as data-URL + join URL
app.get('/api/qr', async (req, res) => {
  const session  = store.getSession();
  const proto    = req.headers['x-forwarded-proto'] || req.protocol;
  const host     = req.headers['x-forwarded-host']  || req.get('host');
  const baseUrl  = (config.server.baseUrl || `${proto}://${host}`).replace(/\/+$/, '');
  const joinUrl  = `${baseUrl}/join?code=${session.roomCode}`;

  try {
    const qrDataUrl = await qrcode.toDataURL(joinUrl, {
      width:  280,
      margin: 1,
      color:  { dark: '#000000', light: '#ffffff' },
    });
    res.json({ qrDataUrl, joinUrl, roomCode: session.roomCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Socket.IO ────────────────────────────────────────────────────────────────

const io = new Server(httpServer, {
  cors:         { origin: '*' },
  pingTimeout:  60000,
  pingInterval: 25000,
});

// Middleware: stamp each socket with its admin status on every connection/reconnect
io.use((socket, next) => {
  socket.isAdmin = socket.handshake.auth?.password === config.admin.password;
  next();
});

io.on('connection', (socket) => {
  // ── join / leave tracking ──────────────────────────────────────────────────
  store.addParticipant(socket.id);
  io.emit('participant-count', { count: store.getParticipantCount() });

  // ── initial state ─────────────────────────────────────────────────────────
  socket.emit('state', store.getPublicState());

  if (socket.isAdmin) {
    socket.emit('auth-result',  { success: true });
    socket.emit('admin-state',  store.getFullState());
  } else if (socket.handshake.auth?.password) {
    // Attempted but wrong password
    socket.emit('auth-result', { success: false });
  }

  // ── attendee events ───────────────────────────────────────────────────────

  socket.on('check-votes', ({ clientId, fingerprint }) => {
    if (!clientId) return;
    socket.emit('vote-history', { votes: store.getClientVotes(clientId, fingerprint || null) });
  });

  socket.on('vote', ({ questionId, optionIndex, clientId, fingerprint }) => {
    if (!clientId || typeof optionIndex !== 'number') return;
    const result = store.vote(questionId, optionIndex, clientId, fingerprint || null);
    if (result.success) {
      io.emit('vote-update', {
        questionId,
        votes:      result.votes,
        totalVotes: result.totalVotes,
      });
    } else {
      socket.emit('vote-error', { message: result.error });
    }
  });

  // ── admin-only events ─────────────────────────────────────────────────────

  socket.on('activate-question', ({ questionId }) => {
    if (!socket.isAdmin) return;
    const result = store.activateQuestion(questionId);
    if (result.success) {
      io.emit('question-changed', {
        activeQuestionId: questionId,
        question:         result.question,
      });
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
      io.emit('question-changed', {
        activeQuestionId: store.getSession().activeQuestionId,
        question:         result.question,
      });
      broadcastAdminState();
    }
  });

  socket.on('prev-question', () => {
    if (!socket.isAdmin) return;
    const result = store.prevQuestion();
    if (result.success) {
      io.emit('question-changed', {
        activeQuestionId: store.getSession().activeQuestionId,
        question:         result.question,
      });
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
    // Broadcast updated public state so attendees see fresh options
    io.emit('state', store.getPublicState());
    broadcastAdminState();
  });

  socket.on('delete-question', ({ id }) => {
    if (!socket.isAdmin) return;
    store.deleteQuestion(id);
    io.emit('question-changed', {
      activeQuestionId: store.getSession().activeQuestionId,
      question:         store.getActiveQuestion()
                          ? store.getPublicState().questions.find(q => q.id === store.getSession().activeQuestionId)
                          : null,
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

// Send the full admin state to every connected admin socket
function broadcastAdminState() {
  const state = store.getFullState();
  for (const [, s] of io.sockets.sockets) {
    if (s.isAdmin) s.emit('admin-state', state);
  }
}

// ── start ────────────────────────────────────────────────────────────────────
// Wait for store to finish connecting to MongoDB (or loading from file) before
// accepting requests — ensures session data is available on the first request.

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
    console.log('');
  });
}).catch(err => {
  console.error('Failed to initialise store:', err);
  process.exit(1);
});
