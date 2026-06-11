/**
 * Data store — MongoDB primary, JSON file fallback.
 * Added: presentation state, googleVotes (true once-only per account),
 *        startPresentation / endPresentation, getResultsCSV, results snapshot.
 */

const fs            = require('fs');
const { MongoClient } = require('mongodb');
const config        = require('./config');

// ── helpers ──────────────────────────────────────────────────────────────────

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function makeQuestion(title, options) {
  return {
    id:               genId(),
    title,
    options,
    votes:            Object.fromEntries(options.map(o => [o, 0])),
    clientVotes:      {},
    fingerprintVotes: {},
    googleVotes:      {},
    locked:           false,
  };
}

function makeSeedQuestions() {
  return [
    makeQuestion(
      'Which cause should receive the largest share of tonight\'s donations?',
      ['Food Bank & Nutrition', 'Emergency Shelter', 'Mental Health Support', 'Youth Education']
    ),
    makeQuestion(
      'How did you first hear about our charity?',
      ['Friend or Family', 'Social Media', 'Local News', 'I\'ve Volunteered Before']
    ),
    makeQuestion(
      'Which initiative are you most excited to support this year?',
      ['Community Kitchen', 'After-School Programs', 'Crisis Hotline', 'Clean Water Project', 'Winter Warmth Drive']
    ),
  ];
}

function freshSession() {
  return {
    roomCode:         genRoomCode(),
    activeQuestionId: null,
    presentation:     { status: 'idle', startedAt: null, endedAt: null },
    questions:        makeSeedQuestions(),
  };
}

// ── store ─────────────────────────────────────────────────────────────────────

class Store {
  constructor() {
    this._participants = new Set();
    this.session       = null;
    this._col          = null;
    this._db           = null;
    this.ready         = this._init();
  }

  // ── init / persistence ────────────────────────────────────────────────────

  async _init() {
    const uri = config.mongo?.uri;

    if (uri) {
      try {
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
        await client.connect();
        this._db  = client.db('charity-poll');
        this._col = this._db.collection('session');

        const saved = await this._col.findOne({ _id: 'session' });
        if (saved) {
          delete saved._id;
          this.session = saved;
          this._backfill();
          console.log(`Session loaded from MongoDB (room: ${this.session.roomCode})`);
        } else {
          this.session = freshSession();
          await this._persist();
          console.log(`New session created in MongoDB (room: ${this.session.roomCode})`);
        }
        return;
      } catch (err) {
        console.error('MongoDB connection failed — falling back to file:', err.message);
        this._col = null; this._db = null;
      }
    }

    try {
      const raw = fs.readFileSync(config.session.persistPath, 'utf8');
      this.session = JSON.parse(raw);
      this._backfill();
      console.log(`Session loaded from file (room: ${this.session.roomCode})`);
    } catch {
      this.session = freshSession();
      this._persistToFile();
      console.log(`New session created (room: ${this.session.roomCode})`);
    }
  }

  /** Ensure fields added in later versions exist on older saved sessions. */
  _backfill() {
    if (!this.session.presentation) {
      this.session.presentation = { status: 'idle', startedAt: null, endedAt: null };
    }
    for (const q of this.session.questions) {
      q.clientVotes      = q.clientVotes      || {};
      q.fingerprintVotes = q.fingerprintVotes || {};
      q.googleVotes      = q.googleVotes      || {};
    }
  }

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

  async _saveResultsSnapshot() {
    if (!this._db) return;
    try {
      const col = this._db.collection('results');
      await col.insertOne({
        savedAt:   new Date(),
        roomCode:  this.session.roomCode,
        endedAt:   this.session.presentation.endedAt,
        questions: this.session.questions.map(q => ({
          title:      q.title,
          options:    q.options,
          votes:      q.votes,
          totalVotes: Object.values(q.votes).reduce((a, b) => a + b, 0),
        })),
      });
    } catch (err) {
      console.error('Results snapshot failed:', err.message);
    }
  }

  // ── read helpers ───────────────────────────────────────────────────────────

  getSession()        { return this.session; }
  getQuestion(id)     { return this.session.questions.find(q => q.id === id) || null; }
  getActiveQuestion() { return this.getQuestion(this.session.activeQuestionId); }

