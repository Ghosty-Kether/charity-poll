/**
 * In-memory data store with JSON persistence.
 * The public interface (methods below) is the only thing server.js touches —
 * swap the backing store for SQLite by replacing the internals without
 * changing any callers.
 */

const fs   = require('fs');
const config = require('./config');

// ── helpers ─────────────────────────────────────────────────────────────────

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ── seed data ────────────────────────────────────────────────────────────────

function makeSeedQuestions() {
  return [
    {
      id: genId(),
      title: 'Which cause should receive the largest share of tonight\'s donations?',
      options: ['Food Bank & Nutrition', 'Emergency Shelter', 'Mental Health Support', 'Youth Education'],
      votes: { 'Food Bank & Nutrition': 0, 'Emergency Shelter': 0, 'Mental Health Support': 0, 'Youth Education': 0 },
      clientVotes: {}, fingerprintVotes: {},
      locked: false,
    },
    {
      id: genId(),
      title: 'How did you first hear about our charity?',
      options: ['Friend or Family', 'Social Media', 'Local News', 'I\'ve Volunteered Before'],
      votes: { 'Friend or Family': 0, 'Social Media': 0, 'Local News': 0, 'I\'ve Volunteered Before': 0 },
      clientVotes: {}, fingerprintVotes: {},
      locked: false,
    },
    {
      id: genId(),
      title: 'Which initiative are you most excited to support this year?',
      options: ['Community Kitchen', 'After-School Programs', 'Crisis Hotline', 'Clean Water Project', 'Winter Warmth Drive'],
      votes: { 'Community Kitchen': 0, 'After-School Programs': 0, 'Crisis Hotline': 0, 'Clean Water Project': 0, 'Winter Warmth Drive': 0 },
      clientVotes: {}, fingerprintVotes: {},
      locked: false,
    },
  ];
}

// ── store ────────────────────────────────────────────────────────────────────

class Store {
  constructor() {
    this._participants = new Set();
    this._load();
  }

  // ── persistence ────────────────────────────────────────────────────────────

  _load() {
    try {
      const raw = fs.readFileSync(config.session.persistPath, 'utf8');
      this.session = JSON.parse(raw);
      // Ensure every question has vote maps (backwards-compat)
      for (const q of this.session.questions) {
        q.clientVotes      = q.clientVotes      || {};
        q.fingerprintVotes = q.fingerprintVotes || {};
      }
      console.log(`Session loaded from ${config.session.persistPath} (room: ${this.session.roomCode})`);
    } catch {
      this.session = {
        roomCode:        genRoomCode(),
        activeQuestionId: null,
        questions:       makeSeedQuestions(),
      };
      this._save();
      console.log(`New session created (room: ${this.session.roomCode})`);
    }
  }

  _save() {
    try {
      fs.writeFileSync(config.session.persistPath, JSON.stringify(this.session, null, 2));
    } catch (err) {
      console.error('Session save failed:', err.message);
    }
  }

  // ── read helpers ───────────────────────────────────────────────────────────

  getSession() { return this.session; }

  getQuestion(id) {
    return this.session.questions.find(q => q.id === id) || null;
  }

  getActiveQuestion() {
    return this.getQuestion(this.session.activeQuestionId);
  }

  /** State sent to all connected clients (no clientVotes map). */
  getPublicState() {
    const { roomCode, activeQuestionId, questions } = this.session;
    return {
      roomCode,
      activeQuestionId,
      questions: questions.map(q => this._toPublic(q)),
    };
  }

  /** Extended state sent only to admin sockets. */
  getFullState() {
    const pub = this.getPublicState();
    return {
      ...pub,
      questions: this.session.questions.map(q => ({
        ...this._toPublic(q),
        // Prefer fingerprint count (more reliable) with clientId as fallback
        voterCount: Math.max(
          Object.keys(q.fingerprintVotes || {}).length,
          Object.keys(q.clientVotes).length
        ),
      })),
    };
  }

  _toPublic(q) {
    return {
      id:         q.id,
      title:      q.title,
      options:    q.options,
      votes:      q.votes,
      totalVotes: Object.values(q.votes).reduce((a, b) => a + b, 0),
      locked:     q.locked,
    };
  }

  // ── participants ───────────────────────────────────────────────────────────

  addParticipant(socketId)    { this._participants.add(socketId); }
  removeParticipant(socketId) { this._participants.delete(socketId); }
  getParticipantCount()       { return this._participants.size; }

  // ── voting ─────────────────────────────────────────────────────────────────

