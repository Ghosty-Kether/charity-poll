/**
 * Data store with MongoDB persistence (primary) and JSON file fallback.
 * The public interface is unchanged — server.js calls the same methods.
 * Set MONGODB_URI in your env to enable cloud persistence.
 * Falls back to session.json if MONGODB_URI is not set (local dev).
 */

const fs         = require('fs');
const { MongoClient } = require('mongodb');
const config     = require('./config');

// ── helpers ──────────────────────────────────────────────────────────────────

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ── seed data ─────────────────────────────────────────────────────────────────

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

function freshSession() {
  return {
    roomCode:         genRoomCode(),
    activeQuestionId: null,
    questions:        makeSeedQuestions(),
  };
}

// ── store ─────────────────────────────────────────────────────────────────────

class Store {
  constructor() {
    this._participants = new Set();
    this.session       = null;
    this._col          = null; // MongoDB collection, null = file mode
    // Expose a promise so server.js can wait before listening
    this.ready = this._init();
  }

  // ── init / persistence ────────────────────────────────────────────────────

  async _init() {
    const uri = config.mongo && config.mongo.uri;

    if (uri) {
      try {
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
        await client.connect();
        this._col = client.db('charity-poll').collection('session');

        const saved = await this._col.findOne({ _id: 'session' });
        if (saved) {
          delete saved._id;
          this.session = saved;
          for (const q of this.session.questions) {
            q.clientVotes      = q.clientVotes      || {};
            q.fingerprintVotes = q.fingerprintVotes || {};
          }
          console.log(`Session loaded from MongoDB (room: ${this.session.roomCode})`);
        } else {
          this.session = freshSession();
          await this._persist();
          console.log(`New session created in MongoDB (room: ${this.session.roomCode})`);
        }
        return;
      } catch (err) {
        console.error('MongoDB connection failed — falling back to file:', err.message);
        this._col = null;
      }
    }

    // ── file fallback (local dev or no MONGODB_URI) ────────────────────────
    try {
      const raw = fs.readFileSync(config.session.persistPath, 'utf8');
      this.session = JSON.parse(raw);
      for (const q of this.session.questions) {
        q.clientVotes      = q.clientVotes      || {};
        q.fingerprintVotes = q.fingerprintVotes || {};
      }
      console.log(`Session loaded from file (room: ${this.session.roomCode})`);
    } catch {
      this.session = freshSession();
      this._persistToFile();
      console.log(`New session created (room: ${this.session.roomCode})`);
    }
  }

  // Fire-and-forget save — called after every mutation
  _save() {
    if (this._col) {
      this._persist().catch(err => console.error('MongoDB save error:', err.message));
    } else {
      this._persistToFile();
    }
  }

  async _persist() {
    await this._col.replaceOne(
      { _id: 'session' },
      { _id: 'session', ...this.session },
      { upsert: true }
    );
  }

  _persistToFile() {
    try {
      fs.writeFileSync(config.session.persistPath, JSON.stringify(this.session, null, 2));
    } catch (err) {
      console.error('File save failed:', err.message);
    }
  }

  // ── read helpers ───────────────────────────────────────────────────────────

  getSession()        { return this.session; }
  getQuestion(id)     { return this.session.questions.find(q => q.id === id) || null; }
  getActiveQuestion() { return this.getQuestion(this.session.activeQuestionId); }

  getPublicState() {
    const { roomCode, activeQuestionId, questions } = this.session;
    return { roomCode, activeQuestionId, questions: questions.map(q => this._toPublic(q)) };
  }

  getFullState() {
    const pub = this.getPublicState();
    return {
      ...pub,
      questions: this.session.questions.map(q => ({
        ...this._toPublic(q),
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

  addParticipant(id)    { this._participants.add(id); }
  removeParticipant(id) { this._participants.delete(id); }
  getParticipantCount() { return this._participants.size; }

  // ── voting ─────────────────────────────────────────────────────────────────

  vote(questionId, optionIndex, clientId, fingerprint) {
    const q = this.getQuestion(questionId);
    if (!q)                                           return { success: false, error: 'Question not found' };
    if (this.session.activeQuestionId !== questionId) return { success: false, error: 'Question is not active' };
    if (q.locked)                                     return { success: false, error: 'Voting is locked' };
    if (optionIndex < 0 || optionIndex >= q.options.length)
                                                      return { success: false, error: 'Invalid option' };

    const fpIdx  = fingerprint ? (q.fingerprintVotes[fingerprint] ?? undefined) : undefined;
    const cidIdx = q.clientVotes[clientId];
    const prevIdx = fpIdx !== undefined ? fpIdx : cidIdx;

    if (prevIdx !== undefined) {
      const prevOpt = q.options[prevIdx];
      q.votes[prevOpt] = Math.max(0, (q.votes[prevOpt] || 0) - 1);
    }

    const newOpt = q.options[optionIndex];
    q.votes[newOpt] = (q.votes[newOpt] || 0) + 1;

    q.clientVotes[clientId] = optionIndex;
    if (fingerprint) q.fingerprintVotes[fingerprint] = optionIndex;

    this._save();
    return { success: true, votes: q.votes, totalVotes: Object.values(q.votes).reduce((a, b) => a + b, 0) };
  }

  getClientVotes(clientId, fingerprint) {
    const result = {};
    for (const q of this.session.questions) {
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
      id: genId(), title, options,
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
    const newVotes = Object.fromEntries(options.map(o => [o, q.votes[o] || 0]));
    const newClientVotes = {};
    for (const [cid, optIdx] of Object.entries(q.clientVotes)) {
      if (optIdx < options.length && q.options[optIdx] === options[optIdx]) {
        newClientVotes[cid] = optIdx;
      }
    }
    q.title = title; q.options = options; q.votes = newVotes; q.clientVotes = newClientVotes;
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