  getPublicState() {
    const { roomCode, activeQuestionId, questions, presentation } = this.session;
    return {
      roomCode,
      activeQuestionId,
      presentation: presentation || { status: 'idle' },
      questions: questions.map(q => this._toPublic(q)),
    };
  }

  getFullState() {
    const pub = this.getPublicState();
    return {
      ...pub,
      questions: this.session.questions.map(q => ({
        ...this._toPublic(q),
        voterCount: Math.max(
          Object.keys(q.googleVotes      || {}).length,
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

  // ── presentation ───────────────────────────────────────────────────────────

  startPresentation() {
    this.session.presentation = {
      status:    'active',
      startedAt: new Date().toISOString(),
      endedAt:   null,
    };
    this._save();
    return { success: true };
  }

  endPresentation() {
    this.session.presentation = {
      ...this.session.presentation,
      status:  'ended',
      endedAt: new Date().toISOString(),
    };
    for (const q of this.session.questions) q.locked = true;
    this._save();
    this._saveResultsSnapshot();
    return { success: true };
  }

  // ── voting ─────────────────────────────────────────────────────────────────

  /**
   * Cast a vote. With Google auth, each account gets exactly ONE vote per
   * question — no changing. Without Google auth, fingerprint/clientId is used
   * and the same once-only rule applies.
   */
  vote(questionId, optionIndex, clientId, fingerprint, googleId) {
    const q = this.getQuestion(questionId);
    if (!q)                                           return { success: false, error: 'Question not found' };
    if (this.session.activeQuestionId !== questionId) return { success: false, error: 'Question is not active' };
    if (q.locked)                                     return { success: false, error: 'Voting is locked' };
    if (this.session.presentation?.status !== 'active')
                                                      return { success: false, error: 'Voting is not open yet' };
    if (optionIndex < 0 || optionIndex >= q.options.length)
                                                      return { success: false, error: 'Invalid option' };

    if (googleId) {
      if (q.googleVotes[googleId] !== undefined)
        return { success: false, error: 'already_voted', votedIndex: q.googleVotes[googleId] };
      q.googleVotes[googleId] = optionIndex;
    } else {
      const fpIdx  = fingerprint ? (q.fingerprintVotes[fingerprint] ?? undefined) : undefined;
      const cidIdx = q.clientVotes[clientId];
      if (fpIdx !== undefined || cidIdx !== undefined)
        return { success: false, error: 'already_voted' };
      q.clientVotes[clientId] = optionIndex;
      if (fingerprint) q.fingerprintVotes[fingerprint] = optionIndex;
    }

    q.votes[q.options[optionIndex]] = (q.votes[q.options[optionIndex]] || 0) + 1;
    this._save();

    return {
      success:    true,
      votes:      q.votes,
      totalVotes: Object.values(q.votes).reduce((a, b) => a + b, 0),
    };
  }

  getClientVotes(clientId, fingerprint, googleId) {
    const result = {};
    for (const q of this.session.questions) {
      if (googleId && q.googleVotes[googleId] !== undefined) {
        result[q.id] = q.googleVotes[googleId];
        continue;
      }
      const fpIdx  = fingerprint ? (q.fingerprintVotes?.[fingerprint] ?? undefined) : undefined;
      const cidIdx = q.clientVotes[clientId];
      const idx    = fpIdx !== undefined ? fpIdx : cidIdx;
      if (idx !== undefined) result[q.id] = idx;
    }
    return result;
  }

  // ── results export ─────────────────────────────────────────────────────────

  getResultsCSV() {
    const rows = ['Question,Option,Votes,Percentage'];
    for (const q of this.session.questions) {
      const total = Object.values(q.votes).reduce((a, b) => a + b, 0);
      for (const opt of q.options) {
        const count = q.votes[opt] || 0;
        const pct   = total > 0 ? Math.round(count / total * 100) : 0;
        rows.push(`"${q.title.replace(/"/g,'""')}","${opt.replace(/"/g,'""')}",${count},${pct}%`);
      }
    }
    return rows.join('\n');
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
    q.googleVotes      = {};
    this._save();
    return { success: true, votes: q.votes };
  }

  addQuestion(title, options) {
    const q = makeQuestion(title, options);
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
      if (optIdx < options.length && q.options[optIdx] === options[optIdx]) newClientVotes[cid] = optIdx;
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