  vote(questionId, optionIndex, clientId, fingerprint) {
    const q = this.getQuestion(questionId);
    if (!q)                                           return { success: false, error: 'Question not found' };
    if (this.session.activeQuestionId !== questionId) return { success: false, error: 'Question is not active' };
    if (q.locked)                                     return { success: false, error: 'Voting is locked' };
    if (optionIndex < 0 || optionIndex >= q.options.length)
                                                      return { success: false, error: 'Invalid option' };

    // Resolve the device's existing vote — fingerprint is the primary key,
    // clientId (localStorage) is the fallback for browsers that block canvas.
    const fpIdx  = fingerprint ? (q.fingerprintVotes[fingerprint] ?? undefined) : undefined;
    const cidIdx = q.clientVotes[clientId];
    const prevIdx = fpIdx !== undefined ? fpIdx : cidIdx;

    if (prevIdx !== undefined) {
      // Changing an existing vote — decrement old option
      const prevOpt = q.options[prevIdx];
      q.votes[prevOpt] = Math.max(0, (q.votes[prevOpt] || 0) - 1);
    }

    const newOpt = q.options[optionIndex];
    q.votes[newOpt] = (q.votes[newOpt] || 0) + 1;

    // Record under both identities so either lookup works later
    q.clientVotes[clientId] = optionIndex;
    if (fingerprint) q.fingerprintVotes[fingerprint] = optionIndex;

    this._save();

    return {
      success:    true,
      votes:      q.votes,
      totalVotes: Object.values(q.votes).reduce((a, b) => a + b, 0),
    };
  }

  getClientVotes(clientId, fingerprint) {
    const result = {};
    for (const q of this.session.questions) {
      // Fingerprint wins; fall back to clientId
      const fpIdx  = fingerprint ? (q.fingerprintVotes?.[fingerprint] ?? undefined) : undefined;
      const cidIdx = q.clientVotes[clientId];
      const idx    = fpIdx !== undefined ? fpIdx : cidIdx;
      if (idx !== undefined) result[q.id] = idx;
    }
    return result;
  }

  // ── question navigation ────────────────────────────────────────────────────

  activateQuestion(questionId) {
    const q = this.getQuestion(questionId);
    if (!q) return { success: false };
    this.session.activeQuestionId = questionId;
    this._save();
    return { success: true, question: this._toPublic(q) };
  }

  deactivateQuestion() {
    this.session.activeQuestionId = null;
    this._save();
    return { success: true };
  }

  nextQuestion() {
    const { questions, activeQuestionId } = this.session;
    if (!questions.length) return { success: false };
    const idx = activeQuestionId ? questions.findIndex(q => q.id === activeQuestionId) : -1;
    if (idx + 1 >= questions.length) return { success: false, reason: 'last' };
    return this.activateQuestion(questions[idx + 1].id);
  }

  prevQuestion() {
    const { questions, activeQuestionId } = this.session;
    if (!questions.length) return { success: false };
    const idx = activeQuestionId ? questions.findIndex(q => q.id === activeQuestionId) : questions.length;
    if (idx - 1 < 0) return { success: false, reason: 'first' };
    return this.activateQuestion(questions[idx - 1].id);
  }

  // ── question management ────────────────────────────────────────────────────

  resetVotes(questionId) {
    const q = this.getQuestion(questionId);
    if (!q) return { success: false };
    for (const opt of q.options) q.votes[opt] = 0;
    q.clientVotes      = {};
    q.fingerprintVotes = {};
    this._save();
    return { success: true, votes: q.votes };
  }

  addQuestion(title, options) {
    const q = {
      id:               genId(),
      title,
      options,
      votes:            Object.fromEntries(options.map(o => [o, 0])),
      clientVotes:      {},
      fingerprintVotes: {},
      locked:           false,
    };
    this.session.questions.push(q);
    this._save();
    return this._toPublic(q);
  }

  updateQuestion(id, title, options) {
    const q = this.getQuestion(id);
    if (!q) return { success: false };

    // Carry over vote counts for options that still exist by name
    const newVotes = Object.fromEntries(options.map(o => [o, q.votes[o] || 0]));

    // Prune clientVotes whose selected index no longer maps to the same option
    const newClientVotes = {};
    for (const [cid, optIdx] of Object.entries(q.clientVotes)) {
      if (optIdx < options.length && q.options[optIdx] === options[optIdx]) {
        newClientVotes[cid] = optIdx;
      }
    }

    q.title       = title;
    q.options     = options;
    q.votes       = newVotes;
    q.clientVotes = newClientVotes;
    this._save();
    return { success: true };
  }

  deleteQuestion(id) {
    const idx = this.session.questions.findIndex(q => q.id === id);
    if (idx === -1) return { success: false };
    this.session.questions.splice(idx, 1);
    if (this.session.activeQuestionId === id) this.session.activeQuestionId = null;
    this._save();
    return { success: true };
  }

  reorderQuestions(ids) {
    const map = new Map(this.session.questions.map(q => [q.id, q]));
    const reordered = ids.map(id => map.get(id)).filter(Boolean);
    // Append any questions not mentioned in ids (safety net)
    for (const q of this.session.questions) {
      if (!ids.includes(q.id)) reordered.push(q);
    }
    this.session.questions = reordered;
    this._save();
    return { success: true };
  }

  setQuestionLocked(questionId, locked) {
    const q = this.getQuestion(questionId);
    if (!q) return { success: false };
    q.locked = locked;
    this._save();
    return { success: true };
  }
}

module.exports = new Store();
